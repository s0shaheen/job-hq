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
import subprocess
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
