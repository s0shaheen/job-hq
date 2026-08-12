"""The acceptance register stays a machine-checkable artifact, not a wish list.

`acceptance/register.json` (issue #193) is the pilot's definition of done: one
entry per pilot-critical behavior, `passes: false` until a verifier — never the
implementer — flips it with evidence. The Anthropic long-horizon-harness finding
behind it: models tamper with markdown checklists far more readily than with
JSON an explicit test is watching. This test is the watching.

What it holds: the file parses, every entry carries the full field set, IDs are
unique and trace to the requirements register's ID grammar, and — the rule that
matters — an entry cannot claim `passes: true` while pointing at no evidence.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

REGISTER = Path(__file__).resolve().parents[2] / "acceptance" / "register.json"

REQUIRED_FIELDS = {"id", "requirement", "oracle", "passes", "evidence"}

#: FP-<AREA>-<NNN>, the grammar of docs/pilot-launch/15-full-product-requirements-register.md.
ID_SHAPE = re.compile(r"^FP-[A-Z]+-\d{3}$")


def _entries() -> list[dict]:
    doc = json.loads(REGISTER.read_text(encoding="utf-8"))
    assert isinstance(doc.get("entries"), list) and doc["entries"], (
        "register.json has no entries — an empty definition of done passes vacuously"
    )
    return doc["entries"]


def test_every_entry_carries_the_full_field_set() -> None:
    for e in _entries():
        assert REQUIRED_FIELDS <= set(e), f"{e.get('id', '<no id>')}: missing {sorted(REQUIRED_FIELDS - set(e))}"
        assert isinstance(e["passes"], bool), f"{e['id']}: passes must be a bool, got {e['passes']!r}"


def test_ids_are_unique_and_well_shaped() -> None:
    ids = [e["id"] for e in _entries()]
    assert len(ids) == len(set(ids)), "duplicate register IDs"
    for i in ids:
        assert ID_SHAPE.match(i), f"{i!r} does not match the register grammar FP-AREA-NNN"


def test_a_pass_without_evidence_is_a_lie() -> None:
    """The one rule the file exists for: `passes: true` with `evidence: null`
    is an unverified claim wearing a verified one's clothes. The flip and the
    evidence link land together or not at all."""
    for e in _entries():
        if e["passes"]:
            assert e["evidence"], f"{e['id']} claims passes=true with no evidence"
