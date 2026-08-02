#!/usr/bin/env bash
# The verification lane: run the gates a change can possibly have broken.
#
#   scripts/verify.sh                  # fast lane, against the working tree
#   scripts/verify.sh --dry-run        # show the selection, run nothing
#   scripts/verify.sh --since origin/main
#   scripts/verify.sh --image          # run it all inside the prebuilt image
#   scripts/verify.sh --full --image   # the real thing, before a PR
#
# WHY. A three-line fix does not need ~2,900 Python tests, ~1,970 vitest cases and
# ~1,000 Playwright cases to say whether it is correct. It needs the suites that
# can see it. This maps CHANGED PATHS to those suites so iteration costs minutes.
#
# WHAT IT WILL NOT DO. It will not call itself a full gate. Every run prints which
# suites ran, which did not, and why; the fast lane's verdict is PARTIAL and says
# so in the last line. `--full` is the real thing and refuses to report a pass
# when a gate could not run (no database, no linux font baselines) rather than
# skipping it quietly.
#
# THE SAFETY PROPERTY: a changed path that matches NO rule selects EVERYTHING.
# An unknown path is not evidence of a small blast radius, it is the absence of
# evidence. tests/core/test_verify_lane.py holds that line.
# No `set -u`. macOS ships bash 3.2, where expanding an EMPTY array under `set -u`
# is an "unbound variable" error — so a docs-only change, which correctly selects
# no suites, crashed the script on the host while passing inside the image (bash
# 5). tests/core/test_verify_lane.py caught it. pipefail stays.
set -o pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo"

# ─────────────────────────────────────────────────────────── interpreters
# Inside the image both venvs are baked and resolve nothing. Outside it, fall
# back to the documented uv invocations so the lane works with no Docker at all
# (slower, because uv re-resolves — which is the cost the image exists to remove).
if [[ "${HQ_TEST_IMAGE:-0}" == "1" ]]; then
  PY311="${HQ_PY311:-/opt/py311/bin/python}"
  PYTEST311="$PY311 -m pytest"
  PYTEST312="${HQ_PY312:-/opt/py312/bin/python} -m pytest"
else
  PY311="uv run --python 3.11 --with-requirements requirements.txt --no-project -- python"
  PYTEST311="uv run --python 3.11 --with-requirements requirements.txt --with psycopg[binary] --no-project -- pytest"
  PYTEST312="uv run --python 3.12 --with-requirements requirements.txt --with-requirements infra/render/requirements.txt --no-project -- pytest"
fi

# ─────────────────────────────────────────────────────────── the suite registry
#
# id | target that must exist | command
#
# The target is not decoration. A rule that maps a path to a suite whose tests
# were deleted or renamed would silently verify nothing; the registry check turns
# that into a loud startup failure.
suite_ids=(); suite_target=(); suite_cmd=(); suite_needs=()
suite() { suite_ids+=("$1"); suite_target+=("$2"); suite_cmd+=("$3"); suite_needs+=("${4:-}"); }

#      id               target                            command                                                                  needs
suite lint-copy        webapp/scripts/copy-lint          'cd webapp && npm run lint:copy'
suite coverage-ledger  webapp/scripts/coverage-ledger.mjs 'cd webapp && npm run coverage:ledger && ledger_is_committed'
suite typecheck        webapp/tsconfig.json              'cd webapp && npm run typecheck'
suite vitest           webapp/tests/unit                 'cd webapp && npm test'
suite py-core          tests/core                        '$PYTEST311 tests/core -q'
suite py-migrations    tests/core/test_migrations.py     '$PYTEST311 tests/core/test_migrations.py -q'
suite py-workflows     tests/core/test_workflows.py      '$PYTEST311 tests/core/test_workflows.py -q'
suite py-monitor       tests/monitor                     '$PYTEST311 tests/monitor -q'
suite py-tracker       tests/tracker                     '$PYTEST311 tests/tracker -q'
suite py-infra         tests/infra                       '$PYTEST311 tests/infra -q'
suite py-root          tests/test_runjob.py              '$PYTEST311 tests/test_runjob.py tests/test_sysmap.py tests/test_publish_to_drive.py -q'
suite sysmap           scripts/sysmap.py                 '$PY311 scripts/sysmap.py'
suite py-db            tests/db                          'HQ_REQUIRE_DB=1 $PYTEST311 tests/db -q'                                    database
suite py-render        tests/infra/test_render_live.py   'HQ_REQUIRE_RENDERCV=1 $PYTEST312 tests/infra/test_render_live.py tests/infra/test_render_guards.py -q -p no:cacheprovider'
suite build            webapp/next.config.mjs            'cd webapp && npm run build'
suite e2e-slop         webapp/tests/e2e/slop.spec.ts     'cd webapp && HQ_DEMO=1 npx playwright test tests/e2e/slop.spec.ts'
suite e2e              webapp/tests/e2e                  'cd webapp && HQ_DEMO=1 npx playwright test'
suite e2e-visual       webapp/tests/e2e/visual.spec.ts   'cd webapp && HQ_DEMO=1 HQ_VISUAL=1 npx playwright test tests/e2e/visual.spec.ts'  linux-baselines

# Running the parent makes the child redundant. Only ever collapses a suite into
# one that strictly contains it.
subsumed_by_py_core="py-migrations py-workflows"
subsumed_by_e2e="e2e-slop"
# py-render is deliberately NOT subsumed by py-infra: it is the same files on a
# DIFFERENT interpreter with rendercv actually installed, and under 3.11 those
# tests skip. A skipped security test is not a passed one.

# The committed ledger being current is a CI gate (ci.yml, shard 1). It needs
# git; a worktree mounted into a container has none, and a check that cannot run
# says so instead of passing.
ledger_is_committed() {
  if git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$repo" diff --exit-code -- docs/pilot-launch/evidence/ui-coverage.md
  else
    echo "[verify] NOTE: 'the committed ledger is current' needs git and this environment has none." >&2
    echo "[verify]       The ledger was regenerated; whether it matches the commit was NOT checked." >&2
    return 0
  fi
}

# ─────────────────────────────────────────────────────────── the path map
#
# pattern -> suites, or '-' for "deliberately no suites". A path matching NOTHING
# here falls back to FULL. Patterns are bash [[ ]] globs, where * crosses '/'.
#
# Union, not first-match: a change touching two areas gets both areas' suites.
path_map=(
  # ── webapp
  "webapp/lib/*                       = typecheck,vitest"
  "webapp/app/*                       = typecheck,vitest,lint-copy,coverage-ledger,build,e2e-slop,e2e"
  "webapp/components/*                = typecheck,vitest,lint-copy,coverage-ledger,build,e2e-slop,e2e"
  "webapp/middleware.ts               = typecheck,vitest,build,e2e"
  "webapp/tests/unit/*                = typecheck,vitest"
  "webapp/tests/e2e/visual.spec.ts*   = e2e-visual"
  "webapp/tests/e2e/*                 = typecheck,e2e"
  "webapp/tests/fixtures/*            = vitest,e2e"
  # vitest too, and not only the ledger run: tests/unit/coverage-ledger.test.ts
  # is what proves the GATE can fail — it feeds report.ts a broken citation and a
  # new missing cell. Mapped to coverage-ledger alone, a change to report.ts
  # regenerated the ledger and never ran the test that watches the gate work.
  "webapp/tests/coverage/*            = coverage-ledger,typecheck,vitest"
  "webapp/scripts/*                   = lint-copy,coverage-ledger"
  "webapp/package.json                = typecheck,vitest,build,e2e,e2e-visual"
  "webapp/package-lock.json           = typecheck,vitest,build,e2e,e2e-visual"
  "webapp/tsconfig.json               = typecheck,vitest,build"
  "webapp/next.config.mjs             = typecheck,build,e2e"
  "webapp/postcss.config.mjs          = build,e2e,e2e-visual"
  "webapp/vitest.config.mts           = vitest"
  "webapp/playwright.config.ts        = e2e,e2e-visual"

  # ── database
  #
  # `vitest` is in these rows because webapp/tests/unit/types-contract.test.ts
  # PARSES db/migrations/*.sql — it derives the TypeScript row types from the
  # CREATE TABLE bodies, so a migration-only change can turn it red with no
  # webapp file touched. Commit d3aef9e exists for exactly that: a block comment
  # inside a table body was read as column definitions and the test failed
  # ("unmapped SQL type \"by\" on column computed") after the change-scoped lane
  # had already reported a pass. A rule that maps the input of a test to
  # everything BUT that test is the gap, not the test.
  "db/migrations/*                    = py-db,py-migrations,vitest"
  "db/*                               = py-db,py-migrations,vitest"
  "supabase/*                         = py-db,py-migrations,vitest"

  # ── python packages
  # core/ is imported by monitor, tracker and the db write path, so a change
  # there is not local to core/.
  "core/*                             = py-core,py-monitor,py-tracker,py-db,py-root"
  "monitor/*                          = py-monitor"
  "tracker/*                          = py-tracker"
  "infra/render/*                     = py-render,py-infra"
  "infra/terraform/*                  = py-infra,sysmap"
  "infra/alerter/*                    = py-infra"
  "infra/app/*                        = py-infra"
  "infra/Dockerfile                   = py-infra"
  "infra/test-image/*                 = py-core"     # tests/core/test_verify_lane.py
  "scripts/sysmap.py                  = py-root,sysmap"
  # land.sh (the only merge path) and new-migration.sh are both asserted on by
  # tests/core/test_migrations.py — the migration-ledger rules live there.
  "scripts/land.sh                    = py-migrations,py-root"
  "scripts/new-migration.sh           = py-migrations,py-root"
  "scripts/verify.sh                  = py-core"
  "scripts/test-shell.sh              = py-core"
  "scripts/*                          = py-root"
  "requirements.txt                   = py-core,py-monitor,py-tracker,py-infra,py-root,py-db"
  "hq.config.yaml                     = py-core,py-monitor,py-tracker,py-root"
  "pytest.ini                         = py-core,py-monitor,py-tracker,py-infra,py-root,py-db"

  # ── tests
  "tests/conftest.py                  = py-core,py-monitor,py-tracker,py-infra,py-root,py-db,py-render"
  "tests/fixtures/*                   = py-core,py-monitor,py-tracker,py-infra,py-root"
  "tests/core/*                       = py-core"
  "tests/db/*                         = py-db"
  "tests/monitor/*                    = py-monitor"
  "tests/tracker/*                    = py-tracker"
  "tests/infra/test_render*           = py-render,py-infra"
  "tests/infra/*                      = py-infra"
  "tests/*.py                         = py-root"

  # ── CI
  ".github/workflows/*                = py-workflows,sysmap"

  # ── deliberately no suites. Prose. Every one of these is a decision, and the
  #    run prints it, so "nothing ran" is never silent.
  "docs/pilot-launch/evidence/ui-coverage.md = coverage-ledger"
  "docs/*                             = -"
  "references/*                       = -"
  "*.md                               = -"
  ".gitignore                         = -"
)

# Test hook: extra rules, ';'-separated, same 'pattern = suites' shape. Used by
# tests/core/test_verify_lane.py to prove a rule pointing at a suite that does
# not exist fails loudly instead of silently verifying nothing.
if [[ -n "${HQ_VERIFY_EXTRA_MAP:-}" ]]; then
  IFS=';' read -r -a _extra <<< "$HQ_VERIFY_EXTRA_MAP"
  path_map+=("${_extra[@]}")
fi

# ─────────────────────────────────────────────────────────── arguments
mode=fast; dry=0; use_image=0; since=""; explicit_paths=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --full)     mode=full ;;
    --fast)     mode=fast ;;
    --dry-run)  dry=1 ;;
    --image)    use_image=1 ;;
    --since)    since="$2"; shift ;;
    --since=*)  since="${1#--since=}" ;;
    -h|--help)  sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    --)         shift; explicit_paths+=("$@"); break ;;
    -*)         echo "unknown flag: $1" >&2; exit 2 ;;
    *)          explicit_paths+=("$1") ;;
  esac
  shift
done

# ─────────────────────────────────────────────────────────── registry checks
# Both directions, before anything runs.
fail_startup=0
in_registry() { local s; for s in "${suite_ids[@]}"; do [[ "$s" == "$1" ]] && return 0; done; return 1; }

for i in "${!suite_ids[@]}"; do
  t="${suite_target[$i]}"
  if [[ ! -e "$repo/$t" ]]; then
    echo "verify.sh: suite '${suite_ids[$i]}' points at '$t', which does not exist." >&2
    echo "           A suite that cannot be located cannot be run, and a lane that" >&2
    echo "           quietly drops it verifies nothing. Fix the registry." >&2
    fail_startup=1
  fi
done
for rule in "${path_map[@]}"; do
  rhs="${rule#*=}"; rhs="${rhs// /}"
  [[ "$rhs" == "-" ]] && continue
  IFS=',' read -r -a want <<< "$rhs"
  for s in "${want[@]}"; do
    [[ -z "$s" ]] && continue
    in_registry "$s" || {
      echo "verify.sh: path rule '${rule%%=*}' selects suite '$s', which is not in the registry." >&2
      echo "           Every mapped suite must exist. Refusing to run a map that would" >&2
      echo "           silently drop a suite." >&2
      fail_startup=1
    }
  done
done
[[ $fail_startup -eq 0 ]] || exit 3

# ─────────────────────────────────────────────────────────── changed paths
changed=()
if [[ ${#explicit_paths[@]} -gt 0 ]]; then
  changed=("${explicit_paths[@]}"); source_of_paths="arguments"
elif [[ -n "${HQ_VERIFY_PATHS:-}" ]]; then
  # newline-separated; how --image hands the host's git answer to the container
  while IFS= read -r line; do [[ -n "$line" ]] && changed+=("$line"); done <<< "$HQ_VERIFY_PATHS"
  source_of_paths="HQ_VERIFY_PATHS"
else
  base="${since:-}"
  if [[ -z "$base" ]]; then
    base=$(git -C "$repo" merge-base HEAD origin/main 2>/dev/null || echo "")
  fi
  if [[ -n "$base" ]]; then
    # No `mapfile`: macOS ships bash 3.2 and this lane has to work on the host
    # as well as inside the image.
    while IFS= read -r line; do
      [[ -n "$line" ]] && changed+=("$line")
    done < <(
      { git -C "$repo" diff --name-only "$base" 2>/dev/null
        git -C "$repo" diff --name-only 2>/dev/null
        git -C "$repo" diff --name-only --cached 2>/dev/null
        git -C "$repo" ls-files --others --exclude-standard 2>/dev/null
      } | sort -u
    )
    source_of_paths="git diff vs ${since:-merge-base with origin/main} + working tree"
  else
    source_of_paths="none (no git)"
  fi
fi

# ─────────────────────────────────────────────────────────── selection
declare -a selected=() reasons=()
select_suite() {  # id, reason
  local i
  for i in "${!selected[@]}"; do
    if [[ "${selected[$i]}" == "$1" ]]; then
      [[ "${reasons[$i]}" == *"$2"* ]] || reasons[$i]="${reasons[$i]}, $2"
      return
    fi
  done
  selected+=("$1"); reasons+=("$2")
}

fallback_reason=""
declare -a unmapped=() explicitly_none=()

if [[ "$mode" == "full" ]]; then
  for s in "${suite_ids[@]}"; do select_suite "$s" "--full"; done
else
  if [[ ${#changed[@]} -eq 0 ]]; then
    fallback_reason="no changed paths could be determined ($source_of_paths)"
  else
    for p in "${changed[@]}"; do
      matched=0
      for rule in "${path_map[@]}"; do
        pat="${rule%%=*}"; pat="${pat// /}"
        rhs="${rule#*=}"; rhs="${rhs// /}"
        # shellcheck disable=SC2053
        if [[ "$p" == $pat ]]; then
          matched=1
          if [[ "$rhs" == "-" ]]; then
            explicitly_none+=("$p ($pat)")
          else
            IFS=',' read -r -a want <<< "$rhs"
            for s in "${want[@]}"; do [[ -n "$s" ]] && select_suite "$s" "$pat"; done
          fi
          break   # first matching rule wins per path; order in path_map is the priority
        fi
      done
      [[ $matched -eq 1 ]] || unmapped+=("$p")
    done
    if [[ ${#unmapped[@]} -gt 0 ]]; then
      fallback_reason="unmapped path(s): ${unmapped[*]}"
    fi
  fi
  if [[ -n "$fallback_reason" ]]; then
    selected=(); reasons=()
    for s in "${suite_ids[@]}"; do select_suite "$s" "FULL fallback"; done
  fi
fi

# Collapse redundancies (only where the parent strictly contains the child).
is_selected() { local s; for s in "${selected[@]}"; do [[ "$s" == "$1" ]] && return 0; done; return 1; }
drop_suite() {
  local i out_s=() out_r=()
  for i in "${!selected[@]}"; do
    [[ "${selected[$i]}" == "$1" ]] && continue
    out_s+=("${selected[$i]}"); out_r+=("${reasons[$i]}")
  done
  selected=("${out_s[@]+"${out_s[@]}"}"); reasons=("${out_r[@]+"${out_r[@]}"}")
}
# Applied in --full too, because subsumption is coverage-preserving by
# construction: slop.spec.ts lives inside tests/e2e, test_migrations.py inside
# tests/core. Running both separately buys nothing and costs a second
# `next build && next start` — which is what timed out (playwright.config's
# 180 s webServer limit) on a loaded machine the first time --full ran here.
declare -a covered_by=()
if is_selected py-core; then
  for s in $subsumed_by_py_core; do is_selected "$s" && covered_by+=("$s (inside py-core)"); drop_suite "$s"; done
fi
if is_selected e2e; then
  for s in $subsumed_by_e2e; do is_selected "$s" && covered_by+=("$s (inside e2e)"); drop_suite "$s"; done
fi

# Registry order == cheap first, expensive last. Sort the selection into it.
declare -a ordered=() ordered_reasons=()
for s in "${suite_ids[@]}"; do
  for i in "${!selected[@]}"; do
    [[ "${selected[$i]}" == "$s" ]] && { ordered+=("$s"); ordered_reasons+=("${reasons[$i]}"); }
  done
done
selected=("${ordered[@]+"${ordered[@]}"}"); reasons=("${ordered_reasons[@]+"${ordered_reasons[@]}"}")

# ─────────────────────────────────────────────────────────── report the plan
hr() { printf '%s\n' "────────────────────────────────────────────────────────────────────────"; }
hr
if [[ "$mode" == "full" ]]; then
  echo "verify: FULL — every gate in the registry"
elif [[ -n "$fallback_reason" ]]; then
  echo "verify: FULL (fallback) — $fallback_reason"
  echo "        An unmapped path is not evidence of a small blast radius."
else
  echo "verify: PARTIAL (change-scoped) — this is NOT a full gate"
fi
echo "paths:  $source_of_paths (${#changed[@]} changed)"
if [[ ${#changed[@]} -gt 0 && ${#changed[@]} -le 40 ]]; then
  for p in "${changed[@]}"; do echo "          $p"; done
fi
if [[ ${#explicitly_none[@]} -gt 0 ]]; then
  echo "mapped to no suites (deliberate):"
  for p in "${explicitly_none[@]}"; do echo "          $p"; done
fi
echo
echo "RUNNING (${#selected[@]}):"
for i in "${!selected[@]}"; do printf '          %-16s  <- %s\n' "${selected[$i]}" "${reasons[$i]}"; done
echo
if [[ ${#covered_by[@]} -gt 0 ]]; then
  echo "FOLDED IN (${#covered_by[@]}) — run as part of a wider suite, not dropped:"
  for c in "${covered_by[@]}"; do echo "          $c"; done
  echo
fi
declare -a skipped=()
for s in "${suite_ids[@]}"; do
  is_selected "$s" && continue
  folded=0
  for c in "${covered_by[@]+"${covered_by[@]}"}"; do [[ "$c" == "$s "* ]] && folded=1; done
  [[ $folded -eq 1 ]] || skipped+=("$s")
done
if [[ ${#skipped[@]} -gt 0 ]]; then
  echo "SKIPPED (${#skipped[@]}) — no changed path maps to them:"
  echo "          ${skipped[*]}"
  echo
fi
hr

[[ $dry -eq 1 ]] && exit 0

# ─────────────────────────────────────────────────────────── --image re-exec
if [[ $use_image -eq 1 && "${HQ_TEST_IMAGE:-0}" != "1" ]]; then
  printf -v joined '%s\n' "${changed[@]+"${changed[@]}"}"
  export HQ_VERIFY_PATHS="$joined"
  args=(scripts/verify.sh)
  [[ "$mode" == "full" ]] && args+=(--full)
  exec "$repo/scripts/test-shell.sh" "${args[@]}"
fi

# ─────────────────────────────────────────────────────────── preconditions
# A gate that cannot run is a failure, not a skip. This is the whole difference
# between this script and the thing it replaces.
precondition_failed=0
needs_of() { local i; for i in "${!suite_ids[@]}"; do [[ "${suite_ids[$i]}" == "$1" ]] && { echo "${suite_needs[$i]}"; return; }; done; }
for s in "${selected[@]+"${selected[@]}"}"; do
  case "$(needs_of "$s")" in
    database)
      if [[ -z "${DATABASE_URL:-}" ]]; then
        echo "verify: '$s' needs DATABASE_URL and it is unset." >&2
        echo "        tests/db self-skips without it AND STILL REPORTS SUCCESS, so this" >&2
        echo "        refuses to run rather than hand you a green that means nothing." >&2
        echo "        Fix: scripts/verify.sh --image (Postgres 16 is already up in there)." >&2
        precondition_failed=1
      fi ;;
    linux-baselines)
      if [[ "${HQ_TEST_IMAGE:-0}" != "1" ]]; then
        echo "verify: '$s' compares against screenshot baselines recorded on linux in" >&2
        echo "        mcr.microsoft.com/playwright:v1.61.1-noble. Running it anywhere else" >&2
        echo "        compares font rasterisation, not your change." >&2
        echo "        Fix: scripts/verify.sh --image" >&2
        precondition_failed=1
      fi ;;
  esac
done
[[ $precondition_failed -eq 0 ]] || { echo; echo "verify: NOT RUN — a selected gate could not run. Nothing was verified." >&2; exit 4; }

# ─────────────────────────────────────────────────────────── run
cmd_of() { local i; for i in "${!suite_ids[@]}"; do [[ "${suite_ids[$i]}" == "$1" ]] && { echo "${suite_cmd[$i]}"; return; }; done; }
declare -a results=()
overall=0
started=$SECONDS
for s in "${selected[@]+"${selected[@]}"}"; do
  echo
  hr; echo "▶ $s"; hr
  t0=$SECONDS
  raw=$(cmd_of "$s")
  # The registry stores commands with $PYTEST311 etc. unexpanded (single-quoted
  # above) so the interpreter choice is made here, once, from HQ_TEST_IMAGE.
  # Each suite runs in its own subshell: a `cd webapp` cannot leak into the next.
  if ( eval "$raw" ); then
    st=PASS
  else
    st=FAIL; overall=1
  fi
  dt=$((SECONDS - t0))
  results+=("$(printf '%-16s %-4s %4ds' "$s" "$st" "$dt")")
done
elapsed=$((SECONDS - started))

echo; hr
echo "verify results  (${elapsed}s total)"
for r in "${results[@]+"${results[@]}"}"; do echo "  $r"; done
hr
if [[ "$mode" == "full" ]]; then
  if [[ $overall -eq 0 ]]; then
    echo "FULL GATE PASS — all ${#suite_ids[@]} registered suites ran and passed" \
         "(${#selected[@]} invocations; ${#covered_by[@]} folded into a wider suite)."
  else
    echo "FULL GATE FAIL."
  fi
else
  if [[ ${#selected[@]} -eq 0 ]]; then
    # "PASS" over an empty selection is the exact lie this script exists to avoid.
    echo "NOTHING RAN — every changed path maps to no suites. No verification was performed."
    echo "If that is wrong, the map is wrong: add a rule, or the change is prose."
  elif [[ $overall -eq 0 ]]; then
    echo "PARTIAL PASS — ${#selected[@]} of ${#suite_ids[@]} suites ran. THIS IS NOT A FULL GATE."
    [[ ${#skipped[@]} -gt 0 ]] && echo "Not run: ${skipped[*]}"
    echo "Before declaring done or opening a PR: scripts/verify.sh --full --image"
  else
    echo "PARTIAL FAIL — a change-scoped suite failed. Fix it before widening."
  fi
fi
hr
exit $overall
