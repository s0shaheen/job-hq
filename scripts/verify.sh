#!/usr/bin/env bash
# The verification lane: run the gates a change can possibly have broken.
#
#   scripts/verify.sh                  # fast lane, against the working tree
#   scripts/verify.sh --dry-run        # show the selection, run nothing
#   scripts/verify.sh --since origin/main
#   scripts/verify.sh --image          # run it all inside the prebuilt image
#   scripts/verify.sh --full --image   # the real thing, before a PR
#   scripts/verify.sh --print-ci-jobs  # which ci.yml jobs the diff can break
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
# id | target that must exist | command | needs | the CI JOB that runs it
#
# The target is not decoration. A rule that maps a path to a suite whose tests
# were deleted or renamed would silently verify nothing; the registry check turns
# that into a loud startup failure.
#
# THE FIFTH COLUMN is which job in .github/workflows/ci.yml executes this suite,
# and it is what makes CI and this lane one map instead of two. `--print-ci-jobs`
# resolves a diff to the set of CI jobs it can possibly have broken;
# scripts/ci-select.sh calls exactly that, and ci.yml gates each job on the
# answer. It is REQUIRED on every suite — a suite with no named job would be a
# suite CI silently never gates on, which is the whole defect class this column
# exists to make impossible. tests/core/test_ci_selection.py holds that line from
# the other side, against the workflow file itself.
suite_ids=(); suite_target=(); suite_cmd=(); suite_needs=(); suite_ci=()
suite() {
  suite_ids+=("$1"); suite_target+=("$2"); suite_cmd+=("$3")
  suite_needs+=("${4:-}"); suite_ci+=("${5:-}")
}

#      id               target                            command                                                                  needs             ci job
suite lint-copy        webapp/scripts/copy-lint          'cd webapp && npm run lint:copy'                                          ''                webapp
suite coverage-ledger  webapp/scripts/coverage-ledger.mjs 'cd webapp && npm run coverage:ledger && ledger_is_committed'            ''                webapp
suite lint-assert      scripts/assertion_lint.py         '$PY311 scripts/assertion_lint.py'                                        ''                tests
suite typecheck        webapp/tsconfig.json              'cd webapp && npm run typecheck'                                          ''                webapp
suite vitest           webapp/tests/unit                 'cd webapp && npm test'                                                   ''                webapp
suite py-core          tests/core                        '$PYTEST311 tests/core -q'                                                ''                tests
suite py-migrations    tests/core/test_migrations.py     '$PYTEST311 tests/core/test_migrations.py -q'                             ''                tests
suite py-workflows     tests/core/test_workflows.py      '$PYTEST311 tests/core/test_workflows.py -q'                              ''                tests
suite py-monitor       tests/monitor                     '$PYTEST311 tests/monitor -q'                                             ''                tests
suite py-tracker       tests/tracker                     '$PYTEST311 tests/tracker -q'                                             ''                tests
suite py-infra         tests/infra                       '$PYTEST311 tests/infra -q'                                               ''                tests
suite py-root          tests/test_runjob.py              '$PYTEST311 tests/test_runjob.py tests/test_sysmap.py tests/test_publish_to_drive.py -q' '' tests
suite sysmap           scripts/sysmap.py                 '$PY311 scripts/sysmap.py'                                                ''                tests
suite py-db            tests/db                          'HQ_REQUIRE_DB=1 $PYTEST311 tests/db -q'                                    database        db
# The pinned-mutant ledger: every T3/T4 guard, broken on purpose, its named test
# required to go red. It runs the named tests only, in a scratch worktree, and
# it needs the database for the seven database guards and a built webapp for the
# app-shell one — which is why it sits here, after py-db and before the browser
# suites, and declares the same `database` precondition.
suite mutants          tests/mutants/manifest.toml       '$PY311 scripts/mutants.py'                                                 database          mutants
# And the same ledger with nothing executed: does every pinned patch still
# apply? Sub-second, no database, no browser. It is mapped to every file a
# pinned mutant patches, because the way a mutant dies is that somebody edits
# the guard and the patch silently stops applying — and a mutant that stops
# running is the defect this whole ledger exists to catch, one level up.
suite mutants-dry      scripts/mutants.py                '$PY311 scripts/mutants.py --dry-run'                                       ''                mutants
suite py-render        tests/infra/test_render_live.py   'HQ_REQUIRE_RENDERCV=1 $PYTEST312 tests/infra/test_render_live.py tests/infra/test_render_guards.py -q -p no:cacheprovider' '' render
suite build            webapp/next.config.mjs            'cd webapp && npm run build'                                              ''                webapp
suite e2e-slop         webapp/tests/e2e/slop.spec.ts     'cd webapp && HQ_DEMO=1 npx playwright test tests/e2e/slop.spec.ts'       ''                webapp
suite e2e              webapp/tests/e2e                  'cd webapp && HQ_DEMO=1 npx playwright test'                              ''                webapp
suite e2e-visual       webapp/tests/e2e/visual.spec.ts   'cd webapp && HQ_DEMO=1 HQ_VISUAL=1 npx playwright test tests/e2e/visual.spec.ts'  linux-baselines  visual

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
# pattern -> suites, or '-' for "deliberately no suites", or '*' for "every suite
# in the registry". A path matching NOTHING here falls back to FULL. Patterns are
# bash [[ ]] globs, where * crosses '/'.
#
# Union, not first-match: a change touching two areas gets both areas' suites.
#
# WHY '*' EXISTS, AND WHY IT IS NOT THE SAME THING AS THE FALLBACK. Before it,
# the only way to reach every suite was to match NO rule — the full set was
# reachable only by failing. That is the right default for an unknown path and
# the wrong one for a KNOWN path whose blast radius is genuinely everything,
# because it forces a choice between naming the path (and under-selecting) or
# leaving it unnamed (and calling a deliberate decision an accident). The two
# print differently and must: the fallback says an unmapped path is not evidence
# of a small blast radius; '*' says the map looked at this path and decided.
path_map=(
  # ── webapp
  # e2e-visual here for the same reason it is on app/ and components/, one level
  # down: lib/ is where the rendered STRINGS come from. lib/display/dictionary.ts,
  # lib/format.ts and lib/dates.ts decide the text the baselined pages paint, and
  # webapp/tests/e2e/visual.spec.ts imports `@/lib/profile/draft` directly. An
  # import error there is caught by `e2e` (which collects visual.spec.ts too), but
  # a SEMANTIC change — "3 d ago" becoming "3 days ago" — moves pixels and nothing
  # else in the `webapp` job compares pixels. Skipping `visual` for lib/ would land
  # that on main and page the ops topic.
  "webapp/lib/*                       = typecheck,vitest,e2e-visual"
  # e2e-visual is in these two rows, and was not before this became CI's map too.
  # The pixel baselines are of RENDERED PAGES: app/ and components/ are the files
  # that decide what those pixels are, and app/globals.css — which matches
  # `webapp/app/*` — decides it for every page at once. Without this rule, porting
  # the map to CI would have stopped running the `visual` job for exactly the
  # changes that move pixels, which is not an economy, it is a hole. It was
  # survivable while this map only chose a LOCAL lane, because the local lane
  # cannot run e2e-visual off the linux baselines anyway and CI ran it
  # unconditionally. CI no longer does.
  # A pinned mutant patches this exact file
  # (tests/mutants/patches/today-row-button-decides-the-selection.patch), and the
  # way a mutant dies is that somebody edits the guard until the patch stops
  # applying. `webapp/app/*` below carries no mutant suite, so without this row an
  # edit here skipped the `mutants` job entirely and the ledger rotted silently
  # until the next push to main. Named file rather than widening `webapp/app/*`:
  # app/ is the most-edited directory in the repo and mutants-dry resolves to the
  # 4-minute `mutants` CI job, so widening it would tax every surface change for
  # one file. tests/core/test_ci_selection.py::
  # test_every_pinned_mutant_target_reaches_the_mutants_job is what keeps this row
  # honest when the ledger gains a patch against a new path.
  "webapp/app/(app)/queue/today-list.tsx = typecheck,vitest,lint-copy,coverage-ledger,build,e2e-slop,e2e,e2e-visual,mutants-dry"
  "webapp/app/*                       = typecheck,vitest,lint-copy,coverage-ledger,build,e2e-slop,e2e,e2e-visual"
  "webapp/components/*                = typecheck,vitest,lint-copy,coverage-ledger,build,e2e-slop,e2e,e2e-visual,mutants-dry"
  "webapp/middleware.ts               = typecheck,vitest,build,e2e"
  "webapp/tests/unit/*                = typecheck,vitest"
  "webapp/tests/e2e/visual.spec.ts*   = e2e-visual"
  # The shot helper and the reporter that prints its counts. Two suites the row
  # below does not reach, and the union is what makes naming them here enough:
  #   e2e-visual  every shot goes through the helper and the config loads the
  #               reporter. `e2e` runs visual.spec.ts too, but WITHOUT HQ_VISUAL,
  #               so it skips the whole file and reports green on a helper that
  #               cannot take a screenshot.
  #   vitest      tests/unit/visual-budget.test.ts reads the helper's SOURCE —
  #               the zero-probe rule is asserted against these bytes, so a
  #               change here turns that suite red with no test file touched.
  #               Same shape as the db/migrations row below, same reason.
  "webapp/tests/e2e/visual-diff*      = typecheck,vitest,e2e-visual"
  "webapp/tests/e2e/*                 = typecheck,e2e"
  # e2e-visual: under HQ_DEMO the baselined pages are RENDERING this fixture data,
  # so a changed row changes the screenshot. visual.spec.ts also reads
  # tests/fixtures/import/wide-60.xlsx directly.
  "webapp/tests/fixtures/*            = vitest,e2e,e2e-visual"
  # vitest too, and not only the ledger run: tests/unit/coverage-ledger.test.ts
  # is what proves the GATE can fail — it feeds report.ts a broken citation and a
  # new missing cell. Mapped to coverage-ledger alone, a change to report.ts
  # regenerated the ledger and never ran the test that watches the gate work.
  "webapp/tests/coverage/*            = coverage-ledger,typecheck,vitest"
  # The live-data lane's harness. `vitest` is the load-bearing entry, not
  # `typecheck`: tests/unit/live-lane.test.ts is what proves the production
  # refusal and the demanded-but-missing error can FAIL, and the lane itself
  # cannot run here — it needs a Supabase project this box does not have. `e2e`
  # because playwright.config.ts imports tests/live/env.ts at config load, so a
  # syntax error there breaks the fixture lane too — and `e2e-visual` for exactly
  # that reason again: the `visual` job loads the SAME config, in a different
  # container, so the config chain has to select it or the reasoning only covers
  # one of the two lanes it applies to.
  "webapp/tests/live/*                = typecheck,vitest,e2e,e2e-visual"
  "webapp/scripts/*                   = lint-copy,coverage-ledger"
  "webapp/package.json                = typecheck,vitest,build,e2e,e2e-visual"
  "webapp/package-lock.json           = typecheck,vitest,build,e2e,e2e-visual"
  "webapp/tsconfig.json               = typecheck,vitest,build"
  "webapp/next.config.mjs             = typecheck,build,e2e,e2e-visual"
  "webapp/postcss.config.mjs          = build,e2e,e2e-visual"
  "webapp/vitest.config.mts           = vitest"
  # vitest: tests/unit/visual-budget.test.ts reads THIS file's source and is the
  # only thing that fails when the diff budget goes back to a ratio or the
  # per-pixel threshold goes missing — neither of which makes any pixel run red,
  # which is the whole point of that test. Mapping the config to everything but
  # the suite that reads it is the same gap the db/migrations row below names.
  "webapp/playwright.config.ts        = vitest,e2e,e2e-visual"

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
  "db/migrations/*                    = py-db,py-migrations,vitest,mutants-dry"
  "db/*                               = py-db,py-migrations,vitest"
  "supabase/*                         = py-db,py-migrations,vitest"

  # ── python packages
  # core/ is imported by monitor, tracker and the db write path, so a change
  # there is not local to core/.
  "core/*                             = py-core,py-monitor,py-tracker,py-db,py-root"
  "monitor/*                          = py-monitor"
  "tracker/*                          = py-tracker"
  "infra/render/*                     = py-render,py-infra,mutants-dry"
  "infra/terraform/*                  = py-infra,sysmap"
  "infra/alerter/*                    = py-infra"
  "infra/app/*                        = py-infra"
  "infra/Dockerfile                   = py-infra"
  "infra/test-image/*                 = py-core"     # tests/core/test_verify_lane.py
  "scripts/sysmap.py                  = py-root,sysmap"
  # The lint and its baseline both select py-core, which is where
  # tests/core/test_assertion_lint.py proves the lint can fail. A rule that
  # ran the lint but not the test that watches the lint work is the same hole
  # the coverage-ledger row above was widened to close.
  "scripts/assertion_lint.py          = lint-assert,py-core,py-root"
  "scripts/assertion_lint_baseline.json = lint-assert,py-core"
  # land.sh (the only merge path) and new-migration.sh are both asserted on by
  # tests/core/test_migrations.py — the migration-ledger rules live there.
  "scripts/land.sh                    = py-migrations,py-root,mutants-dry"
  "scripts/new-migration.sh           = py-migrations,py-root"
  "scripts/mutants.py                 = mutants,py-core"
  "tests/mutants/*                    = mutants,py-core"
  "tests/core/test_mutant_ledger.py   = mutants,py-core"
  "scripts/verify.sh                  = py-core,py-workflows"
  # The selector CI runs. It is the one file that can make every other job skip,
  # so it selects the suite that proves it cannot (tests/core/test_ci_selection.py)
  # AND py-workflows, which reads ci.yml from the other side.
  "scripts/ci-select.sh               = py-core,py-workflows,py-root"
  "scripts/test-shell.sh              = py-core"
  "scripts/*                          = py-root"
  "requirements.txt                   = py-core,py-monitor,py-tracker,py-infra,py-root,py-db"
  "hq.config.yaml                     = py-core,py-monitor,py-tracker,py-root"
  "pytest.ini                         = py-core,py-monitor,py-tracker,py-infra,py-root,py-db"

  # ── tests
  "tests/conftest.py                  = py-core,py-monitor,py-tracker,py-infra,py-root,py-db,py-render,lint-assert"
  "tests/fixtures/*                   = py-core,py-monitor,py-tracker,py-infra,py-root,lint-assert"
  "tests/core/*                       = py-core,lint-assert"
  "tests/db/*                         = py-db,lint-assert"
  "tests/monitor/*                    = py-monitor,lint-assert"
  "tests/tracker/*                    = py-tracker,lint-assert"
  "tests/infra/test_render*           = py-render,py-infra,lint-assert"
  "tests/infra/*                      = py-infra,lint-assert"
  "tests/*.py                         = py-root,lint-assert"

  # ── CI
  #
  # ci.yml is the file that decides what runs at all, so the only honest answer
  # for it is everything. py-workflows and sysmap read this file as TEXT: they
  # catch a job with no registry entry or a selection wired to the wrong output,
  # and they are blind to every way a job can break when it actually executes.
  # Change `--shard=${{ matrix.shard }}/2` to `/3`, or bump an action to a version
  # whose install fails, and a rule of `py-workflows,sysmap` means the pull request
  # never runs the job it just edited: green, landed, and red on main a minute
  # later with the ops topic paged. This is the row '*' was added for — the
  # blast radius is known and it is total, which is a decision, not an unmapped
  # path. The other workflows keep the narrow rule: deploy.yml and red-main.yml
  # do not decide what CI runs.
  ".github/workflows/ci.yml           = *"
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
mode=fast; dry=0; use_image=0; since=""; print_ci=0; explicit_paths=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --full)     mode=full ;;
    --fast)     mode=fast ;;
    --dry-run)  dry=1 ;;
    # Resolve the diff to the .github/workflows/ci.yml JOBS it can have broken,
    # one per line on stdout, and run nothing. Everything else this script prints
    # goes to stderr under this flag so the answer is machine-readable while the
    # reasoning stays in the CI log. scripts/ci-select.sh is the only caller.
    --print-ci-jobs) print_ci=1; dry=1 ;;
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
  # A suite with no CI job is a suite CI never gates on. That is not a small
  # omission — it is a whole registered gate that a pull request can skip past
  # while every check reports green, which is the failure this column exists to
  # make impossible. Refuse at startup rather than resolve to a quietly smaller
  # job set later.
  if [[ -z "${suite_ci[$i]}" ]]; then
    echo "verify.sh: suite '${suite_ids[$i]}' names no CI job (5th column of the registry)." >&2
    echo "           Every suite must say which .github/workflows/ci.yml job runs it," >&2
    echo "           or --print-ci-jobs would silently under-select and CI would skip it." >&2
    fail_startup=1
  fi
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
  # QUOTED on purpose. In [[ ]] the right-hand side is a PATTERN unless it is
  # quoted, and an unquoted * matches every rhs there is — which would skip the
  # registry check for the whole map and let a typo'd suite name through silently.
  [[ "$rhs" == '*' ]] && continue
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
sentinel_reason=""
declare -a unmapped=() explicitly_none=() sentinel_hits=()

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
          elif [[ "$rhs" == '*' ]]; then
            # Quoted for the same reason as the registry check above.
            sentinel_hits+=("$p ($pat)")
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
    if [[ ${#sentinel_hits[@]} -gt 0 ]]; then
      sentinel_reason="${sentinel_hits[*]}"
    fi
  fi
  # Both expand to the same set and they are still kept apart, because the two
  # say different things to whoever reads the log. The fallback is "I do not know
  # what this path can break"; the sentinel is "I know, and it is everything."
  # Collapsing them would make a deliberate rule indistinguishable from a hole in
  # the map, which is exactly the confusion the map exists to remove.
  if [[ -n "$fallback_reason" ]]; then
    selected=(); reasons=()
    for s in "${suite_ids[@]}"; do select_suite "$s" "FULL fallback"; done
  elif [[ -n "$sentinel_reason" ]]; then
    selected=(); reasons=()
    for s in "${suite_ids[@]}"; do select_suite "$s" "EVERY suite (map rule '= *')"; done
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
#
# Under --print-ci-jobs the plan is still printed in full — it is the reasoning a
# CI log has to show for "the browser suite did not run" to be readable — but it
# goes to stderr, so stdout carries the job names and nothing else. fd 3 keeps a
# handle on the real stdout for the answer at the bottom.
if [[ $print_ci -eq 1 ]]; then exec 3>&1 1>&2; fi
hr() { printf '%s\n' "────────────────────────────────────────────────────────────────────────"; }
hr
if [[ "$mode" == "full" ]]; then
  echo "verify: FULL — every gate in the registry"
elif [[ -n "$fallback_reason" ]]; then
  echo "verify: FULL (fallback) — $fallback_reason"
  echo "        An unmapped path is not evidence of a small blast radius."
elif [[ -n "$sentinel_reason" ]]; then
  # The sentinel says WHICH path and WHICH rule did it. A selection that silently
  # expanded to everything would be the same opacity as one that silently shrank:
  # this lane's whole contract is that it prints what ran, what did not, and why.
  echo "verify: FULL (by rule) — $sentinel_reason selects EVERY suite"
  echo "        Not the fallback. The map names this path and says its blast radius"
  echo "        is the whole registry — see the '= *' row in path_map."
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

ci_of() { local i; for i in "${!suite_ids[@]}"; do [[ "${suite_ids[$i]}" == "$1" ]] && { echo "${suite_ci[$i]}"; return; }; done; }

if [[ $print_ci -eq 1 ]]; then
  # Subsumption is safe to read through here because a child and the parent that
  # contains it always name the SAME CI job — tests/core/test_ci_selection.py
  # asserts that, so folding e2e-slop into e2e can never fold away the `webapp`
  # job with it.
  declare -a ci_jobs=()
  for s in "${selected[@]+"${selected[@]}"}"; do
    j="$(ci_of "$s")"
    [[ -z "$j" ]] && continue          # unreachable: the startup check refuses it
    seen=0
    for x in "${ci_jobs[@]+"${ci_jobs[@]}"}"; do [[ "$x" == "$j" ]] && seen=1; done
    [[ $seen -eq 0 ]] && ci_jobs+=("$j")
  done
  echo "CI JOBS (${#ci_jobs[@]}): ${ci_jobs[*]:-<none>}"
  for j in "${ci_jobs[@]+"${ci_jobs[@]}"}"; do printf '%s\n' "$j" >&3; done
  exit 0
fi

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

# ─────────────────────────────────────────────────────────── serialize
#
# One heavy verification run at a time, per machine.
#
# The loop this breaks, measured on 2026-08-02: two full gates overlap, the
# 14-core box goes to a load average near 100, timing-sensitive Playwright specs
# fail at random, somebody re-runs to find out whether the failure was real, and
# the re-run is itself more load. It cost several hours and — worse — it hid a
# GENUINE mobile regression behind four rounds of plausible noise, because every
# failure had an innocent explanation available.
#
# A lock, not a concurrency limit: a second run WAITS rather than failing, so an
# agent that starts one is never punished for another agent's timing. `flock` is
# not on macOS, so the lock is a directory — `mkdir` is atomic on every
# filesystem this runs on, which a lockfile written with `>` is not. The PID is
# recorded so a stale lock names its owner, and a lock whose owner is gone is
# reclaimed rather than waited on forever.
#
# Scoped to the heavy modes. A change-scoped run of two fast suites has no
# business queueing behind a full gate, and serializing those would remove the
# entire point of the fast lane.
#
# ── how this composes with the test-shell.sh semaphore ──────────────────────
#
# scripts/test-shell.sh enforces a machine-wide 2-slot limit on CONTAINERS,
# because that is the layer heavy work actually passes through: a bare
# `test-shell.sh pytest ...`, a `--update-snapshots` playwright run, or an
# ad-hoc `docker run postgres:16` never reaches this lock at all. This lock
# stays, but a run holds exactly ONE of the two, never both:
#
#   --image, on the host   the re-exec above happens BEFORE this section, so
#                          this lock is never taken. The slot test-shell.sh
#                          acquires is the only limit, which is correct — this
#                          process becomes the container.
#   inside the image       skipped, below. A slot is ALREADY held on our behalf
#                          by the host test-shell.sh that started this
#                          container, so taking this lock too would spend the
#                          budget twice for one container.
#   no Docker at all       taken as before. This path starts no container and
#                          so spends nothing from the semaphore; without this
#                          lock two host-native full gates would still overlap.
#
# What breaks if the inner run is NOT skipped: today it is harmless only by
# accident, because a container's /tmp is its own and the lock therefore matches
# nothing. Bind-mount /tmp — which any future "share the verify cache" change
# would reach for — and it becomes a true self-deadlock: the outer test-shell.sh
# holds the slot the inner verify.sh's lock owner is waiting behind, and neither
# side can make progress. Skipping explicitly makes the property hold by design
# instead of by an environment detail nobody wrote down.
LOCK_DIR="${HQ_VERIFY_LOCK:-${TMPDIR:-/tmp}/hq-verify.lock}"
lock_held=0
release_lock() { [[ "$lock_held" == 1 ]] && rm -rf "$LOCK_DIR"; }

heavy=0
[[ "$mode" == "full" ]] && heavy=1
for _s in "${selected[@]+"${selected[@]}"}"; do
  case "$_s" in e2e|e2e-visual|e2e-slop|build) heavy=1 ;; esac
done

[[ "${HQ_TEST_IMAGE:-0}" == "1" ]] && heavy=0   # a slot is already held for us

if [[ "$heavy" == 1 && "${HQ_VERIFY_NO_LOCK:-0}" != "1" ]]; then
  waited=0
  until mkdir "$LOCK_DIR" 2>/dev/null; do
    owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo '')"
    if [[ -n "$owner" ]] && ! kill -0 "$owner" 2>/dev/null; then
      echo "verify: reclaiming a lock whose owner (pid $owner) is gone" >&2
      rm -rf "$LOCK_DIR"; continue
    fi
    if [[ "$waited" == 0 ]]; then
      echo "verify: another heavy run holds the lock (pid ${owner:-unknown}); waiting." >&2
      echo "        Concurrent full gates make timing tests fail at random, which costs" >&2
      echo "        more to disprove than the parallelism saves. HQ_VERIFY_NO_LOCK=1 opts out." >&2
    fi
    sleep 5; waited=$((waited + 5))
    if (( waited % 300 == 0 )); then echo "verify: still waiting (${waited}s)" >&2; fi
  done
  lock_held=1
  printf '%s' "$$" > "$LOCK_DIR/pid"
  trap release_lock EXIT INT TERM
  [[ "$waited" -gt 0 ]] && echo "verify: lock acquired after ${waited}s" >&2
fi

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
