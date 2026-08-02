#!/usr/bin/env bash
#
# land.sh — the only sanctioned way to put a branch on main.
#
# WHY THIS EXISTS
#
# This repository is private on a plan without branch protection, so GitHub
# will happily merge a pull request whose checks are red. On 2026-08-01 that
# happened twice in one session: PRs #108 and #109 were merged over failing
# checks. The mechanism was not carelessness — it was a shell idiom:
#
#     gh pr checks --watch && gh pr merge --squash
#
# run from a backgrounded process. The watch process was killed with its
# parent shell, so its non-zero exit never reached the `&&`, and the merge
# ran anyway. Main then sat red until somebody noticed by accident.
#
# So this script is the enforcement that the plan does not provide. It runs
# as ONE foreground process, polls explicitly rather than trusting a long
# `--watch` to survive, and treats an empty or unreadable check set as a
# refusal rather than a pass. Every refusal exits non-zero with a distinct
# code and prints why.
#
# USAGE
#
#     scripts/land.sh                      # land the current branch
#     scripts/land.sh --dry-run            # everything up to (not including) merge
#     scripts/land.sh --title "..." --body-file NOTES.md
#
# ENVIRONMENT
#
#     LAND_BASE            base branch (default: main)
#     LAND_MERGE_METHOD    squash | merge | rebase (default: squash)
#     LAND_CHECK_TIMEOUT   seconds to wait for checks to conclude (default: 2400)
#     LAND_CHECK_GRACE     seconds to wait for checks to APPEAR (default: 240)
#     LAND_POLL_INTERVAL   seconds between polls (default: 15)
#     LAND_GATES           override the local gate command
#     LAND_SKIP_GATES      set to 1 to skip local gates (CI still gates the merge)
#
# EXIT CODES  (each one is a refusal that really happened, or really could)
#
#      0  merged, and origin/<base> verified to have moved
#      2  dirty worktree
#      3  HEAD is the base branch, or detached
#      4  local gates failed
#      5  rebase onto origin/<base> failed (conflict)
#      6  push failed
#      7  could not create or read the pull request
#      8  checks concluded FAILING (or cancelled)
#      9  checks still PENDING when the timeout expired
#     10  check set is EMPTY or UNKNOWN  <-- the #108 / #109 hole
#     11  the pull request is not in a mergeable state, or merge failed
#     12  merge reported success but origin/<base> did not move as expected
#     20  prerequisites missing (git, gh, jq, auth, repo)
#
set -uo pipefail

BASE="${LAND_BASE:-main}"
MERGE_METHOD="${LAND_MERGE_METHOD:-squash}"
CHECK_TIMEOUT="${LAND_CHECK_TIMEOUT:-2400}"
CHECK_GRACE="${LAND_CHECK_GRACE:-240}"
POLL_INTERVAL="${LAND_POLL_INTERVAL:-15}"

DRY_RUN=0
PR_TITLE=""
PR_BODY_FILE=""

# ---------------------------------------------------------------- reporting

if [ -t 1 ]; then
  _b=$'\033[1m'; _r=$'\033[31m'; _g=$'\033[32m'; _y=$'\033[33m'; _0=$'\033[0m'
else
  _b=""; _r=""; _g=""; _y=""; _0=""
fi

# ALL narration goes to stderr; stdout carries the RESULT and nothing else.
#
# Before this, `step`/`info`/`ok` wrote to stdout and the detail lines beside a
# refusal wrote to stderr, so one refusal's narrative arrived split across two
# streams — a caller redirecting either got half a sentence. The split is also
# why `land.sh | tail` showed progress but not the reason for a failure.
#
# The contract now: `land.sh > out` leaves `out` holding the LANDED summary, and
# `2> log` holds the story of how it got there.
step()  { printf '%s\n' "${_b}==> $*${_0}" >&2; }
info()  { printf '    %s\n' "$*" >&2; }
# stderr, like the detail lines a refusal prints beside it. This used to write to
# stdout, which split one refusal's narrative across two streams — header on
# stdout, explanation on stderr — so a caller redirecting either one got half a
# sentence. Every diagnostic this script emits goes to stderr; only the LANDED
# summary is stdout, because that is the script's result rather than its
# commentary.
warn()  { printf '%s\n' "${_y}    $*${_0}" >&2; }
ok()    { printf '%s\n' "${_g}    $*${_0}" >&2; }

# refuse <exit-code> <headline> [detail...]
refuse() {
  local code="$1"; shift
  printf '\n%s\n' "${_r}${_b}REFUSED (exit ${code}): $1${_0}" >&2
  shift || true
  local line
  for line in "$@"; do printf '%s\n' "${_r}  ${line}${_0}" >&2; done
  printf '\n' >&2
  exit "$code"
}

# ---------------------------------------------------------------- arguments

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)    DRY_RUN=1; shift ;;
    --title)      PR_TITLE="${2:-}"; shift 2 ;;
    --body-file)  PR_BODY_FILE="${2:-}"; shift 2 ;;
    --base)       BASE="${2:-}"; shift 2 ;;
    -h|--help)    sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            refuse 20 "Unknown argument: $1" "Run scripts/land.sh --help." ;;
  esac
done

# ------------------------------------------------------------ prerequisites

step "Checking prerequisites"
for tool in git gh jq; do
  command -v "$tool" >/dev/null 2>&1 \
    || refuse 20 "\`$tool\` is not installed." "land.sh needs git, gh and jq."
done

git rev-parse --git-dir >/dev/null 2>&1 \
  || refuse 20 "Not inside a git repository."

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT" || refuse 20 "Cannot cd to repository root ${REPO_ROOT}."

gh auth status >/dev/null 2>&1 \
  || refuse 20 "\`gh\` is not authenticated." "Run: gh auth login"

SLUG="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
[ -n "$SLUG" ] || refuse 20 "Could not resolve the GitHub repository for this checkout."
ok "repo ${SLUG}, base ${BASE}, merge method ${MERGE_METHOD}"

# ---------------------------------------------------- refusal: HEAD is base

step "Checking the branch"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ "$BRANCH" = "HEAD" ]; then
  refuse 3 "HEAD is detached." \
    "land.sh lands a named branch. Check one out first."
fi

if [ "$BRANCH" = "$BASE" ]; then
  refuse 3 "HEAD is ${BASE}." \
    "${BASE} is never pushed to directly (CLAUDE.md, non-negotiable rules)." \
    "Move your work to a branch:  git checkout -b feat/<name>"
fi
ok "on branch ${BRANCH}"

# ------------------------------------------------ refusal: dirty worktree

step "Checking the worktree is clean"
# TRACKED changes only. The property this protects is "the commits under test are
# the commits being merged", and an untracked file cannot break it — it is not in
# either. Refusing on untracked files made land.sh unusable in the real
# repository, which carries the owner's own unversioned directories and personal
# files that no branch has any business committing.
#
# Untracked files still get named, because the one way they DO matter is a new
# source file the author forgot to `git add`: gates pass locally against the
# working tree and CI then fails against the commit. Naming them is enough —
# that failure is loud, attributable, and caught before the merge either way.
DIRTY="$(git status --porcelain --untracked-files=no)"
if [ -n "$DIRTY" ]; then
  refuse 2 "The worktree has uncommitted TRACKED changes." \
    "Landing an unclean tree means the commits under test are not the commits" \
    "you are merging. Commit or stash first. Offending paths:" \
    "$(printf '%s' "$DIRTY" | head -20 | sed 's/^/    /')"
fi
UNTRACKED="$(git ls-files --others --exclude-standard | head -10)"
if [ -n "$UNTRACKED" ]; then
  warn "untracked files present — not blocking, but check none of them belong in this branch:"
  printf '%s\n' "$UNTRACKED" | sed 's/^/      /' >&2
fi
ok "no uncommitted tracked changes"

# --------------------------------------------------------------- rebase

step "Rebasing ${BRANCH} onto origin/${BASE}"
git fetch origin "$BASE" --quiet \
  || refuse 5 "Could not fetch origin/${BASE}."

BASE_BEFORE="$(git rev-parse "origin/${BASE}")"

if git merge-base --is-ancestor "origin/${BASE}" HEAD; then
  ok "already on top of origin/${BASE} (${BASE_BEFORE:0:8}) — nothing to rebase"
else
  if ! git rebase "origin/${BASE}"; then
    git rebase --abort >/dev/null 2>&1 || true
    refuse 5 "Rebase onto origin/${BASE} hit a conflict." \
      "Resolve it by hand, then re-run scripts/land.sh."
  fi
  ok "rebased onto ${BASE_BEFORE:0:8}"
fi

HEAD_SHA="$(git rev-parse HEAD)"

if [ "$HEAD_SHA" = "$BASE_BEFORE" ]; then
  refuse 5 "${BRANCH} has no commits that origin/${BASE} does not already have." \
    "There is nothing to land."
fi

# ---------------------------------------------------------------- gates

# Gates are skipped only when this exact commit already passed them in this
# checkout. That is what makes land.sh re-runnable after a fix without
# redoing work — and it is safe because the stamp is keyed to the SHA.
GATE_STAMP="$(git rev-parse --git-dir)/land-gates-passed"

run_gates() {
  if [ "${LAND_SKIP_GATES:-0}" = "1" ]; then
    warn "LAND_SKIP_GATES=1 — local gates skipped. CI still gates the merge."
    return 0
  fi

  if [ -f "$GATE_STAMP" ] && [ "$(cat "$GATE_STAMP" 2>/dev/null)" = "$HEAD_SHA" ]; then
    ok "gates already passed for ${HEAD_SHA:0:8} — not re-running"
    return 0
  fi

  local cmd
  if [ -n "${LAND_GATES:-}" ]; then
    cmd="$LAND_GATES"
    info "using LAND_GATES"
  elif [ -x "${REPO_ROOT}/scripts/verify.sh" ]; then
    # The fast verification lane, when it exists. land.sh must not hard-depend
    # on it: it is built separately and may not have landed yet.
    cmd="${REPO_ROOT}/scripts/verify.sh"
    info "using scripts/verify.sh"
  else
    warn "scripts/verify.sh not present — falling back to the pytest gate."
    warn "This is the degraded lane: webapp gates are left to CI."
    cmd="uv run --python 3.11 --with-requirements requirements.txt --no-project -- pytest -q"
  fi

  info "\$ ${cmd}"
  if ! ( eval "$cmd" ); then
    rm -f "$GATE_STAMP"
    refuse 4 "Local gates failed." \
      "Fix the failure and re-run scripts/land.sh. Do not weaken the test."
  fi
  printf '%s' "$HEAD_SHA" > "$GATE_STAMP"
  ok "gates passed"
}

step "Running local gates"
run_gates

# ------------------------------------------------------------------ push

step "Pushing ${BRANCH}"
if ! git push --force-with-lease --set-upstream origin "${BRANCH}:${BRANCH}"; then
  refuse 6 "Push of ${BRANCH} failed." \
    "--force-with-lease refuses when the remote branch moved under you." \
    "Someone else may be pushing to this branch. Investigate before retrying."
fi
ok "pushed ${HEAD_SHA:0:8}"

# -------------------------------------------------------------------- PR

step "Opening or updating the pull request"
PR_NUM="$(gh pr list --head "$BRANCH" --base "$BASE" --state open \
            --json number -q '.[0].number' 2>/dev/null || true)"

if [ -z "$PR_NUM" ] || [ "$PR_NUM" = "null" ]; then
  [ -n "$PR_TITLE" ] || PR_TITLE="$(git log -1 --pretty=%s)"
  create_args=(pr create --base "$BASE" --head "$BRANCH" --title "$PR_TITLE")
  if [ -n "$PR_BODY_FILE" ]; then
    create_args+=(--body-file "$PR_BODY_FILE")
  else
    create_args+=(--body "$(git log "origin/${BASE}..HEAD" --pretty='- %s')")
  fi
  gh "${create_args[@]}" >/dev/null \
    || refuse 7 "Could not create the pull request."
  PR_NUM="$(gh pr list --head "$BRANCH" --base "$BASE" --state open \
              --json number -q '.[0].number' 2>/dev/null || true)"
  [ -n "$PR_NUM" ] && [ "$PR_NUM" != "null" ] \
    || refuse 7 "Created a pull request but could not read its number back."
  ok "opened PR #${PR_NUM}"
else
  ok "reusing open PR #${PR_NUM}"
fi

PR_URL="https://github.com/${SLUG}/pull/${PR_NUM}"
info "$PR_URL"

# --------------------------------------------------- wait for the checks
#
# Deliberately NOT `gh pr checks --watch && gh pr merge`. That chain is what
# merged #108 and #109 over red: backgrounded, the watch died with its parent
# and its exit status never reached the `&&`. Here every poll is its own
# short-lived call, the loop owns the decision, and the ONLY path out that
# continues to the merge is an explicit all-pass.

# Below T2 the full check set is twelve idle minutes for a change that cannot
# break a migration, an RLS policy or a rendered surface. `LAND_TIER=t1` merges
# on local gates and leaves CI to catch it on main, where red-main.yml pages.
# Deliberately opt-IN and never the default: the tier is a judgement about blast
# radius, and a script cannot make it.
if [ "${LAND_TIER:-}" = "t0" ] || [ "${LAND_TIER:-}" = "t1" ]; then
  warn "LAND_TIER=${LAND_TIER}: merging on local gates without waiting for CI."
  warn "Red main pages via red-main.yml. Do NOT use this for migrations, RLS,"
  warn "RPCs, storage, workers, providers, or any rendered surface."
  SKIP_CHECK_WAIT=1
fi

step "Waiting for checks on PR #${PR_NUM}"

poll_checks() {
  # Prints the checks JSON array on stdout, or nothing if it could not be read.
  gh pr checks "$PR_NUM" --json name,state,bucket,link 2>/dev/null || true
}

head_on_github() {
  gh pr view "$PR_NUM" --json headRefOid -q .headRefOid 2>/dev/null || true
}

started="$(date +%s)"
last_summary=""
CHECKS=""

while [ -z "${SKIP_CHECK_WAIT:-}" ]; do
  now="$(date +%s)"
  elapsed=$(( now - started ))

  # Checks belong to a commit. Right after a push the API keeps serving the
  # PREVIOUS head's check set for a few seconds — observed live: a fresh push
  # was greeted with the old commit's failure. Reading those is wrong in both
  # directions (a stale red refuses a good branch; a stale green would merge
  # an ungated one), so nothing is trusted until GitHub agrees on the head.
  gh_head="$(head_on_github)"
  if [ "$gh_head" != "$HEAD_SHA" ]; then
    if [ "$elapsed" -lt "$CHECK_GRACE" ]; then
      info "GitHub still reports head ${gh_head:0:8}; waiting for ${HEAD_SHA:0:8} (${elapsed}s of ${CHECK_GRACE}s grace)"
      sleep "$POLL_INTERVAL"
      continue
    fi
    refuse 10 "GitHub reports PR #${PR_NUM} head as ${gh_head:0:8}, not the gated ${HEAD_SHA:0:8}." \
      "Any checks readable here belong to a different commit, so there is no" \
      "check set for what you are trying to land. That is a refusal, not a pass."
  fi

  raw="$(poll_checks)"

  # An unreadable check set is NOT a pass. It is indistinguishable, from here,
  # from "nothing is running", which is exactly how a red merge sneaks in.
  if [ -z "$raw" ] || ! printf '%s' "$raw" | jq -e 'type == "array"' >/dev/null 2>&1; then
    count=0
  else
    count="$(printf '%s' "$raw" | jq 'length')"
  fi

  if [ "$count" -eq 0 ]; then
    if [ "$elapsed" -lt "$CHECK_GRACE" ]; then
      info "no checks reported yet (${elapsed}s of ${CHECK_GRACE}s grace)"
      sleep "$POLL_INTERVAL"
      continue
    fi
    refuse 10 "PR #${PR_NUM} reports an EMPTY or UNREADABLE check set after ${elapsed}s." \
      "An empty check set is a refusal, never a pass. Nothing has vouched for" \
      "this branch, so nothing may merge it. This is the exact hole that let" \
      "#108 and #109 onto main red." \
      "" \
      "Look at ${PR_URL} — workflows may be disabled, filtered out by their" \
      "paths/branches triggers, or awaiting approval."
  fi

  CHECKS="$raw"

  # Checks this repository does not own, and therefore does not gate on.
  #
  # `Vercel` is a preview deployment for the editor project, attached by that
  # project's own Git integration. On 2026-08-02 it began failing every PR with
  # "Deployment rate limited — retry in 24 hours": an account-level build cap,
  # not a statement about the code. The webapp's own deployment goes through
  # deploy.yml, which builds and probes the artifact itself, so nothing about
  # correctness is lost by not gating here.
  #
  # This list is DELIBERATELY a list and not a pattern. Every entry is a
  # decision that a specific external service does not speak for this repo, and
  # a pattern would quietly absorb the next check somebody adds. An ignored
  # check is still printed, so it cannot go unnoticed.
  IGNORED_CHECKS_JQ='["Vercel", "Vercel Preview Comments"]'
  ignored_fail="$(printf '%s' "$raw" | jq -r --argjson ig "$IGNORED_CHECKS_JQ" \
    '[.[] | select((.bucket == "fail" or .bucket == "cancel") and (.name | IN($ig[])))] | .[] | "    ignored  \(.name)  \(.link)"')"
  if [ -n "$ignored_fail" ]; then
    warn "failing checks this repo does not own — NOT gating on them:"
    printf '%s\n' "$ignored_fail" >&2
  fi
  # Filter ALWAYS, then treat an empty result the way an empty check set is
  # treated: keep waiting while the grace window is open, refuse once it closes.
  # The first attempt kept the UNFILTERED set whenever filtering emptied it,
  # meaning to be cautious — and on PR #126 the only check registered yet was
  # the ignored one, so that "caution" gated on exactly the check the list
  # exists to ignore. Waiting is the honest reading of "the only thing
  # reporting so far is something we do not own".
  raw="$(printf '%s' "$raw" | jq --argjson ig "$IGNORED_CHECKS_JQ" '[.[] | select((.name | IN($ig[])) | not)]' 2>/dev/null || printf '[]')"
  count="$(printf '%s' "$raw" | jq 'length' 2>/dev/null || printf '0')"
  if [ "${count:-0}" -eq 0 ]; then
    if [ "$elapsed" -lt "$CHECK_GRACE" ]; then
      info "only ignored checks so far (${elapsed}s of ${CHECK_GRACE}s grace)"
      sleep "$POLL_INTERVAL"
      continue
    fi
    refuse 10 "PR #${PR_NUM} has no checks this repository owns." \
      "Every check reporting is on the ignore list, so nothing that speaks for" \
      "this repo has vouched for the branch. That is a refusal, not a pass."
  fi

  fail_n="$(printf '%s' "$raw"    | jq '[.[] | select(.bucket == "fail" or .bucket == "cancel")] | length')"
  pending_n="$(printf '%s' "$raw" | jq '[.[] | select(.bucket == "pending")] | length')"
  pass_n="$(printf '%s' "$raw"    | jq '[.[] | select(.bucket == "pass")] | length')"
  other_n=$(( count - fail_n - pending_n - pass_n ))

  summary="${pass_n} pass / ${fail_n} fail / ${pending_n} pending / ${other_n} other (of ${count})"
  if [ "$summary" != "$last_summary" ]; then
    info "$summary"
    last_summary="$summary"
  fi

  if [ "$fail_n" -gt 0 ]; then
    refuse 8 "PR #${PR_NUM} has ${fail_n} failing or cancelled check(s)." \
      "$(printf '%s' "$raw" | jq -r '.[] | select(.bucket == "fail" or .bucket == "cancel") | "    \(.bucket)  \(.name)  \(.link)"')" \
      "" \
      "Fix the failure, then re-run scripts/land.sh."
  fi

  if [ "$pending_n" -eq 0 ]; then
    break
  fi

  if [ "$elapsed" -ge "$CHECK_TIMEOUT" ]; then
    refuse 9 "PR #${PR_NUM} still has ${pending_n} PENDING check(s) after ${elapsed}s." \
      "$(printf '%s' "$raw" | jq -r '.[] | select(.bucket == "pending") | "    pending  \(.name)"')" \
      "" \
      "Pending is not green. Re-run scripts/land.sh once they conclude," \
      "or raise LAND_CHECK_TIMEOUT if the suite is legitimately this slow."
  fi

  sleep "$POLL_INTERVAL"
done

# A run of nothing but skipped checks is not evidence of anything either.
if [ -z "${SKIP_CHECK_WAIT:-}" ] && [ "${pass_n:-0}" -eq 0 ]; then
  refuse 10 "PR #${PR_NUM} has ${count} check(s) but NONE of them passed." \
    "$(printf '%s' "$CHECKS" | jq -r '.[] | "    \(.bucket)  \(.name)"')" \
    "" \
    "Skipped or neutral checks do not vouch for a branch."
fi

if [ -n "${SKIP_CHECK_WAIT:-}" ]; then
  ok "checks not waited on (LAND_TIER=${LAND_TIER}); CI will run on main"
else
  ok "all checks green (${pass_n} passed)"
fi

# Re-read the head one last time. The loop guard proved the checks belonged to
# HEAD_SHA when they were read; this proves nothing was pushed to the branch in
# the meantime, between the last poll and the merge.
GH_HEAD="$(head_on_github)"
if [ "$GH_HEAD" != "$HEAD_SHA" ]; then
  refuse 8 "PR #${PR_NUM} head moved to ${GH_HEAD:0:8} while checks were being read." \
    "The green checks belong to a different commit. Re-run scripts/land.sh."
fi

# ------------------------------------------------------------- mergeable

MERGE_STATE="$(gh pr view "$PR_NUM" --json mergeable,mergeStateStatus,state \
                 -q '[.state, .mergeable, .mergeStateStatus] | @tsv' 2>/dev/null || true)"
info "pr state: ${MERGE_STATE}"
case "$MERGE_STATE" in
  OPEN*MERGEABLE*) : ;;
  *CONFLICTING*)   refuse 11 "PR #${PR_NUM} is CONFLICTING with ${BASE}." \
                     "Re-run scripts/land.sh; the rebase step will pick up the new base." ;;
  *) warn "unusual merge state — proceeding only because checks are green" ;;
esac

# ----------------------------------------------------------------- merge

if [ "$DRY_RUN" = "1" ]; then
  step "--dry-run: stopping before the merge"
  ok "PR #${PR_NUM} is green and would have been merged (${MERGE_METHOD})"
  exit 0
fi

step "Merging PR #${PR_NUM} (${MERGE_METHOD})"
if ! gh pr merge "$PR_NUM" "--${MERGE_METHOD}" --delete-branch; then
  # A non-zero exit here does NOT prove the merge failed. `gh pr merge` also
  # deletes the branch, and that step fails whenever a git worktree still holds
  # it — which is the normal state in this repo, where every agent works in one.
  # PRs #122 and #126 both merged cleanly and were reported as failures for
  # exactly that reason. So: ask GitHub what actually happened rather than
  # trusting the exit code, and only refuse if the PR really is unmerged. The
  # origin/BASE verification below is the authoritative check either way.
  merged_state="$(gh pr view "$PR_NUM" --json state -q .state 2>/dev/null || printf '')"
  if [ "$merged_state" = "MERGED" ]; then
    warn "gh pr merge exited non-zero but PR #${PR_NUM} is MERGED — almost"
    warn "certainly the branch delete failed because a worktree holds it."
    warn "Clean up with: git worktree remove <path> && git branch -d ${BRANCH}"
  else
    refuse 11 "gh pr merge failed for PR #${PR_NUM} (state: ${merged_state:-unknown})." \
      "Nothing was landed. See ${PR_URL}."
  fi
fi

# ------------------------------------------- verify origin/BASE actually moved
#
# "gh pr merge exited 0" is a claim, not evidence. Auto-merge queues, races and
# transient API errors can all leave the base untouched. Prove it.

step "Verifying origin/${BASE} moved"
MERGE_SHA=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  read -r pr_state MERGE_SHA <<<"$(gh pr view "$PR_NUM" --json state,mergeCommit \
      -q '[.state, (.mergeCommit.oid // "")] | @tsv' 2>/dev/null || printf 'UNKNOWN\t')"
  [ "$pr_state" = "MERGED" ] && [ -n "$MERGE_SHA" ] && break
  sleep 5
done

[ "$pr_state" = "MERGED" ] \
  || refuse 12 "PR #${PR_NUM} is ${pr_state}, not MERGED, after gh reported success." \
       "Nothing may be assumed landed. See ${PR_URL}."
[ -n "$MERGE_SHA" ] \
  || refuse 12 "PR #${PR_NUM} is MERGED but GitHub reports no merge commit." \
       "Refusing to claim a landing that cannot be pointed at."

git fetch origin "$BASE" --quiet || refuse 12 "Could not re-fetch origin/${BASE} to verify."
BASE_AFTER="$(git rev-parse "origin/${BASE}")"

if [ "$BASE_AFTER" = "$BASE_BEFORE" ]; then
  refuse 12 "origin/${BASE} is still ${BASE_BEFORE:0:8} — it did not move." \
    "The merge did not take effect. See ${PR_URL}."
fi

if ! git merge-base --is-ancestor "$MERGE_SHA" "origin/${BASE}"; then
  refuse 12 "Merge commit ${MERGE_SHA:0:8} is not an ancestor of origin/${BASE} (${BASE_AFTER:0:8})." \
    "origin/${BASE} moved, but not to what this PR produced."
fi

rm -f "$GATE_STAMP"

printf '\n%s\n' "${_g}${_b}LANDED${_0}"
info "PR      #${PR_NUM}  ${PR_URL}"
info "branch  ${BRANCH} @ ${HEAD_SHA:0:8}"
if [ -n "${SKIP_CHECK_WAIT:-}" ]; then
  info "checks  not waited on (LAND_TIER=${LAND_TIER}) — CI runs on main, red-main.yml pages"
else
  info "checks  ${pass_n} passed, 0 failing, 0 pending"
fi
info "${BASE}    ${BASE_BEFORE:0:8} -> ${BASE_AFTER:0:8} (merge ${MERGE_SHA:0:8})"
exit 0
