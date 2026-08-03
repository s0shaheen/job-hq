"""No tracked symlink may point outside the repository.

Two were, and both were found by accident rather than by a check.

`webapp/node_modules` was committed in #141 pointing at
`/Users/s0shaheen/job-hq/webapp/node_modules` — this checkout, on this laptop.
Anywhere else that is a broken path standing exactly where a real directory is
expected, and it cost a reviewer two runs to `MODULE_NOT_FOUND` before anyone
looked at what the path actually was. CI survived it only because the runner
installs over the top.

`applications` pointed into a Google Drive folder whose path contains the
owner's email address, so the blob published a personal identifier and a
private folder layout to every reader of the repository. It had been there
since #93.

A symlink's target is its CONTENT: `git ls-tree` mode 120000, and the blob is
the path string. So this is checkable, cheap, and exactly the kind of rule that
only holds when a machine holds it.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _tracked_symlinks() -> list[tuple[str, str]]:
    """(path, target) for every tracked symlink at HEAD."""
    listing = subprocess.run(
        ["git", "ls-tree", "-r", "HEAD", "--format=%(objectmode)\t%(path)"],
        cwd=REPO, capture_output=True, text=True, check=True,
    ).stdout.splitlines()
    out = []
    for line in listing:
        mode, _, path = line.partition("\t")
        if mode != "120000":
            continue
        target = subprocess.run(
            ["git", "show", f"HEAD:{path}"],
            cwd=REPO, capture_output=True, text=True, check=True,
        ).stdout
        out.append((path, target.strip()))
    return out


def test_no_tracked_symlink_escapes_the_repository() -> None:
    """An absolute target, or one that climbs out with `..`, is machine-specific
    by construction — it cannot resolve the same way in two checkouts.

    The population check lives INSIDE this test rather than beside it. An
    escapee list is an absence, and an absence over an empty tree passes for
    the wrong reason: a wrong ref, a wrong cwd or an `ls-tree` format change
    would each report a clean repository. So the sweep must first prove it read
    this one."""
    listing = subprocess.run(
        ["git", "ls-tree", "-r", "HEAD", "--format=%(objectmode)\t%(path)"],
        cwd=REPO, capture_output=True, text=True, check=True,
    ).stdout.splitlines()
    assert len(listing) > 500, (
        f"the sweep saw only {len(listing)} tracked paths; it is not looking at "
        "this repository"
    )
    assert any(line.endswith("\tCLAUDE.md") for line in listing), (
        "the sweep did not see CLAUDE.md, so it is not reading the tree it thinks"
    )

    escapees = []
    for path, target in _tracked_symlinks():
        if target.startswith("/"):
            escapees.append(f"{path} -> {target}  (absolute)")
            continue
        # Resolve the link relative to its own directory, purely as text, and
        # see whether it lands inside the tree. `Path.resolve()` would consult
        # the filesystem, which is the thing that differs between machines.
        landed = (Path(path).parent / target)
        parts: list[str] = []
        for part in landed.parts:
            if part == "..":
                if not parts:
                    escapees.append(f"{path} -> {target}  (climbs above the repo root)")
                    break
                parts.pop()
            elif part != ".":
                parts.append(part)

    assert escapees == [], (
        "tracked symlink(s) point outside this repository:\n  "
        + "\n  ".join(escapees)
        + "\nA symlink's target is its committed content. An absolute one names "
          "a path that exists on exactly one machine, and it may carry personal "
          "information into the blob — `applications` carried an email address. "
          "Untrack it and add it to .gitignore."
    )
