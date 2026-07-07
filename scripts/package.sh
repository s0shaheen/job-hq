#!/bin/zsh
# Package a tailored application: render the PDF (hard one-page check), generate
# the editable DOCX, name both for sending, log the event.
#
# Usage: scripts/package.sh <slug> ["Company_For_Filename"]
#   Run AFTER cv.yaml has been tailored. Filename company defaults to the slug's
#   first token, capitalized.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SLUG="${1:?usage: package.sh <slug> [Company_For_Filename]}"
COMPANY="${2:-$(echo "${SLUG%%-*}" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')}"
DIR="$REPO/applications/$SLUG"
LOG="$REPO/applications/applications-log.csv"
BASENAME="Salman_Shaheen_Resume_${COMPANY}"

[[ -f "$DIR/cv.yaml" ]] || { echo "No cv.yaml in $DIR — run new-job.sh first"; exit 1; }

# 1. Render PDF (+PNG for the page check) into a temp build dir
BUILD="$DIR/.build"
rm -rf "$BUILD"
rendercv render "$DIR/cv.yaml" --design "$REPO/resume/design.yaml" \
  --output-folder .build --dont-generate-html --dont-generate-markdown >/dev/null

PAGES=$(ls "$BUILD"/*.png | wc -l | tr -d ' ')
if [[ "$PAGES" != "1" ]]; then
  echo "FAIL: rendered $PAGES pages (must be 1). Build kept at $BUILD for inspection."
  exit 1
fi

# 2. Final artifacts
cp "$BUILD"/*.pdf "$DIR/$BASENAME.pdf"
cp "$BUILD"/*_1.png "$DIR/.preview.png"   # for visual wrap/orphan check
rm -rf "$BUILD"
uv run --quiet --with python-docx --with pyyaml \
  "$REPO/scripts/yaml_to_docx.py" "$DIR/cv.yaml" "$DIR/$BASENAME.docx" >/dev/null

# 3. Log
[[ -f "$LOG" ]] || echo "timestamp,slug,event,company,role,url,file" > "$LOG"
echo "$(date +%Y-%m-%dT%H:%M),$SLUG,packaged,\"$COMPANY\",,,$BASENAME.pdf" >> "$LOG"

echo "Packaged: $DIR"
echo "  $BASENAME.pdf (1 page) + $BASENAME.docx"
echo "  Visual check: $DIR/.preview.png"
