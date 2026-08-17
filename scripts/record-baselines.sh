#!/usr/bin/env bash
# Re-record the visual baselines, in the image, with the flag you cannot forget —
# and separate the baselines that really changed from the ones `=all` rewrote
# just because it rewrites everything.
#
#   scripts/record-baselines.sh
#
# ─────────────────────────────────────────────────────────────────────────────
# TWO FAILURE MODES, IN OPPOSITE DIRECTIONS
#
# 1. A bare `--update-snapshots` rewrites a file only when the comparison FAILS.
#    Anything under the diff budget keeps its old image and the run exits 0,
#    so a re-record that did nothing is indistinguishable from one that worked.
#    `webapp/README.md` has said "`=all`, not bare" for a while and the bare form
#    has still been used three times — most recently on the Applications cutover
#    (PR #157), which rewrote the two mobile pipeline baselines, left the two
#    desktop ones alone, and then PASSED against images of the retired surface.
#    Caught by opening the PNG.
#
# 2. `=all` rewrites EVERY baseline unconditionally, so afterwards `git status`
#    lists every file whose bytes differ AT ALL — including rendering noise the
#    check would have tolerated. Measured on that same branch: `=all` left 23
#    files modified, 22 of them on surfaces the branch never touched, all of
#    them green against their committed baselines. Committing that set would be
#    23 files of churn presented as a re-record, and it is exactly the "many
#    baselines moved at once" alarm that means STOP, not "record harder".
#
# So this runs the CHECK first and the record second, and reports the two lists
# separately. The check's failures are the real changes. Everything else is
# churn, and the script says so and hands you the command to drop it.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHAT IT STILL CANNOT DO
#
# Tell you whether the new images are RIGHT. A baseline is the only expected
# value in this repo that is a binary blob nobody reads, so a person opening the
# changed PNGs is the last step and there is no automating it.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
snaps="webapp/tests/e2e/visual.spec.ts-snapshots"
cd "$repo"

dirty=$(git status --porcelain -- "$snaps" | wc -l | tr -d ' ')
if [[ "$dirty" != "0" ]]; then
  echo "[record-baselines] REFUSING: $dirty baseline(s) already modified in the worktree." >&2
  echo "                   The check below has to run against what is COMMITTED, or its" >&2
  echo "                   verdict is about your uncommitted images instead of the ones" >&2
  echo "                   the gate defends. Commit or discard them first." >&2
  exit 2
fi

echo "════════════════════════════════════════════════════════════════════════"
echo "[record-baselines] step 1/2 — CHECK against the committed baselines"
echo "                   Whatever fails here is what genuinely changed."
echo "════════════════════════════════════════════════════════════════════════"
check_log=$(mktemp)
set +e
"$repo/scripts/test-shell.sh" bash -lc '
  cd webapp
  HQ_VISUAL=1 HQ_DEMO=1 npx playwright test tests/e2e/visual.spec.ts --reporter=line
' 2>&1 | tee "$check_log"
set -e

# Playwright's line reporter names each failure after the summary.
real=$(grep -oE '›[^›]*looks? right[^(]*|› [a-z].*—[^(]*' "$check_log" \
        | sed 's/^› *//; s/ *$//' | sort -u || true)
failed=$(grep -cE '^ +[0-9]+ failed' "$check_log" || true)

echo
echo "════════════════════════════════════════════════════════════════════════"
echo "[record-baselines] step 2/2 — RECORD with =all"
echo "════════════════════════════════════════════════════════════════════════"
"$repo/scripts/test-shell.sh" bash -lc '
  cd webapp
  HQ_VISUAL=1 HQ_DEMO=1 npx playwright test tests/e2e/visual.spec.ts --update-snapshots=all
' || true

echo
moved=$(git status --porcelain -- "$snaps" | sed 's/^ *M *//' || true)
moved_n=$(printf '%s\n' "$moved" | grep -c . || true)

echo "════════════════════════════════════════════════════════════════════════"
echo "[record-baselines] $moved_n baseline file(s) differ from the commit."
echo "════════════════════════════════════════════════════════════════════════"
if [[ "$failed" == "0" || -z "$failed" ]]; then
  cat <<'EOF'

  The CHECK WAS GREEN before recording. That means NONE of these is a real
  change: `=all` rewrote every file and these are the ones whose bytes differ
  by rendering noise the gate already tolerates.

  Unless you know exactly why a given file should change, drop the lot:

      git checkout -- webapp/tests/e2e/visual.spec.ts-snapshots/

  A green check plus a long modified list is not a re-record. It is churn.
EOF
else
  echo
  echo "  The check FAILED on the shots below. Those are the real changes; keep"
  echo "  their baselines. Every OTHER modified file is =all churn — discard it"
  echo "  individually with git checkout -- <path>."
  echo
  printf '%s\n' "$real" | sed 's/^/      /'
fi

cat <<'EOF'

  Then, whatever you keep:
    1. OPEN the changed PNGs. A baseline nobody looked at is a screenshot the
       gate will defend forever without a person having seen it.
    2. Run the check again and confirm green against what you will commit:

         scripts/test-shell.sh bash -lc 'cd webapp && HQ_VISUAL=1 HQ_DEMO=1 \
           npx playwright test tests/e2e/visual.spec.ts'
EOF
rm -f "$check_log"
