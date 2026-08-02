#!/usr/bin/env bash
# Build (or refresh) the verification image.
#
# The build context is ASSEMBLED, not the repo. Six files decide what is in the
# image; handing Docker the whole checkout would ship 500 MB of macOS
# node_modules and a pile of snapshots to a build that ignores all of it, and
# would make every source edit look like a cache miss.
#
# The tag carries the sha256 of exactly those six inputs, so `hq-test:latest`
# being stale is a detectable fact rather than a guess — scripts/test-shell.sh
# checks it on every run.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)

# The inputs. Adding one here is the ONLY way to make a file invalidate the image.
inputs=(
  "$here/Dockerfile"
  "$here/entrypoint.sh"
  "$repo/requirements.txt"
  "$repo/infra/render/requirements.txt"
  "$repo/webapp/package.json"
  "$repo/webapp/package-lock.json"
)
for f in "${inputs[@]}"; do
  [[ -f "$f" ]] || { echo "missing build input: $f" >&2; exit 1; }
done

tag_hash=$(cat "${inputs[@]}" | shasum -a 256 | cut -c1-12)
echo "inputs hash: $tag_hash"

ctx=$(mktemp -d)
trap 'rm -rf "$ctx"' EXIT
cp "$here/Dockerfile" "$here/entrypoint.sh" "$ctx/"
cp "$repo/requirements.txt" "$ctx/requirements.txt"
cp "$repo/infra/render/requirements.txt" "$ctx/render-requirements.txt"
cp "$repo/webapp/package.json" "$repo/webapp/package-lock.json" "$ctx/"

docker build "$@" -t "hq-test:$tag_hash" -t hq-test:latest "$ctx"

echo
docker run --rm --entrypoint cat hq-test:latest /opt/hq-test-image.manifest
echo
echo "tagged hq-test:$tag_hash and hq-test:latest"
