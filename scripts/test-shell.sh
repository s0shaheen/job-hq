#!/usr/bin/env bash
# Run a command inside the prebuilt verification image, against THIS checkout.
#
#   scripts/test-shell.sh                       # interactive shell
#   scripts/test-shell.sh pytest tests/core -q
#   scripts/test-shell.sh scripts/verify.sh --full
#
# What you get: the repo mounted at /repo, Postgres 16 already up with
# DATABASE_URL exported, both Python venvs, node_modules for linux, and the
# Playwright browsers. See infra/test-image/Dockerfile for what that pins.
#
# Two paths are deliberately SHADOWED by container-local volumes:
#
#   webapp/node_modules  the host's is a macOS build; its native binaries cannot
#                        run here, and writing linux ones over it would break the
#                        host's own `npm run dev`.
#   webapp/.next         a build produced in here is not the build the host dev
#                        server should pick up.
#
# Everything else is the real checkout, read-write, so results and any file a
# suite writes land where you can see them.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
img=${HQ_TEST_IMAGE_TAG:-hq-test:latest}

docker image inspect "$img" >/dev/null 2>&1 || {
  cat >&2 <<EOF
The verification image ($img) is not built. Build it once:

    infra/test-image/build.sh

It takes a few minutes and is then reused by every run until one of its six
inputs changes.
EOF
  exit 1
}

# Staleness is a fact, not a guess: the tag carries the hash of the build inputs.
want=$(cat "$repo/infra/test-image/Dockerfile" \
           "$repo/infra/test-image/entrypoint.sh" \
           "$repo/requirements.txt" \
           "$repo/infra/render/requirements.txt" \
           "$repo/webapp/package.json" \
           "$repo/webapp/package-lock.json" | shasum -a 256 | cut -c1-12)
if ! docker image inspect "hq-test:$want" >/dev/null 2>&1; then
  echo "[test-shell] WARNING: image inputs changed (want hq-test:$want)." >&2
  echo "[test-shell] Refresh with infra/test-image/build.sh, or results reflect stale deps." >&2
fi

# Volumes are keyed by the input hash so a refreshed image never inherits the old
# image's node_modules.
vol="hq-test-node-modules-$want"

# `.next` is keyed by the CHECKOUT as well, because its contents belong to one
# branch. Sharing it across worktrees is the same bug the e2e port had: two
# concurrent `--image` runs write each other's generated route types, and the
# loser fails `typecheck` and `e2e-visual` on modules its own tree does not
# contain. It cost two agents a false diagnosis on 2026-08-02 — one reported the
# resulting errors as a "stale checkout artifact", which is exactly what
# cross-contamination looks like from inside. node_modules is safe to share: it
# is a function of the lockfile, which the hash already covers.
checkout_key="$(printf '%s' "$repo" | shasum -a 256 | cut -c1-12)"

# A worktree's .git is a FILE pointing into the parent checkout, so git inside the
# container would fail. Nothing here needs git — scripts/verify.sh resolves the
# changed paths on the host and passes them in through HQ_VERIFY_PATHS.
args=(--rm --init
  -v "$repo:/repo"
  -v "$vol:/repo/webapp/node_modules"
  -v "hq-test-next-$want-$checkout_key:/repo/webapp/.next"
  -w /repo
  -e "HQ_VERIFY_PATHS=${HQ_VERIFY_PATHS:-}"
  -e "HQ_DEMO=${HQ_DEMO:-}"
  -e "HQ_VISUAL=${HQ_VISUAL:-}"
  -e "HQ_E2E_PORT=${HQ_E2E_PORT:-}"
)
[[ -t 0 && -t 1 ]] && args+=(-it)

if [[ $# -eq 0 ]]; then
  exec docker run "${args[@]}" "$img" bash
fi
# One argument that looks like a shell line ("cd webapp && npm test") is run as
# one. Anything else is argv, so a filename with a space still works.
if [[ $# -eq 1 && "$1" == *" "* ]]; then
  exec docker run "${args[@]}" "$img" bash -lc "$1"
fi
exec docker run "${args[@]}" "$img" bash -lc 'exec "$@"' _ "$@"
