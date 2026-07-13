#!/bin/zsh
# Render a PARALLEL copy of the BASE resume that differs ONLY by contact email.
#
# base.yaml stays the single source of truth: this swaps the email line at render
# time into a throwaway yaml, so every future edit to base.yaml flows through
# automatically — there is no second content file to keep in sync.
#
# Usage: scripts/render-alt.sh        (or: make alt)
# Output: resume/out-alt/  — PDF + per-page PNG + Salman_Shaheen_Resume.docx
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ALT_EMAIL="salmanshaheen.t@gmail.com"
TMP="$REPO/resume/.alt.cv.yaml"          # transient; gitignored; output resolves relative to its dir
OUT="$REPO/resume/out-alt"
BASENAME="Salman_Shaheen_Resume"
trap 'rm -f "$TMP"' EXIT

# 1. Derive the alt yaml: swap only the email value, everything else verbatim.
sed "s#^\([[:space:]]*email:\).*#\1 $ALT_EMAIL#" "$REPO/resume/base.yaml" > "$TMP"

# 2. Render PDF (+PNG for the one-page check). --output-folder resolves relative
#    to the input yaml's dir (resume/), so this lands in resume/out-alt/.
rm -rf "$OUT"
rendercv render "$TMP" --design "$REPO/resume/design.yaml" \
  --output-folder out-alt --dont-generate-html --dont-generate-markdown >/dev/null

PAGES=$(ls "$OUT"/*.png | wc -l | tr -d ' ')
echo "Pages: $PAGES"
if [[ "$PAGES" != "1" ]]; then
  echo "FAIL: rendered $PAGES pages (must be 1). Output kept at $OUT for inspection."
  exit 1
fi

# 3. Name the PDF/PNG for sending + eyeballing, then the editable DOCX.
cp "$OUT"/*.pdf "$OUT/$BASENAME.pdf"
cp "$OUT"/*_1.png "$OUT/.preview.png"
uv run --quiet --with python-docx --with pyyaml \
  "$REPO/scripts/yaml_to_docx.py" "$TMP" "$OUT/$BASENAME.docx" >/dev/null

echo "Alt-email version ready (email: $ALT_EMAIL):"
echo "  $OUT/$BASENAME.pdf  (1 page) + $BASENAME.docx"
echo "  Visual check: $OUT/.preview.png"
