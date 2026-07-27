"""The wizard's presets against the committed profiles they were copied from.

`webapp/lib/profile/presets.ts` seeds a new user's title lists from
`users/salman/profile.yaml` and `users/dad/profile.yaml`, because those are the
only lists anybody has tuned against a live feed. Salman's `titles_exclude` has
`pmm` and `product analyst` in it for reasons somebody learned the hard way, and
Dad's has `financial advisor` and `personal banker` because an FP&A search
without them is 60% insurance sales.

A copy with nothing pinning it rots in the direction that costs the most: a
title added to a committed profile after a bad week of results does not reach
the next person who onboards, and they get to learn the same lesson from
scratch. This parses both sides.

Only the two REAL presets are checked. The third is "something else" and is
deliberately empty — pretending to have a curated list for an unknown role
family would be the worse lie.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
TS = ROOT / "webapp" / "lib" / "profile" / "presets.ts"

#: preset id in the TypeScript -> the committed profile it was copied from
PAIRS = {"product-manager": "salman", "fpa": "dad"}

FIELDS = ("role_family", "tag_domain", "board_search_term", "titles_include", "titles_exclude")


def _ts_presets() -> dict[str, dict]:
    """Every preset's `criteria` block, parsed out of the module."""
    src = TS.read_text(encoding="utf-8")
    out: dict[str, dict] = {}
    for m in re.finditer(r'id:\s*"([a-z-]+)",(.*?)\n  \},\n', src, re.S):
        pid, body = m.group(1), m.group(2)
        crit: dict = {}
        for field in FIELDS:
            lm = re.search(rf"{field}:\s*\[(.*?)\]", body, re.S)
            if lm:
                crit[field] = re.findall(r'"([^"]*)"', lm.group(1))
                continue
            sm = re.search(rf'{field}:\s*"([^"]*)"', body)
            if sm:
                crit[field] = sm.group(1)
        out[pid] = crit
    return out


PRESETS = _ts_presets()


def test_the_parser_found_every_preset():
    """Vacuous-guard control: a regex that matches nothing turns every
    parametrised check below green."""
    assert set(PRESETS) >= set(PAIRS) | {"other"}, sorted(PRESETS)
    for pid in PAIRS:
        assert PRESETS[pid].get("titles_include"), pid


@pytest.mark.parametrize("preset_id,user", sorted(PAIRS.items()))
def test_preset_matches_the_committed_profile(preset_id: str, user: str):
    data = yaml.safe_load((ROOT / "users" / user / "profile.yaml").read_text()) or {}
    preset = PRESETS[preset_id]
    for field in FIELDS:
        assert field in preset, f"{preset_id} is missing {field}"
        assert preset[field] == data[field], (
            f"{preset_id}.{field} has drifted from users/{user}/profile.yaml:\n"
            f"  preset: {json.dumps(preset[field])}\n"
            f"  yaml:   {json.dumps(data[field])}"
        )


def test_the_other_preset_seeds_nothing():
    """An empty list is the honest answer for a role family nobody has tuned.
    Seeding it with the PM list would hand every non-PM user a search that
    matches the wrong jobs and looks deliberate."""
    other = PRESETS["other"]
    assert other["titles_include"] == []
    assert other["titles_exclude"] == []
    assert other["role_family"] == ""
