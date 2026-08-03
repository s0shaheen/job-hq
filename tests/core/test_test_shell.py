"""`scripts/test-shell.sh` mounts the right volumes, or two agents corrupt each other.

The script runs a command inside the prebuilt verification image against THIS
checkout, shadowing two paths with container-local volumes. How those volumes are
KEYED is the whole safety property, and it is invisible: a wrong key does not
error, it silently hands one checkout another checkout's build output.

  webapp/.next        must be keyed by the CHECKOUT (and the image hash). Its
                      contents belong to one branch. On 2026-08-02 two concurrent
                      `--image` runs in different worktrees shared one `.next`
                      volume and wrote each other's generated route types; the
                      loser failed `typecheck` and `e2e-visual` on modules its own
                      tree did not contain, and a reviewer read the result as a
                      stale checkout artifact — which is exactly what
                      cross-contamination looks like from inside.

  webapp/node_modules must be keyed by the IMAGE HASH only. It is a function of
                      the lockfile, which the hash already covers, so sharing it
                      across checkouts is correct and re-installing per worktree
                      would be pure cost.

Docker is never invoked: a stub on PATH records the `docker run` argv, which is
the only thing being asserted. Runs in the plain 3.11 suite (`pytest tests/core`).
"""
from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "test-shell.sh"

# `docker image inspect` must succeed (so the script does not bail early or warn),
# and `docker run` must record its argv instead of running anything.
DOCKER_STUB = r"""#!/usr/bin/env bash
if [ "$1" = "image" ]; then exit 0; fi
if [ "$1" = "run" ]; then printf '%s\n' "$*" > "$DOCKER_LOG"; exit 0; fi
exit 0
"""

# The six files whose contents make up the image hash. Identical in both fake
# checkouts, so any difference in the resulting volume names comes from the path.
IMAGE_INPUTS = {
    "infra/test-image/Dockerfile": "FROM debian\n",
    "infra/test-image/entrypoint.sh": "#!/bin/sh\nexec \"$@\"\n",
    "requirements.txt": "pytest\n",
    "infra/render/requirements.txt": "rendercv\n",
    "webapp/package.json": '{"name":"webapp"}\n',
    "webapp/package-lock.json": '{"lockfileVersion":3}\n',
}


def make_checkout(root: Path) -> Path:
    """A minimal tree with the six hash inputs and the real script."""
    for rel, body in IMAGE_INPUTS.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
    (root / "scripts").mkdir(exist_ok=True)
    shutil.copy2(SCRIPT, root / "scripts" / "test-shell.sh")
    return root


@pytest.fixture
def shell(tmp_path: Path):
    stub = tmp_path / "bin"
    stub.mkdir()
    (stub / "docker").write_text(DOCKER_STUB)
    (stub / "docker").chmod(0o755)

    def run(checkout: Path, *args: str, **env: str) -> tuple[subprocess.CompletedProcess[str], str]:
        log = tmp_path / f"docker-{checkout.name}.log"
        e = dict(os.environ)
        e["PATH"] = f"{stub}:{e['PATH']}"
        e["DOCKER_LOG"] = str(log)
        # Point the concurrency semaphore at this test's own tmp dir. Isolation,
        # not exemption: without it these runs would queue behind whatever real
        # heavy work is on the machine, and would leave slot dirs in the shared
        # one. The limit itself still applies, and is what TestSemaphore below
        # measures.
        e["HQ_TEST_SLOTS_DIR"] = str(tmp_path / "slots")
        e.update(env)
        r = subprocess.run(
            ["bash", str(checkout / "scripts" / "test-shell.sh"), *args],
            cwd=checkout, capture_output=True, text=True, env=e, timeout=60,
        )
        return r, (log.read_text() if log.exists() else "")

    return run


def volumes(argv: str) -> dict[str, str]:
    """{container path: volume or host path} for every -v in the docker argv."""
    out = {}
    for src, dst in re.findall(r"-v (\S+):(\S+)", argv):
        out[dst] = src
    return out


def test_next_volume_is_keyed_per_checkout(shell, tmp_path: Path) -> None:
    """THE property. Two different checkout paths, byte-identical inputs, must
    still get different `.next` volumes."""
    a = make_checkout(tmp_path / "checkout-a")
    b = make_checkout(tmp_path / "checkout-b")

    ra, la = shell(a, "true")
    rb, lb = shell(b, "true")
    assert ra.returncode == 0, ra.stderr
    assert rb.returncode == 0, rb.stderr

    va = volumes(la)["/repo/webapp/.next"]
    vb = volumes(lb)["/repo/webapp/.next"]
    assert va != vb, (
        f"both checkouts mounted the SAME .next volume ({va}). Two concurrent "
        f"--image runs would write each other's generated route types."
    )
    assert va.startswith("hq-test-next-") and vb.startswith("hq-test-next-")


def test_node_modules_is_keyed_by_the_image_hash_only(shell, tmp_path: Path) -> None:
    """The counterexample for the test above: if EVERY volume were keyed by the
    path, that test would pass while node_modules was needlessly reinstalled in
    every worktree. node_modules is a function of the lockfile."""
    a = make_checkout(tmp_path / "checkout-a")
    b = make_checkout(tmp_path / "checkout-b")

    _, la = shell(a, "true")
    _, lb = shell(b, "true")

    na = volumes(la)["/repo/webapp/node_modules"]
    nb = volumes(lb)["/repo/webapp/node_modules"]
    assert na == nb, f"node_modules differs across checkouts ({na} vs {nb})"
    assert na.startswith("hq-test-node-modules-")


def test_changing_an_image_input_changes_both_volumes(shell, tmp_path: Path) -> None:
    """A refreshed image must never inherit the old image's node_modules — or its
    `.next`, which was built against those modules."""
    a = make_checkout(tmp_path / "checkout-a")
    _, before = shell(a, "true")
    (a / "webapp" / "package-lock.json").write_text('{"lockfileVersion":3,"x":1}\n')
    _, after = shell(a, "true")

    assert volumes(before)["/repo/webapp/node_modules"] != volumes(after)["/repo/webapp/node_modules"]
    assert volumes(before)["/repo/webapp/.next"] != volumes(after)["/repo/webapp/.next"]


def test_the_same_checkout_is_stable_across_runs(shell, tmp_path: Path) -> None:
    """Keys that changed per RUN would throw away the cache they exist to be."""
    a = make_checkout(tmp_path / "checkout-a")
    _, one = shell(a, "true")
    _, two = shell(a, "true")
    assert volumes(one) == volumes(two)


def test_the_repo_itself_is_mounted_read_write_at_repo(shell, tmp_path: Path) -> None:
    a = make_checkout(tmp_path / "checkout-a")
    _, log = shell(a, "true")
    v = volumes(log)
    assert v["/repo"] == str(a), "the real checkout must be the thing under test"
    assert "-w /repo" in log


def test_a_worktree_style_checkout_still_keys_cleanly(shell, tmp_path: Path) -> None:
    """The failure was between worktrees, so assert the case that produced it:
    a checkout nested inside another one."""
    parent = make_checkout(tmp_path / "parent")
    child = make_checkout(tmp_path / "parent" / ".claude" / "worktrees" / "agent-1")
    _, lp = shell(parent, "true")
    _, lc = shell(child, "true")
    assert volumes(lp)["/repo/webapp/.next"] != volumes(lc)["/repo/webapp/.next"]


def test_missing_image_refuses_instead_of_running_anything(shell, tmp_path: Path) -> None:
    """No image is not a reason to run half a suite."""
    a = make_checkout(tmp_path / "checkout-a")
    stub = tmp_path / "bin" / "docker"
    stub.write_text('#!/usr/bin/env bash\nif [ "$1" = "image" ]; then exit 1; fi\n'
                    'if [ "$1" = "run" ]; then printf \'%s\\n\' "$*" > "$DOCKER_LOG"; fi\nexit 0\n')
    stub.chmod(0o755)
    r, log = shell(a, "true")
    assert r.returncode == 1
    assert "is not built" in r.stderr
    assert log == "", "it must not have run the container"


def test_the_env_passthrough_does_not_leak_unset_variables(shell, tmp_path: Path) -> None:
    """Every forwarded variable is defaulted, so an unset one arrives empty rather
    than exploding under `set -u` — including HQ_DEMO, which must never be on."""
    a = make_checkout(tmp_path / "checkout-a")
    r, log = shell(a, "true")
    assert r.returncode == 0, r.stderr
    for name in ("HQ_VERIFY_PATHS", "HQ_DEMO", "HQ_VISUAL", "HQ_E2E_PORT"):
        assert f"-e {name}=" in log, f"{name} is not forwarded"


# ══════════════════════════════════════════════════════════════ ANTI-VACUITY

def test_mutation_removing_the_checkout_key_is_caught(shell, tmp_path: Path) -> None:
    """The bug as it actually shipped: `.next` keyed by the image hash alone.

    Two checkouts then mount ONE volume, which is what corrupted two agents' runs.
    Running the top test against this mutant must show the property broken —
    otherwise that test proves nothing.
    """
    original = SCRIPT.read_text()
    target = '-v "hq-test-next-$want-$checkout_key:/repo/webapp/.next"'
    assert original.count(target) == 1, "the .next mount line moved; update this mutation"
    mutant = original.replace(target, '-v "hq-test-next-$want:/repo/webapp/.next"')

    for name in ("mut-a", "mut-b"):
        c = make_checkout(tmp_path / name)
        (c / "scripts" / "test-shell.sh").write_text(mutant)

    _, la = shell(tmp_path / "mut-a", "true")
    _, lb = shell(tmp_path / "mut-b", "true")
    assert volumes(la)["/repo/webapp/.next"] == volumes(lb)["/repo/webapp/.next"], (
        "the mutant STILL produced distinct .next volumes — "
        "test_next_volume_is_keyed_per_checkout is not detecting what it claims to"
    )
    # And node_modules is unaffected by the mutation, so the test above is
    # measuring the .next key specifically and not some incidental difference.
    assert volumes(la)["/repo/webapp/node_modules"] == volumes(lb)["/repo/webapp/node_modules"]


# ══════════════════════════════════════════════════════ THE CONCURRENCY LIMIT
#
# Separate from the volume-keying tests above because it measures a different
# property with a different instrument. Those assert over one run's argv; these
# assert over what N SIMULTANEOUS runs were allowed to do.
#
# The defect: four hq-test containers running heavy suites at once put this
# machine at load 134 with the Docker VM at 1074% CPU. The round before reached
# load 317 and stalled six agents mid-task, each losing its uncommitted work.
#
# The instrument is a HIGH-WATER MARK, not a snapshot. Each stub `docker run`
# creates a marker file, counts the markers, appends the count, sleeps, then
# removes its marker. If the semaphore works the maximum recorded count never
# exceeds the budget. Sampling once at the end would miss a burst entirely,
# which is exactly how a concurrency test comes to pass with its fix removed.

# The stub BLOCKS, so several invocations overlap in wall-clock time whether or
# not they are allowed to. That is the point: the semaphore is then the only
# thing that can hold the observed number down.
CONCURRENCY_STUB = r"""#!/usr/bin/env bash
if [ "$1" = "image" ]; then exit 0; fi
if [ "$1" = "run" ]; then
  mkdir -p "$LIVE_DIR"
  marker="$LIVE_DIR/$$"
  : > "$marker"
  # Count AFTER claiming a marker, so a run can never fail to count itself.
  n=$(ls "$LIVE_DIR" | wc -l | tr -d ' ')
  echo "$n" >> "$SAMPLES"
  # An ORDERED event log, not timestamps. A release and the acquisition it
  # unblocks land in the same second, so a clock cannot order them; the order
  # that short appends reach one file can.
  echo "START ${RUN_LABEL:-?}" >> "$EVENTS"
  sleep "${STUB_SLEEP:-2}"
  echo "END ${RUN_LABEL:-?}" >> "$EVENTS"
  rm -f "$marker"
  exit 0
fi
exit 0
"""


class TestSemaphore:
    def _harness(self, tmp_path: Path, script_body: str | None = None):
        """A checkout, a blocking docker stub, and somewhere to record the mark."""
        root = make_checkout(tmp_path / "checkout")
        if script_body is not None:
            (root / "scripts" / "test-shell.sh").write_text(script_body)

        stub_dir = tmp_path / "bin"
        stub_dir.mkdir(exist_ok=True)
        (stub_dir / "docker").write_text(CONCURRENCY_STUB)
        (stub_dir / "docker").chmod(0o755)

        live = tmp_path / "live"
        live.mkdir(exist_ok=True)
        samples = tmp_path / "samples"
        samples.write_text("")
        events = tmp_path / "events"
        events.write_text("")

        env = dict(os.environ)
        env["PATH"] = f"{stub_dir}:{env['PATH']}"
        env["LIVE_DIR"] = str(live)
        env["SAMPLES"] = str(samples)
        env["EVENTS"] = str(events)
        env["HQ_TEST_SLOTS_DIR"] = str(tmp_path / "slots")
        env.pop("HQ_TEST_NO_SLOT", None)
        return root, env, samples

    def _events(self, tmp_path: Path) -> list[str]:
        return [ln.strip() for ln in (tmp_path / "events").read_text().splitlines() if ln.strip()]

    def _counts(self, samples: Path) -> list[int]:
        return [int(x) for x in samples.read_text().split() if x.strip()]

    def _high_water(self, samples: Path) -> int:
        vals = self._counts(samples)
        assert vals, "no run ever reached the stub; the harness is broken"
        return max(vals)

    def _fire(self, root: Path, env: dict, n: int, timeout: int = 180):
        procs = [
            subprocess.Popen(
                ["bash", str(root / "scripts" / "test-shell.sh"), "true"],
                cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            for _ in range(n)
        ]
        return [(p, *p.communicate(timeout=timeout)) for p in procs]

    def _await_slot(self, tmp_path: Path, index: int = 0) -> Path:
        pid_file = tmp_path / "slots" / f"slot.{index}" / "pid"
        for _ in range(400):
            if pid_file.exists():
                return pid_file
            time.sleep(0.05)
        raise AssertionError("no slot was ever taken")

    # ────────────────────────────────────────────────────────────── the property

    def test_concurrency_never_exceeds_the_slot_budget(self, tmp_path: Path) -> None:
        """THE property. Six runs fired at once against two slots: the observed
        maximum number of simultaneously-live containers must be two."""
        root, env, samples = self._harness(tmp_path)
        env["HQ_TEST_SLOTS"] = "2"
        env["STUB_SLEEP"] = "2"

        for p, _out, err in self._fire(root, env, 6):
            assert p.returncode == 0, err

        peak = self._high_water(samples)
        assert peak <= 2, (
            f"{peak} containers were live at once under a 2-slot limit. Four "
            f"concurrent hq-test containers is load 134 on this machine."
        )
        # And all six really did run. A "limit" that worked by dropping runs on
        # the floor would satisfy the assertion above while breaking everything.
        assert len(self._counts(samples)) == 6, "a queued run was lost, not delayed"

    def test_the_budget_is_configurable(self, tmp_path: Path) -> None:
        """Counterexample for the test above: were the limit hardcoded at 2 — or
        at 1 — that test would pass while the knob did nothing. Four slots must
        actually produce a high-water mark above two."""
        root, env, samples = self._harness(tmp_path)
        env["HQ_TEST_SLOTS"] = "4"
        env["STUB_SLEEP"] = "3"

        self._fire(root, env, 6)
        peak = self._high_water(samples)
        assert peak > 2, f"HQ_TEST_SLOTS=4 still peaked at {peak}; the knob is inert"
        assert peak <= 4, f"HQ_TEST_SLOTS=4 admitted {peak} at once"

    def test_the_default_is_two(self, tmp_path: Path) -> None:
        """The default is the number that matters, because almost nothing sets
        the variable. Derived from the Docker VM's 7.75 GiB against a measured
        ~2.1 GiB per hot container — not from the host's core count."""
        root, env, samples = self._harness(tmp_path)
        env.pop("HQ_TEST_SLOTS", None)
        env["STUB_SLEEP"] = "2"

        self._fire(root, env, 5)
        assert self._high_water(samples) == 2

    # ────────────────────────────────────────────────────────── visible waiting

    def test_a_queued_run_says_it_is_queued(self, tmp_path: Path) -> None:
        """A silent wait is indistinguishable from a stall, and this project has
        already misdiagnosed one as the other. The banner must give the busy
        count and the holder; acquisition must give the time waited."""
        root, env, _ = self._harness(tmp_path)
        env["HQ_TEST_SLOTS"] = "1"
        env["STUB_SLEEP"] = "6"
        env["HQ_TEST_SLOT_TICK"] = "2"

        holder = subprocess.Popen(
            ["bash", str(root / "scripts" / "test-shell.sh"), "true"],
            cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            owner = self._await_slot(tmp_path).read_text().strip()
            waiter = subprocess.run(
                ["bash", str(root / "scripts" / "test-shell.sh"), "true"],
                cwd=root, env=env, capture_output=True, text=True, timeout=180,
            )
        finally:
            holder.communicate(timeout=180)

        err = waiter.stderr
        assert waiter.returncode == 0, err
        assert "QUEUED" in err, f"the wait was silent:\n{err}"
        assert "1 of 1 slots are busy" in err, f"the busy count is missing:\n{err}"
        assert owner in err, f"the holder pid {owner} is not named:\n{err}"
        assert "still queued after" in err, f"no periodic reminder:\n{err}"
        assert re.search(r"slot 0 acquired after \d+s", err), (
            f"acquisition never says how long it waited:\n{err}"
        )

    def test_the_bypass_is_loud(self, tmp_path: Path) -> None:
        """An unannounced bypass is how a limit decays into one nobody notices is
        off. It must skip the wait AND say that it did."""
        root, env, samples = self._harness(tmp_path)
        env["HQ_TEST_SLOTS"] = "1"
        env["STUB_SLEEP"] = "2"
        env["HQ_TEST_NO_SLOT"] = "1"

        for p, _out, err in self._fire(root, env, 4):
            assert p.returncode == 0, err
            assert "BYPASSED" in err, f"the bypass was silent:\n{err}"
            assert "HQ_TEST_NO_SLOT=1" in err
        assert self._high_water(samples) > 1, "the bypass still queued"

    @pytest.mark.parametrize("value", ["0", "-1", "two", "2.5", " "])
    def test_a_nonsense_budget_refuses_instead_of_hanging(
        self, tmp_path: Path, value: str
    ) -> None:
        """A budget that is not a positive integer makes the acquire loop scan an
        empty range and wait forever, announcing '0 of 0 slots are busy'. That is
        a silent hang wearing this script's own uniform. It must refuse."""
        root, env, samples = self._harness(tmp_path)
        env["HQ_TEST_SLOTS"] = value

        r = subprocess.run(
            ["bash", str(root / "scripts" / "test-shell.sh"), "true"],
            cwd=root, env=env, capture_output=True, text=True, timeout=60,
        )
        assert r.returncode == 2, f"HQ_TEST_SLOTS={value!r} did not refuse"
        assert "not a positive integer" in r.stderr, r.stderr
        assert not self._counts(samples), "it started a container anyway"

    def test_an_unset_budget_is_not_treated_as_nonsense(self, tmp_path: Path) -> None:
        """Counterexample for the refusal above: an unset or EMPTY variable is
        the default case, not the invalid one. A validator that rejected it would
        break every run that sets nothing — which is nearly all of them."""
        root, env, samples = self._harness(tmp_path)
        env["HQ_TEST_SLOTS"] = ""
        env["STUB_SLEEP"] = "1"

        r = subprocess.run(
            ["bash", str(root / "scripts" / "test-shell.sh"), "true"],
            cwd=root, env=env, capture_output=True, text=True, timeout=120,
        )
        assert r.returncode == 0, r.stderr
        assert self._counts(samples), "the default budget did not admit the run"

    # ───────────────────────────────────────────────────────────── crash safety

    def test_a_killed_holder_does_not_leak_its_slot_forever(self, tmp_path: Path) -> None:
        """Proved by killing a process, not by reasoning about one.

        SIGKILL runs no trap, so the slot directory outlives its owner. If a dead
        holder's slot were never reclaimed, one interrupted agent would
        permanently remove a slot from the machine, and enough of them would
        deadlock every future run — the failure this whole file exists to stop,
        reintroduced by its own fix.
        """
        root, env, samples = self._harness(tmp_path)
        env["HQ_TEST_SLOTS"] = "1"
        env["STUB_SLEEP"] = "600"   # would never finish on its own

        holder = subprocess.Popen(
            ["bash", str(root / "scripts" / "test-shell.sh"), "true"],
            cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        pid_file = self._await_slot(tmp_path)
        assert pid_file.read_text().strip() == str(holder.pid)

        os.kill(holder.pid, signal.SIGKILL)
        holder.wait(timeout=60)
        assert pid_file.exists(), (
            "SIGKILL somehow cleaned up after itself, so this test is not "
            "exercising the reclaim path it claims to"
        )

        env["STUB_SLEEP"] = "1"
        after = subprocess.run(
            ["bash", str(root / "scripts" / "test-shell.sh"), "true"],
            cwd=root, env=env, capture_output=True, text=True, timeout=180,
        )
        assert after.returncode == 0, after.stderr
        assert "reclaiming slot 0" in after.stderr, (
            f"the dead holder's slot was not reclaimed:\n{after.stderr}"
        )
        assert self._counts(samples), "the reclaiming run never started a container"

    def _handback(self, tmp_path: Path, script_body: str | None = None):
        """One slot, a holder, and a waiter that can only run once it is freed.

        Returns the waiter's result and the ordered event log. The log is what
        makes the handback OBSERVED rather than inferred: the stub appends
        START/END lines in the order they happen, so `END holder` preceding
        `START waiter` is a fact about the run, not a deduction from timing.
        """
        root, env, _ = self._harness(tmp_path, script_body=script_body)
        env["HQ_TEST_SLOTS"] = "1"
        env["HQ_TEST_SLOT_TICK"] = "2"

        holder_env = dict(env, STUB_SLEEP="5", RUN_LABEL="holder")
        holder = subprocess.Popen(
            ["bash", str(root / "scripts" / "test-shell.sh"), "true"],
            cwd=root, env=holder_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        # Reap the holder CONCURRENTLY. An exited-but-unreaped child is a zombie,
        # and `kill -0` on a zombie succeeds — so a waiter checking whether the
        # holder is gone would block until this test got around to reaping it,
        # which is after the waiter returns. That is a deadlock in the harness,
        # not in the script (a real parent shell reaps as it goes), and it hid
        # the reclaim path entirely on the first run of the mutation below.
        reaper = threading.Thread(target=holder.communicate, kwargs={"timeout": 180})
        reaper.start()
        try:
            self._await_slot(tmp_path)      # the holder really owns the slot first
            waiter = subprocess.run(
                ["bash", str(root / "scripts" / "test-shell.sh"), "true"],
                cwd=root, env=dict(env, STUB_SLEEP="1", RUN_LABEL="waiter"),
                capture_output=True, text=True, timeout=180,
            )
        finally:
            reaper.join(timeout=190)
        return waiter, self._events(tmp_path)

    def test_a_released_slot_is_handed_back_to_a_waiter(self, tmp_path: Path) -> None:
        """Counterexample for the reclaim test: if release relied ONLY on a later
        waiter noticing a dead PID, a finished run would leave a slot that merely
        LOOKS busy until something swept the corpse. A clean exit must hand the
        slot back itself.

        Everything here is a positive claim about what happened. The previous
        version of this test asserted an exit status of 0 and the ABSENCE of a
        slot directory — both absence checks, so it would have passed just as
        well had no run ever started and no waiter ever existed. For a semaphore
        that is the worst available failure mode: "nobody was blocked" and
        "nobody was there" are the same observation.
        """
        waiter, events = self._handback(tmp_path)

        # 1. The waiter WAS blocked, before the release.
        assert "QUEUED" in waiter.stderr, (
            f"the waiter was never blocked, so this test proves nothing about a "
            f"handback:\n{waiter.stderr}"
        )
        # 2. It acquired AFTER the holder finished — the ordering is recorded by
        #    the runs themselves, not inferred from wall-clock.
        assert events == ["START holder", "END holder", "START waiter", "END waiter"], (
            f"the two runs did not strictly alternate: {events}"
        )
        # 3. And it says how long it waited, which is the handback observed.
        m = re.search(r"slot 0 acquired after (\d+)s", waiter.stderr)
        assert m, f"the waiter never reported acquiring a slot:\n{waiter.stderr}"
        assert int(m.group(1)) >= 2, (
            f"the waiter reported waiting {m.group(1)}s, so it was never actually "
            f"queued behind the holder's 5s run"
        )
        # 4. The handback was the holder's own release, not a corpse sweep. This
        #    is the one absence check, and it is the mechanism claim: a waiter
        #    that had to reclaim would say so.
        assert "reclaiming" not in waiter.stderr, (
            f"the waiter RECLAIMED the slot instead of being handed it, so the "
            f"release path did not run:\n{waiter.stderr}"
        )

    def test_mutation_removing_the_release_trap_is_caught(self, tmp_path: Path) -> None:
        """Hold the slot and never give it back.

        With the trap gone the holder's slot outlives it, and the waiter can only
        proceed by reclaiming a dead PID. Everything about the run still LOOKS
        right — the waiter queues, then runs, and the events still alternate —
        which is precisely why the test above needs the mechanism claim. If this
        mutant slipped through, the release path could be deleted entirely and
        every assertion would stay green.
        """
        original = SCRIPT.read_text()
        target = "        trap release_slot EXIT INT TERM\n"
        assert original.count(target) == 1, "the release trap moved; update this mutation"
        mutant = original.replace(target, "")

        waiter, events = self._handback(tmp_path, script_body=mutant)

        assert "reclaiming" in waiter.stderr, (
            "with the release trap REMOVED the waiter still received a clean "
            "handback, so test_a_released_slot_is_handed_back_to_a_waiter is not "
            f"measuring the release path:\n{waiter.stderr}"
        )
        # The rest of the run is unchanged, which is the point: the ordering and
        # the queue banner cannot tell these two worlds apart on their own.
        assert "QUEUED" in waiter.stderr
        assert events == ["START holder", "END holder", "START waiter", "END waiter"]

    def test_the_exit_status_survives_the_slot_release(self, tmp_path: Path) -> None:
        """Holding a slot means the script can no longer `exec` docker, so the
        container's status is now propagated by hand. A limiter that ate failures
        would turn every red suite green — a far more expensive bug than the one
        being fixed."""
        root, env, _ = self._harness(tmp_path)
        stub = tmp_path / "bin" / "docker"
        stub.write_text(
            '#!/usr/bin/env bash\n'
            'if [ "$1" = "image" ]; then exit 0; fi\n'
            'if [ "$1" = "run" ]; then exit 7; fi\nexit 0\n'
        )
        stub.chmod(0o755)
        r = subprocess.run(
            ["bash", str(root / "scripts" / "test-shell.sh"), "true"],
            cwd=root, env=env, capture_output=True, text=True, timeout=180,
        )
        assert r.returncode == 7, f"exit status was swallowed (got {r.returncode})"

    # ══════════════════════════════════════════════════════════════ ANTI-VACUITY

    def test_mutation_removing_the_limit_is_caught(self, tmp_path: Path) -> None:
        """The fix removed. With no acquire call the runs are unbounded, and
        test_concurrency_never_exceeds_the_slot_budget must be able to SEE that
        — otherwise it is passing on nothing at all."""
        original = SCRIPT.read_text()
        target = "\nelse\n  acquire_slot\nfi\n"
        assert original.count(target) == 1, "the acquire call moved; update this mutation"
        mutant = original.replace(target, "\nelse\n  :   # LIMIT REMOVED\nfi\n")

        root, env, samples = self._harness(tmp_path, script_body=mutant)
        env["HQ_TEST_SLOTS"] = "2"
        env["STUB_SLEEP"] = "3"

        self._fire(root, env, 6)
        peak = self._high_water(samples)
        assert peak > 2, (
            f"with the limit REMOVED, six concurrent runs still peaked at {peak}. "
            f"test_concurrency_never_exceeds_the_slot_budget is not measuring what "
            f"it claims to — most likely the stub is not blocking long enough for "
            f"the runs to overlap."
        )


def test_a_linked_worktree_mounts_the_parent_gitdir_so_git_resolves() -> None:
    """A worktree's `.git` is a FILE holding `gitdir: <abs path>`, so git inside
    the container follows that pointer straight out of the /repo mount.

    The harness's comment used to say nothing in there needed git. #166 made
    that false: `test_no_absolute_symlinks.py` shells out to `git ls-tree` —
    correctly, since a symlink's target IS its committed content — and refuses
    to pass on a tree it cannot read. The effect was that `--full --image` could
    not pass from ANY linked worktree, i.e. from any delegated agent, for a
    reason no branch could fix, on a run where every other suite was green.
    That is the shape that produces a "green apart from an unrelated failure"
    claim, which had already happened twice that day."""
    src = SCRIPT.read_text()
    assert "gitmount=()" in src, "the parent gitdir mount was removed"
    assert 'sed -n \'s/^gitdir: //p\'' in src, (
        "the pointer must be read from the .git FILE, not guessed"
    )
    assert '"$parent_git:$parent_git:ro"' in src, (
        "the parent .git must be mounted at the SAME absolute path the pointer "
        "names — anywhere else and the pointer still does not resolve — and "
        "read-only, because nothing in the container may write to it"
    )
    # The mount must actually reach docker. A block that computes it and never
    # appends it is the same bug wearing a helpful comment.
    assert 'args+=("${gitmount[@]+"${gitmount[@]}"}")' in src, (
        "gitmount is computed but never added to the docker arguments"
    )
