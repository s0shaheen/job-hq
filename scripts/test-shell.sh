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

# A worktree's `.git` is a FILE holding `gitdir: <abs path into the parent>`, so
# git inside the container resolves that pointer and lands outside the /repo
# mount. This block makes the pointer resolve.
#
# It used to be true that nothing in here needed git — verify.sh resolves the
# changed paths on the host and passes them in through HQ_VERIFY_PATHS, and that
# is still the rule for the LANE. It stopped being true for the SUITE in #166,
# which added tests/core/test_no_absolute_symlinks.py: it shells out to
# `git ls-tree -r HEAD` because a symlink's target is its committed content, and
# it deliberately refuses to pass on a tree it cannot read. Correct of the test.
# The result was that `--full --image` could not pass from ANY linked worktree —
# i.e. from any delegated agent — for a reason no branch could fix, on a run
# where everything else was green. That is exactly the shape that tempts a
# "green apart from an unrelated failure" summary, which is how two false gate
# claims were made earlier the same day.
#
# So: mount the parent `.git` at the SAME absolute path the pointer names, and
# read-only, because nothing in the container has any business writing to it.
gitmount=()
if [[ -f "$repo/.git" ]]; then
  parent_gitdir="$(sed -n 's/^gitdir: //p' "$repo/.git")"
  # `.git/worktrees/<name>` → the parent repository's `.git`.
  parent_git="${parent_gitdir%/worktrees/*}"
  if [[ -n "$parent_git" && -d "$parent_git" ]]; then
    gitmount=(-v "$parent_git:$parent_git:ro")
  else
    echo "[test-shell] WARNING: $repo/.git points at '$parent_gitdir', which is not" >&2
    echo "[test-shell] a worktree gitdir. Suites that shell out to git will fail." >&2
  fi
fi
# ─────────────────────────────────────────────────── reap what died before us
#
# `--rm` removes a container when it EXITS. It does nothing for a container
# whose driving agent was killed mid-run, and those accumulate: by 2026-08-03
# five orphaned postgres and image containers had Docker's VM at 761% CPU and
# the machine at load 317, which stalled six agents at once. It had been
# cleaned by hand three times before anyone made it stop happening.
#
# So: every container this script starts carries a label, and every run reaps
# labelled containers older than an hour before starting its own. An hour is
# comfortably longer than the slowest full gate and far shorter than a session,
# so a live run is never touched and a corpse never survives the next run.
if command -v docker >/dev/null 2>&1; then
  # Two filters, because two things leak. The label covers what this script
  # starts; the `hq-*` name covers the throwaway postgres a task spins up by
  # hand — `docker run -d --rm --name hq-something postgres:16` is the idiom
  # every db-touching brief uses, and those were the actual corpses.
  #
  # Age is computed from `State.StartedAt`, NOT from a `ps --filter until=`:
  # that filter exists for `container prune` and `docker ps` rejects it
  # outright. Found by probing rather than by reading, which is the only reason
  # this reaper does not silently match nothing forever.
  cutoff=$(( $(date +%s) - 3600 ))
  stale=""
  for c in $( { docker ps -q --filter "label=hq-test-harness=1" 2>/dev/null || true
                docker ps -q --filter "name=^hq-" 2>/dev/null || true; } | sort -u ); do
    started="$(docker inspect -f '{{.State.StartedAt}}' "$c" 2>/dev/null || true)"
    [ -z "$started" ] && continue
    # TZ=UTC on both arms. Docker reports StartedAt in UTC and `date -j` parses
    # in LOCAL time, so without this a container started seconds ago measured as
    # five hours in the FUTURE on US Central. That failed safe — it reaps late,
    # never early — which is exactly why it would have gone unnoticed.
    epoch="$(TZ=UTC date -j -f '%Y-%m-%dT%H:%M:%S' "${started%%.*}" +%s 2>/dev/null \
             || TZ=UTC date -d "${started}" +%s 2>/dev/null || echo 0)"
    [ "$epoch" -gt 0 ] && [ "$epoch" -lt "$cutoff" ] && stale="$stale $c"
  done
  if [ -n "$stale" ]; then
    echo "[test-shell] reaping $(printf '%s\n' "$stale" | wc -l | tr -d ' ') orphaned container(s) older than 1h" >&2
    docker rm -f $stale >/dev/null 2>&1 || true
  fi
fi

# ──────────────────────────────────────────── the machine-wide concurrency limit
#
# The reaper above deals with containers that DIED. This deals with containers
# that are all alive at once, which is the more expensive failure.
#
# MEASURED on this machine, 2026-08-03, during the incident itself:
#
#   host              14 cores, 48 GB
#   Docker VM         14 CPUs, 7.75 GiB  <- the budget, and it is much smaller
#                                           than the host's; the VM is the thing
#                                           that runs out, not the Mac
#   one hq-test       415-533% CPU and ~2.0-2.1 GiB RSS while a suite is hot
#   container         (65-99% / ~90 MiB between phases, which is why sampling
#                     once and dividing gives a number that is far too small)
#
# So MEMORY was the binding constraint, not CPU: 7.75 GiB / 2.1 GiB = 3.7
# containers before the VM starts OOM-killing, and three already saturate its 14
# CPUs at ~1400%. Two cost ~1066% CPU and ~4.2 GiB, which leaves a whole
# container's worth of slack for the postgres sidecars every db-touching brief
# spins up and for the VM's own overhead. Hence 2.
#
# RE-DERIVED 2026-08-03, later the same day, because the allocation changed —
# which the paragraph above said to do rather than assume the number tracks
# anything. The VM went 7.75 GiB -> 23.4 GiB (swap 1 -> 4 GiB); CPUs unchanged
# at 14. **The binding constraint inverted.**
#
#   memory   23.4 GiB / 2.1 GiB   = 11 containers   <- no longer the limit
#   CPU      14 cores / ~4.7 hot  = 3 containers    <- now the limit
#
# Four, not eleven. The reason is the failure this semaphore exists to prevent,
# which was never "the machine is slow" — it was that contention makes a
# timing-sensitive suite fail at random, and proving such a failure is not real
# costs more than the parallelism saved. CPU oversubscription produces exactly
# that, so buying throughput past the core count buys back the original problem
# wearing a different number.
#
# Four is ~1880% of the VM's ~1400% at peak, i.e. 1.34x oversubscribed — mild,
# and covered by the troughs: a container sits at 65-99% between phases (npm
# install, browser start, waits), so the hot figure is not the average. Memory
# at four is ~8.4 GiB used of 23.4, leaving real slack for the postgres
# sidecars. If the CPU count ever changes, re-derive again; this number now
# tracks cores, which is the opposite of what it tracked this morning.
#
# The observed cost of NOT having this: four concurrent hq-test containers put
# the machine at load 134 with the VM process at 1074% CPU. The previous round
# reached load 317 and stalled six agents at once, and a stalled agent loses its
# context and its uncommitted work. That is the most expensive failure mode this
# project has.
#
# WHY HERE AND NOT IN verify.sh. verify.sh already takes a machine-wide lock,
# but only around its own heavy selections, so it is on the wrong layer: agents
# legitimately run heavy work that never goes through it —
# `scripts/test-shell.sh pytest ...`, a `--update-snapshots` playwright run, an
# ad-hoc `docker run postgres:16`. This script is where a container is actually
# started, so it is where the budget can be enforced.
#
# HOW IT COMPOSES WITH verify.sh's LOCK. The rule is that a run holds exactly
# one of the two, never both:
#
#   verify.sh --image (host)   execs into this script at its --image re-exec,
#                              which happens BEFORE its lock section. It holds
#                              nothing; the slot taken here is the only limit.
#   verify.sh in the image     skips its lock entirely (HQ_TEST_IMAGE=1). The
#                              slot is already held by the test-shell.sh on the
#                              host that started this container.
#   verify.sh, no Docker       keeps its own 1-slot lock. It starts no container,
#                              so it spends nothing from this budget.
#
# What breaks under the alternative: if verify.sh took its lock and THEN called
# this script, one machine-wide mutex would be held across a region that also
# needs a slot from a 2-slot semaphore. The budget would collapse to 1 — every
# `--image` run serialised behind every other, which removes the point of the
# fast lane — and worse, the verify.sh running INSIDE the container would queue
# on a lock it cannot see the holder of (its /tmp is container-local today, but
# anyone bind-mounting /tmp turns that into a genuine self-deadlock: the outer
# process holds the lock the inner one is waiting for, and neither can exit).
# Hence the inner run is made to skip explicitly rather than to work by accident.
slots="${HQ_TEST_SLOTS:-4}"
sem_dir="${HQ_TEST_SLOTS_DIR:-${TMPDIR:-/tmp}/hq-test-slots}"
held_slot=""

# A budget that is not a positive integer would make the acquire loop scan an
# empty range and wait forever, announcing "0 of 0 slots are busy". That is a
# silent hang wearing this script's own uniform — the precise failure the
# visible-waiting output exists to rule out — so it refuses instead of guessing.
# (An UNSET or empty variable is not this case: `:-` already gives it 2.)
if ! [[ "$slots" =~ ^[0-9]+$ ]] || [[ "$slots" -lt 1 ]]; then
  echo "[test-shell] HQ_TEST_SLOTS=$slots is not a positive integer." >&2
  echo "[test-shell]   It is a count of concurrent containers, so 0 or a word would" >&2
  echo "[test-shell]   queue this run behind a slot that can never exist. Refusing" >&2
  echo "[test-shell]   rather than hanging. Unset it for the default of 2." >&2
  exit 2
fi

release_slot() { [ -n "$held_slot" ] && rm -rf "$held_slot"; held_slot=""; }

slot_age() {  # seconds since this slot was created; 0 if unknown
  local t
  t=$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0)
  [ "$t" = 0 ] && { echo 0; return; }
  echo $(( $(date +%s) - t ))
}

acquire_slot() {
  mkdir -p "$sem_dir" 2>/dev/null || true
  local i slot owner busy waited=0 announced=0
  while :; do
    for (( i = 0; i < slots; i++ )); do
      slot="$sem_dir/slot.$i"
      # `mkdir` is the atomic primitive. A lockfile written with `>` is not:
      # two shells can both create it and both believe they won. `flock` is not
      # on macOS, so this is the portable one.
      if mkdir "$slot" 2>/dev/null; then
        printf '%s' "$$" > "$slot/pid"
        held_slot="$slot"
        trap release_slot EXIT INT TERM
        [ "$waited" -gt 0 ] && echo "[test-shell] slot $i acquired after ${waited}s" >&2
        return 0
      fi
      # Crash safety. An agent killed mid-run never runs its trap, so the slot
      # dir survives it. The PID inside names the holder, and a holder that is
      # gone cannot be waited on — reclaim rather than leak the slot forever.
      owner="$(cat "$slot/pid" 2>/dev/null || true)"
      if [ -n "$owner" ]; then
        if ! kill -0 "$owner" 2>/dev/null; then
          echo "[test-shell] reclaiming slot $i: holder (pid $owner) is gone" >&2
          rm -rf "$slot"
        fi
      elif [ "$(slot_age "$slot")" -gt 60 ]; then
        # mkdir'd but no pid: normally an acquirer microseconds ahead of us, so
        # treat it as BUSY. Only after a minute is it the other case — a process
        # that died between the mkdir and the write. Reclaiming a young one
        # would race a live acquirer into over-admission, which is the exact
        # thing this file exists to prevent.
        echo "[test-shell] reclaiming slot $i: created but never claimed" >&2
        rm -rf "$slot"
      fi
    done

    # Waiting must be VISIBLE. A silent wait is indistinguishable from a stall,
    # and this project has already misdiagnosed one as the other.
    if [ "$announced" = 0 ]; then
      busy=""
      for (( i = 0; i < slots; i++ )); do
        busy="$busy $(cat "$sem_dir/slot.$i/pid" 2>/dev/null || echo '?')"
      done
      echo "[test-shell] QUEUED: all $slots of $slots slots are busy (holder pids:$busy)" >&2
      echo "[test-shell]   Waiting for a slot. This is NOT a hang. Heavy suites are" >&2
      echo "[test-shell]   capped because four at once put this machine at load 134" >&2
      echo "[test-shell]   and stalled the agents driving them." >&2
      echo "[test-shell]   HQ_TEST_SLOTS=N raises the cap; HQ_TEST_NO_SLOT=1 opts out." >&2
      announced=1
    fi
    # The re-announce interval is a knob only so the test suite can prove the
    # periodic line exists without waiting half a minute for it.
    sleep 2; waited=$((waited + 2))
    if (( waited % ${HQ_TEST_SLOT_TICK:-30} == 0 )); then
      echo "[test-shell] still queued after ${waited}s ($slots of $slots slots busy)" >&2
    fi
  done
}

if [ "${HQ_TEST_NO_SLOT:-0}" = "1" ]; then
  # The escape hatch, and a loud one. An unannounced bypass is how a limit
  # decays into a limit nobody notices is off.
  echo "[test-shell] WARNING: concurrency limit BYPASSED (HQ_TEST_NO_SLOT=1)." >&2
  echo "[test-shell]   This run is not counted against the $slots-slot budget and" >&2
  echo "[test-shell]   does not wait for one. Intended for a genuinely short run." >&2
elif [ $# -eq 0 ] && [ -t 0 ] && [ -t 1 ]; then
  # An interactive shell can sit open for hours while costing nothing. Holding a
  # slot for that long starves real runs, and its cost is whatever you type into
  # it, which this script cannot bound anyway.
  echo "[test-shell] interactive shell: not taking a slot (its cost is what you run in it)." >&2
else
  acquire_slot
fi

args=(--rm --init
  --label hq-test-harness=1
  -v "$repo:/repo"
  -v "$vol:/repo/webapp/node_modules"
  -v "hq-test-next-$want-$checkout_key:/repo/webapp/.next"
  -w /repo
  -e "HQ_VERIFY_PATHS=${HQ_VERIFY_PATHS:-}"
  -e "HQ_DEMO=${HQ_DEMO:-}"
  -e "HQ_VISUAL=${HQ_VISUAL:-}"
  -e "HQ_E2E_PORT=${HQ_E2E_PORT:-}"
)
args+=("${gitmount[@]+"${gitmount[@]}"}")
[[ -t 0 && -t 1 ]] && args+=(-it)

# Deliberately NOT `exec`. This shell has to outlive the container so its EXIT
# trap can hand the slot back the moment the run finishes. Under `exec` the slot
# dir would survive every run and only be recovered later by another waiter's
# dead-PID reclaim — correct, but it turns a free slot into one that looks busy
# until somebody polls it. The exit status is propagated by hand instead.
status=0
if [[ $# -eq 0 ]]; then
  docker run "${args[@]}" "$img" bash || status=$?
# One argument that looks like a shell line ("cd webapp && npm test") is run as
# one. Anything else is argv, so a filename with a space still works.
elif [[ $# -eq 1 && "$1" == *" "* ]]; then
  docker run "${args[@]}" "$img" bash -lc "$1" || status=$?
else
  docker run "${args[@]}" "$img" bash -lc 'exec "$@"' _ "$@" || status=$?
fi
exit $status
