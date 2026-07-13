#!/bin/zsh
# Intake a job posting: create the application folder (Drive-synced), capture the
# posting as PDF, seed cv.yaml from base, seed notes.md, log the event.
#
# Usage: scripts/new-job.sh <slug> <job-url> ["Company"] ["Role"]
#   slug: kebab-case folder name, e.g. plaid-pm-core
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SLUG="${1:?usage: new-job.sh <slug> <job-url> [Company] [Role]}"
URL="${2:?missing job url}"
COMPANY="${3:-}"
ROLE="${4:-}"
DIR="$REPO/applications/$SLUG"
LOG="$REPO/applications/applications-log.csv"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

mkdir -p "$DIR"

# 1. Capture the posting as PDF (virtual-time budget lets JS-heavy ATS pages render)
"$CHROME" --headless --disable-gpu --no-pdf-header-footer \
  --virtual-time-budget=10000 \
  --print-to-pdf="$DIR/job-posting.pdf" "$URL" 2>/dev/null \
  || echo "WARN: posting PDF capture failed — save it manually" >&2

# 2. Seed the tailoring inputs
[[ -f "$DIR/cv.yaml" ]] || cp "$REPO/resume/base.yaml" "$DIR/cv.yaml"
if [[ ! -f "$DIR/notes.md" ]]; then
  cat > "$DIR/notes.md" <<EOF
# ${COMPANY:-$SLUG} — ${ROLE:-TBD}

**JD:** $URL (captured: job-posting.pdf, $(date +%Y-%m-%d))
**Archetype:** TBD (classify per CLAUDE.md; check jd-playbook.md)
**Status:** drafting

## Edits from base

- (none yet — cv.yaml is a fresh copy of base)

## Keywords mirrored

## Interview probe risks carried
EOF
fi

# 3. Log (append-only event log; the seam for the Job Monitor sheet later)
[[ -f "$LOG" ]] || echo "timestamp,slug,event,company,role,url,file" > "$LOG"
echo "$(date +%Y-%m-%dT%H:%M),$SLUG,created,\"$COMPANY\",\"$ROLE\",$URL," >> "$LOG"

echo "Created $DIR"
ls "$DIR"
