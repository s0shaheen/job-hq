#!/usr/bin/env bash
#
# ci-select.sh — which .github/workflows/ci.yml jobs can this diff have broken?
#
# WHY THIS EXISTS
#
# Every CI run fired all seven gate jobs regardless of what changed, and billed
# minutes accrue per job. Measured on 2026-08-03 (run 30846546842): webapp shard 1
# 850s, shard 2 688s, pinned mutants 240s, visual 169s, tests 125s, db 85s,
# render 36s — about 40 billed runner-minutes a run, of which a docs-only pull
# request needed none. There were 155 pull-request runs that day.
#
# THE MAP IS NOT HERE. It is `path_map` in scripts/verify.sh, the same one the
# local change-scoped lane resolves, queried through `verify.sh --print-ci-jobs`.
# A second copy of that map in YAML would be a copy that drifts, and the drift
# would be invisible: CI would skip a job the local lane still runs, or the other
# way round, and nothing would say so. tests/core/test_ci_selection.py holds the
# two ends together.
#
# THE SAFETY PROPERTIES, in the order they matter:
#
#   1. An unmapped path selects EVERY job. Inherited from verify.sh, where a path
#      matching no rule falls back to the full registry. A new top-level directory
#      must not read as a small blast radius.
#   2. Anything other than a pull_request — a push to main, a manual dispatch, a
#      merge group — selects EVERY job. The economy is for pull requests only. A
#      merge that skipped a suite and then broke main costs far more than the
#      minutes it saved, and red-main.yml pages the ops topic when it happens.
#   3. Every failure path here selects EVERY job. A base ref that does not
#      RESOLVE, a diff that will not compute, a verify.sh that exits non-zero:
#      none of those are evidence of a small change, so none of them may narrow
#      the run. This script does not have a way to fail closed that is cheaper
#      than being wrong, so it fails OPEN — toward running more. A fetch that
#      fails while the ref still resolves is the one case that is judged rather
#      than assumed; the block at the fetch itself carries that argument.
#   4. The job that runs this script has NO `if:` and always reports. That is
#      deliberate and it is load-bearing: scripts/land.sh refuses (exit 10) when a
#      pull request's check set is empty or when NONE of its checks passed, which
#      is the guard that would have stopped #108 and #109 landing on a red main.
#      A `skipped` job still appears in `gh pr checks` — verified against PR #174,
#      where the five dispatch-only jobs report bucket `skipping` — but `skipping`
#      is not `pass`, so a pull request whose every gate skipped would have a check
#      set of nothing but skips and land.sh would refuse it. This job is the check
#      that passes, so the refusal keeps meaning what it says instead of firing on
#      the docs change it was never aimed at.
#
# OUTPUT. `<job>=true|false` per line, appended to $GITHUB_OUTPUT if set and
# printed to stdout either way, plus a human summary on $GITHUB_STEP_SUMMARY.
#
set -uo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo" || exit 1

VERIFY="$repo/scripts/verify.sh"

# The complete job set, asked of the same registry rather than listed here.
ALL_JOBS="$("$VERIFY" --full --print-ci-jobs 2>/dev/null)"
if [[ -z "$ALL_JOBS" ]]; then
  echo "ci-select: verify.sh --full --print-ci-jobs returned nothing." >&2
  echo "           Without the job set there is nothing to emit, and guessing it" >&2
  echo "           would mean guessing which gates exist. Refusing." >&2
  exit 1
fi

reason=""
selected=""

full() { reason="$1"; selected="$ALL_JOBS"; }

event="${GITHUB_EVENT_NAME:-}"
base_ref="${GITHUB_BASE_REF:-}"

if [[ "$event" != "pull_request" ]]; then
  full "event is '${event:-<none>}', not pull_request — the full set always runs outside a PR"
elif [[ -z "$base_ref" ]]; then
  full "pull_request with no GITHUB_BASE_REF, so there is no base to diff against"
else
  # Refresh the base if we can. A failed fetch is not by itself a reason to run
  # everything: what matters is whether `origin/<base>` RESOLVES. The verification
  # image is the case that proved the difference — it has no network and mounts
  # the parent .git read-only, so `git fetch` cannot even write FETCH_HEAD there
  # while origin/main is perfectly readable. Treating that as fatal made the
  # selector's own end-to-end test unable to observe narrowing at all, from every
  # linked worktree, which is every agent in this repo.
  #
  # Narrowing against a STALE base is usually safe, and the reason is worth
  # writing down because it is the whole safety case. `git diff A...HEAD` diffs
  # the MERGE BASE of A and HEAD against HEAD. If the local ref is merely behind
  # the real base — an ancestor of it — then every common ancestor it can offer is
  # also a common ancestor of the real base, so the merge base can only move
  # BACKWARDS, and a merge base further back yields MORE changed paths, hence more
  # suites. Wrong in the direction that runs extra work rather than the direction
  # that skips a gate.
  #
  # That argument holds only while the stale ref is an ANCESTOR of the true base,
  # and one case breaks it: a base that was REWOUND (force-pushed backwards). Then
  # the stale ref is a DESCENDANT of the true tip, the merge base moves FORWARD,
  # and the diff gets SMALLER — measured, not assumed: with main force-pushed from
  # C back to A, the stale base reports 1 changed path where the true base reports
  # 3. Two of those paths would have selected no gate.
  #
  # There is no offline test for "was my base rewound", so the resolution is by
  # blast radius rather than by detection. Inside Actions these verdicts GATE REAL
  # JOBS, and a fetch failure there is an anomaly rather than the normal case, so
  # it keeps the old behaviour and runs everything. Outside Actions the verdicts
  # gate nothing — they are printed, and the local lane is scripts/verify.sh — so
  # a stale base is free and the narrowing path stays reachable and testable.
  fetch_failed=0
  if ! git fetch --no-tags --quiet origin \
       "+refs/heads/${base_ref}:refs/remotes/origin/${base_ref}" 2>/dev/null; then
    fetch_failed=1
  fi
  if [[ $fetch_failed -eq 1 && "${GITHUB_ACTIONS:-}" == "true" ]]; then
    full "could not fetch origin/${base_ref}, and inside Actions a base that may have been rewound cannot be narrowed against"
  elif ! git rev-parse --verify --quiet "refs/remotes/origin/${base_ref}" >/dev/null; then
    full "origin/${base_ref} does not resolve, so there is no base to diff against"
  else
    if [[ $fetch_failed -eq 1 ]]; then
      echo "ci-select: could not fetch origin/${base_ref}; diffing against the" >&2
      echo "           ref already here, which is at worst stale and therefore at" >&2
      echo "           worst too wide. Not inside Actions, so nothing is gated on it." >&2
    fi
    changed=""
    if ! changed="$(git diff --name-only "origin/${base_ref}...HEAD" 2>/dev/null)"; then
      full "the diff against origin/${base_ref} would not compute"
    elif [[ -z "$changed" ]]; then
      # An EMPTY diff is not a small change, it is a diff that did not compute:
      # a pull request with no changed files cannot exist. verify.sh reaches the
      # same conclusion from the same input (its `no changed paths could be
      # determined` fallback), so this is belt and braces, stated here because
      # the consequence is CI-wide.
      full "the diff against origin/${base_ref} was empty"
    else
      # verify.sh under --print-ci-jobs puts the job names on stdout and its whole
      # reasoning on stderr. Both are wanted: the names are the answer, the
      # reasoning is what makes "the browser suite did not run" readable in the
      # log six weeks from now. So stderr is left to flow to the log and only
      # stdout is captured.
      changed_n="$(printf '%s\n' "$changed" | wc -l | tr -d ' ')"
      echo "--- scripts/verify.sh --print-ci-jobs, over ${changed_n} changed path(s)"
      if selected="$(HQ_VERIFY_PATHS="$changed" "$VERIFY" --print-ci-jobs)"; then
        reason="${changed_n} changed path(s) against origin/${base_ref}"
      else
        full "verify.sh --print-ci-jobs exited non-zero"
      fi
      echo "--- end verify.sh"
    fi
  fi
fi

is_selected() {
  local j
  while IFS= read -r j; do [[ "$j" == "$1" ]] && return 0; done <<< "$selected"
  return 1
}

# The last hop, and the one place fail-open does not reach on its own.
#
# Everything above narrows toward running MORE when it cannot answer. Delivery
# inverts that: an emit that does not land leaves `steps.pick.outputs.<job>` as
# the empty string, which is not 'true', so EVERY gate skips — while this job
# still exits 0 and reports `pass`. land.sh would then see one passing check and
# six skips, exactly what a legitimate docs-only pull request looks like, and
# merge an ungated branch. So a delivery failure is fatal here rather than
# ignored: a red `select` skips the gates too, but land.sh refuses a fail bucket.
emit_failed=0
emit() {
  printf '%s\n' "$1"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s\n' "$1" >> "$GITHUB_OUTPUT" || emit_failed=1
  fi
  return 0
}

# And an unset GITHUB_OUTPUT *inside Actions* is the same failure one step
# earlier — nothing is written anywhere, every gate skips, the job goes green.
# Outside Actions (the tests, a local run) it is normal and stdout is the answer.
if [[ "${GITHUB_ACTIONS:-}" == "true" && -z "${GITHUB_OUTPUT:-}" ]]; then
  echo "ci-select: GITHUB_ACTIONS is set but GITHUB_OUTPUT is not." >&2
  echo "           Every gate would read an empty output, skip, and leave a green" >&2
  echo "           select as the only check — which land.sh accepts. Refusing." >&2
  exit 1
fi

echo "ci-select: $reason"
echo

running=0; skipping=0
lines=""
while IFS= read -r job; do
  [[ -z "$job" ]] && continue
  if is_selected "$job"; then
    emit "${job}=true";  lines="${lines}| \`${job}\` | runs |"$'\n'; running=$((running + 1))
  else
    emit "${job}=false"; lines="${lines}| \`${job}\` | skipped — no changed path maps to it |"$'\n'; skipping=$((skipping + 1))
  fi
done <<< "$ALL_JOBS"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "## Which gates this diff can have broken"
    echo
    echo "${reason}"
    echo
    echo "| job | verdict |"
    echo "|---|---|"
    printf '%s' "$lines"
    echo
    echo "${running} running, ${skipping} skipped. The map is \`path_map\` in"
    echo "\`scripts/verify.sh\` — the same one \`scripts/verify.sh --image\` resolves"
    echo "locally. An unmapped path, a non-PR event, or any failure here runs everything."
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo
echo "ci-select: ${running} job(s) will run, ${skipping} skipped."

if [[ "$emit_failed" == 1 ]]; then
  echo "ci-select: one or more outputs could not be written to \$GITHUB_OUTPUT" >&2
  echo "           (${GITHUB_OUTPUT}). The verdicts above were computed correctly and" >&2
  echo "           then not delivered, so every gate would read an empty output and" >&2
  echo "           skip while this job reported green. Failing instead." >&2
  exit 1
fi
exit 0
