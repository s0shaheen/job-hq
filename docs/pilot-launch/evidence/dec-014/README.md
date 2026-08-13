# DEC-014 evidence — a dark OS renders the light page

Captured 2026-08-13 on the `feat/light-mode-only` branch (issue #240), against the
demo server, with Playwright's `colorScheme` emulation: the same route loaded in a
light-OS context and a dark-OS context, screenshotted full-page at 1280×900.

| File | Context | sha256 |
|---|---|---|
| `queue-light-os.png` | `/queue`, `colorScheme: light` | `24617821709a2ba0…` |
| `queue-dark-os.png` | `/queue`, `colorScheme: dark` | `24617821709a2ba0…` |

The two files are **byte-identical** (same hash, same 105,522 bytes) — the
acceptance criterion "WHEN the OS is in dark mode THE SYSTEM SHALL render
identically to light mode" held to the byte, not just to the eye. The
`/settings/preferences` pair captured in the same run was byte-identical too
(sha256 `b8e749a11eedb4b3…`, 45,517 bytes each); one committed pair is enough to
carry the claim, and `tests/e2e/theme.spec.ts` re-proves it on every CI run.
