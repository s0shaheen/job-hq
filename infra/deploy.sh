#!/usr/bin/env bash
#
# Build and ship the bots container image, PINNED TO THE GIT SHA that produced it.
#
#   infra/deploy.sh              # from anywhere in the repo
#   infra/deploy.sh --dirty      # emergency: ship uncommitted work as <sha>-dirty
#
# WHY: the deploy used to be a `:latest` push plus a hand-typed update-function-code. Nothing
# recorded WHICH build was live (`:latest` is mutable — the tag moves under you), so "roll back
# to what ran yesterday" meant rebuilding an old checkout and hoping the result matched. Here
# the tag IS the commit: `aws lambda get-function` names the source, and a rollback is one
# command against an image that already exists in ECR. `:latest` is still pushed, purely as a
# human convenience pointer — nothing deploys from it.
#
# Terraform owns the function but NOT its image_uri (lifecycle.ignore_changes in main.tf), so
# an apply can never silently roll the code back to whatever :latest points at today.
#
# Keep the ${...} braces everywhere: in zsh a bare "$ECR:latest" parses as the `:l` lowercase
# modifier plus "atest", and you push to a repo named job-hq-botsatest.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

ECR_REPO="${ECR_REPO:-job-hq-bots}"          # ECR repository name (terraform: ${var.project}-bots)
FN="${LAMBDA_FN:-job-hq-bots}"               # function name       (terraform: ${var.project}-bots)
EXPECT_ACCOUNT="${HQ_AWS_ACCOUNT:-690340855657}"   # the account this repo's terraform state deploys

DIRTY_OK=0
case "${1:-}" in
  --dirty) DIRTY_OK=1 ;;
  "") ;;
  *) echo "usage: infra/deploy.sh [--dirty]" >&2; exit 2 ;;
esac

# --- what is being shipped -------------------------------------------------------------------
# Tracked-file check only. Untracked paths are normal here (local scratch dirs) and the tag makes
# no promise about them; what it does promise is that every tracked file matches this commit.
SHA="$(git rev-parse --short HEAD)"
TAG="${SHA}"
if ! git diff-index --quiet HEAD --; then
  if [[ "${DIRTY_OK}" != "1" ]]; then
    echo "[deploy] tracked files differ from ${SHA} — commit them, or re-run with --dirty" >&2
    git diff-index --name-only HEAD -- >&2
    exit 1
  fi
  TAG="${SHA}-dirty"                          # a tag that lies is worse than no tag
fi

# --- where it is going -----------------------------------------------------------------------
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
if [[ -z "${REGION}" ]]; then
  echo "[deploy] no region: set AWS_REGION or run 'aws configure'" >&2
  exit 1
fi
# Derived, then checked: a wrong profile would otherwise push a working image into an account
# where nothing runs it, and report success.
if [[ "${ACCOUNT}" != "${EXPECT_ACCOUNT}" ]]; then
  echo "[deploy] credentials are for account ${ACCOUNT}, expected ${EXPECT_ACCOUNT} — wrong" \
       "AWS_PROFILE? (override with HQ_AWS_ACCOUNT=${ACCOUNT})" >&2
  exit 1
fi
ECR="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}"

echo "[deploy] ${TAG} -> ${ECR} (account ${ACCOUNT}, ${REGION})"

# --- build + push ----------------------------------------------------------------------------
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ECR%/*}"

# --platform linux/amd64: the Lambda is x86_64, and an Apple-silicon default build boots to an
# exec-format error at the first invocation, not at push time.
docker build --platform linux/amd64 -f infra/Dockerfile -t "${ECR}:${TAG}" .
docker tag "${ECR}:${TAG}" "${ECR}:latest"
docker push "${ECR}:${TAG}"
docker push "${ECR}:latest"

# --- point the function at THIS build --------------------------------------------------------
if ! aws lambda get-function --region "${REGION}" --function-name "${FN}" >/dev/null 2>&1; then
  # First-run bootstrap order (infra/README.md): the image must exist before terraform can
  # create the function from it. Loud, not silent — and the image is already pushed.
  echo "[deploy] ${FN} does not exist yet — image pushed; run 'terraform apply' in" \
       "infra/terraform to create it, then re-run this script to pin it to ${TAG}"
  exit 0
fi

aws lambda update-function-code --region "${REGION}" --function-name "${FN}" \
  --image-uri "${ECR}:${TAG}" --output text --query 'LastUpdateStatus'
aws lambda wait function-updated --region "${REGION}" --function-name "${FN}"

echo "[deploy] live: ${FN} <- ${ECR}:${TAG}"
echo "[deploy] rollback: aws lambda update-function-code --region ${REGION} --function-name ${FN} --image-uri ${ECR}:<sha>"
echo "[deploy] shipped shas: aws ecr describe-images --region ${REGION} --repository-name ${ECR_REPO} --query 'reverse(sort_by(imageDetails,&imagePushedAt))[:10].imageTags' --output text"
