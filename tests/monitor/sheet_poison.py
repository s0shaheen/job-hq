"""A spreadsheet that screams when touched — the fallback detector for RM-12.

The acceptance evidence for cutting a lane over to Postgres is a test that FAILS if
the lane silently fell back to the Sheet. The obvious version of that test does not
work: asserting a row count in Postgres cannot tell "the sweep wrote pg" apart from
"the sweep wrote both", and asserting the Sheet is unchanged cannot tell "never read
it" apart from "read it and wrote nothing". A fallback is not a crash; it is the same
job, done through the wrong store, at the same row count.

So the detection is positive and structural rather than inferential: hand the lane an
`HQ` whose every access raises. If it reaches for the spreadsheet, at all, for any
reason, the run dies with `SheetTouched` naming the exact call. A lane that completes
against this object did not read or write a Sheet — not because we checked afterwards,
but because there was nothing there to read.

This module is deliberately built and PROVEN before the store it will guard. A detector
written alongside the thing it detects tends to be shaped around what that thing
happens to do; `test_sheet_poison.py` verifies this one fires on every access path
`monitor/sheet.py` actually uses, against the REAL `HQFeedStore`, which is the only
implementation that definitely does touch a Sheet.

Usage in the eventual cutover test:

    hq = poisoned_hq()
    store = PgFeedStore(user_id=..., session=...)
    run_monitor(store, cfg, ...)          # must not raise
    assert postings_in_pg(...) == [...]   # and must have done real work
"""
from __future__ import annotations

from typing import Any, NoReturn


class SheetTouched(AssertionError):
    """Raised the moment a lane under test reaches for the spreadsheet.

    An `AssertionError` on purpose: this is a test failing, not the product
    erroring, and it should read as the former in a traceback. It also means a
    lane with a broad `except Exception` around its Sheet access cannot swallow it
    and carry on looking healthy — which is exactly the fallback shape being
    hunted, and `monitor/run.py` does quarantine per-company failures that way.
    """


class _Poison:
    """Any attribute access, call, or item access raises. Recursively."""

    def __init__(self, path: str):
        # `object.__setattr__` because this class refuses ordinary attribute work
        object.__setattr__(self, "_path", path)

    def _die(self, how: str) -> NoReturn:
        raise SheetTouched(
            f"the lane reached for the spreadsheet: {object.__getattribute__(self, '_path')}{how}")

    def __getattr__(self, name: str) -> Any:
        self._die(f".{name}")

    def __setattr__(self, name: str, value: Any) -> NoReturn:
        self._die(f".{name} = ...")

    def __call__(self, *a: Any, **k: Any) -> NoReturn:
        self._die("(...)")

    def __getitem__(self, key: Any) -> NoReturn:
        self._die(f"[{key!r}]")

    def __iter__(self) -> NoReturn:
        self._die(" iterated")

    def __len__(self) -> NoReturn:
        self._die(" len()")

    def __bool__(self) -> NoReturn:
        # Not harmless: `if hq.tab("feed"):` is a real access, and returning True
        # here would let a truthiness check pass silently on a poisoned handle.
        self._die(" truth-tested")

    def __repr__(self) -> str:
        # The ONE thing that must not raise. pytest builds failure output by
        # repr()-ing locals, so a repr that raised would replace every assertion
        # message in this suite with an unrelated internal error.
        return f"<poisoned {object.__getattribute__(self, '_path')}>"


class PoisonedHQ:
    """An `HQ` lookalike that raises on every documented entry point.

    `user` and `registry` stay REAL and readable. They carry no spreadsheet data —
    a user label and the tab-id map — and lanes read them for identity while doing
    Postgres work, so poisoning them would fail the run for a reason that has
    nothing to do with a Sheet and make the detector useless as evidence.
    """

    def __init__(self, user: str = "salman", registry: dict | None = None):
        self.user = user
        self.registry = registry if registry is not None else {"tabs": {}, "ntfy": {}}

    def tab(self, logical: str) -> NoReturn:
        raise SheetTouched(f"the lane reached for the spreadsheet: hq.tab({logical!r})")

    def log(self, actor: str, action: str, key: str = "", detail: str = "") -> NoReturn:
        raise SheetTouched(f"the lane wrote the Log tab: hq.log({actor!r}, {action!r})")

    def heartbeat(self, name: str) -> NoReturn:
        raise SheetTouched(f"the lane beat into the Config tab: hq.heartbeat({name!r})")

    def user_config(self) -> NoReturn:
        raise SheetTouched("the lane read the Config tab: hq.user_config()")

    def __getattr__(self, name: str) -> Any:
        # Everything not named above — `.sh`, `.spreadsheet`, a method added later.
        # Returning a _Poison rather than raising here means the failure names the
        # FULL path (`hq.sh.worksheets(...)`), not just its first segment.
        return _Poison(f"hq.{name}")


def poisoned_hq(user: str = "salman", registry: dict | None = None) -> PoisonedHQ:
    """The detector. Hand this to a lane that must not touch a Sheet."""
    return PoisonedHQ(user=user, registry=registry)
