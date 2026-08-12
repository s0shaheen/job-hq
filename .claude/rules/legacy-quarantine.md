---
paths:
  - "tracker/**"
  - "appsscript/**"
---

# LEGACY — do not extend or import

You are reading Sheet-era code. `tracker/` and `appsscript/` are legacy
(CLAUDE.md: legacy or transition systems), mid-sunset per
`docs/plans/SHEET-SUNSET.md`, and still operational — `selfheal.yml` and
`run-bot.yml` run `python -m tracker.*` nightly, so they must keep working.

- Do not add features here. Every capability these packages provide is getting
  a pg-native home; build or use that home instead.
- Do not import these packages from product code (`core/`, `monitor/`,
  `infra/`, `scripts/`) — `tests/core/test_legacy_quarantine.py` fails the
  build if you do (issue #188).
- Repairs are allowed, but must preserve the existing `core.sheets.Tab` safety
  contract and must not expand its role (CLAUDE.md, product authority).
