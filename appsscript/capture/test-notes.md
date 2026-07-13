# Dry-running `runCapture` safely

A dry run appends rows and updates the heartbeat but leaves Gmail untouched,
so you can inspect classification quality before committing to the label.

1. In `capturePass_`, comment out the line marked `// the "label line"`:
   `thread.addLabel(label);`
2. Optional silence: set `MAX_PUSHES_PER_RUN = 0` in CONFIG so no test pushes
   hit the phone.
3. Editor toolbar: function dropdown -> `runCapture` -> Run. The first run
   walks the OAuth consent flow (unverified-app click-through is expected —
   see `../README.md`).
4. Left sidebar -> Executions -> open the run. The log line looks like
   `runCapture: {"threads":4,"appended":6,"skipped":0,"pushes":0}`.
5. Open the **Email Events** tab: check `event_type` / `confidence` /
   `evidence` per row. `evidence: "rule"` means the Anthropic call failed or
   the key is unset (deterministic fallback).
6. Run it again: `appended` must be 0 — the event_id guard proves the replay
   is idempotent even without labels.
7. Restore the label line (and `MAX_PUSHES_PER_RUN`). The next run re-scans
   the same threads, appends nothing, and labels them `hq/processed`.

## Resetting after a test

- Delete the test rows from **Email Events** (keep row 1).
- Remove the label in Gmail: search `label:hq/processed`, select all, remove
  the label (only needed if the label line was active).
- If you interrupted a `backfill` test: Project Settings -> Script Properties
  -> delete `BACKFILL_AFTER` and `BACKFILL_TOTAL`.
