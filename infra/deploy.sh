#!/usr/bin/env bash
#
# Build and ship a container image, PINNED TO THE GIT SHA that produced it.
#
#   infra/deploy.sh                     # the scheduled bots (default)
#   infra/deploy.sh render              # the résumé render service
#   infra/deploy.sh [render] --dirty    # emergency: ship uncommitted work as <sha>-dirty
#
# TWO IMAGES, ONE SCRIPT. The render service is a second function with its own image, its own
# repo and its own role (infra/terraform/render.tf explains why it is not just another bot).
# Everything below — the SHA tag, the account check, the linux/amd64 build, the pin-then-verify
# — is identical for both, so the only difference is which Dockerfile, repo and function name
# the three variables below hold. A copied second script would drift on the first fix.
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

EXPECT_ACCOUNT="${HQ_AWS_ACCOUNT:-690340855657}"   # the account this repo's terraform state deploys

TARGET="bots"
DIRTY_OK=0
for arg in "$@"; do
  case "${arg}" in
    bots|render) TARGET="${arg}" ;;
    --dirty) DIRTY_OK=1 ;;
    *) echo "usage: infra/deploy.sh [bots|render] [--dirty]" >&2; exit 2 ;;
  esac
done

# The three things that differ between the two images. Names mirror Terraform exactly
# (${var.project}-bots / ${var.project}-render); a mismatch here pushes a working image into a
# repo nothing reads and reports success.
#
# NOT OVERRIDABLE, and that is the security control. These were `${LAMBDA_FN:-job-hq-render}`
# and `${ECR_REPO:-job-hq-render}`, which means an exported variable BEAT the target the `case`
# above had just chosen: `LAMBDA_FN=job-hq-bots infra/deploy.sh render` built
# infra/render/Dockerfile and then ran `update-function-code --function-name job-hq-bots`, i.e.
# put the renderer of user-authored documents into the role that reads every /job-hq/*
# SecureString, writes the backup bucket and sends mail. That is the exact inversion
# infra/terraform/render.tf exists to prevent, and it was reachable from a stale `export` in a
# shell. `ECR_REPO=job-hq-bots` was the same failure one step earlier: it moves the bots repo's
# `:latest`, which is the tag main.tf reads at function-create time.
#
# The lane is chosen ONCE, by the argument, and nothing downstream can move it. Deploying
# something else is an edit to this case statement, in a commit, in review — which is the
# amount of ceremony "which role does untrusted input run under" deserves. Wrong ACCOUNT is
# still overridable (HQ_AWS_ACCOUNT below): that one is checked out loud before anything ships.
case "${TARGET}" in
  bots)
    DOCKERFILE="infra/Dockerfile"
    ECR_REPO="job-hq-bots"
    FN="job-hq-bots"
    ;;
  render)
    DOCKERFILE="infra/render/Dockerfile"
    ECR_REPO="job-hq-render"
    FN="job-hq-render"
    ;;
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

echo "[deploy] ${TARGET} ${TAG} -> ${ECR} (account ${ACCOUNT}, ${REGION})"

# --- build + push ----------------------------------------------------------------------------
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ECR%/*}"

# --platform linux/amd64: the Lambda is x86_64, and an Apple-silicon default build boots to an
# exec-format error at the first invocation, not at push time.
docker build --platform linux/amd64 -f "${DOCKERFILE}" -t "${ECR}:${TAG}" .
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
