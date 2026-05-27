# PM Job Monitor

Zero-secret daily monitor for new PM roles across target companies' public ATS APIs
(Greenhouse, Ashby, Lever, SmartRecruiters, Workday, Amazon). New roles land in a Google Sheet
and get pushed to your phone via ntfy. Status + contacts are tracked in the same Sheet.

## How it works
GitHub Actions runs `python -m src.run` daily. For each profile it reads the Companies
tab, fetches each board, filters to PM titles, dedupes against history on
`{ats}-{native_id}`, appends new roles, auto-closes stale ones, writes a Health tab,
commits a JSON snapshot, and pushes new roles (or a heartbeat if none) to ntfy.

## One-time setup
1. Create a Google Sheet with tabs `Companies`, `Jobs`, `Contacts`, `Health` and the
   headers in `docs/superpowers/specs/2026-05-26-pm-job-monitor-design.md` §7.
2. Import `companies.seed.csv` into the `Companies` tab.
3. Create a Google Cloud service account, download its JSON key, share the Sheet with
   the service-account email (Editor).
4. Set repo secrets: `GOOGLE_SERVICE_ACCOUNT_JSON` (the key's JSON),
   `MONITOR_OPS_NTFY_TOPIC` (an ntfy topic for failure alerts). `APIFY_TOKEN` optional.
5. Edit `profiles/pm.yaml`: set `sheet_id` and a private `ntfy_topic`. Keep the repo private.
6. Subscribe to your `ntfy_topic` and the ops topic in the ntfy phone app.

## Adding a company
Add a row to the `Companies` tab (`name, ats, slug, monitor=TRUE`). Unsure of the slug?
Run `python -m src.discover "Company Name"`. The next run seeds it silently, then notifies
only on genuinely new roles.

## Removing a company
Set its `monitor` cell to `FALSE`. History is preserved (never delete rows).

## Adding another person (e.g. a finance analyst)
Drop `profiles/finance.yaml` (own `sheet_id`, `ntfy_topic`, include/exclude keywords) and
create their Sheet. No code changes.

## Known limitations
- The Health tab's "ZERO" result counts post-filter jobs, so a company with many roles but
  zero PM matches is logged the same as a dead slug returning zero. The weekly digest still
  surfaces both for manual investigation; hard fetch failures are logged separately as "ERROR".

## Troubleshooting
- No notification at all → the run failed; check the ops ntfy topic and the Actions log.
- A company shows ERROR/ZERO in the Health tab for days → likely a dead slug; re-run
  `discover.py` for it.
