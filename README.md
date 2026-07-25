# Job Search HQ

Salman Shaheen's entire job search as one system: **one Google Sheet** (the cockpit — the
only thing humans touch), **one repo** (this — the engine), and **Gmail as the status
ground truth** (ATS emails auto-advance the tracker; "applied" is never marked by hand).
It absorbs five previously disconnected fragments: the PM job monitor, the scout's
spreadsheet, Simplify, the inbox, and the RenderCV resume pipeline.

**How it works:** scheduled bots (AWS Lambda + EventBridge; `infra/`) fetch ~640 companies'
boards through 12 live-verified ATS
adapters (plus a hiring.cafe wide sweep for everything else) into a **Feed** tab, tag each
role with Claude Haiku, and push roles matching the YoE rule to the phone via ntfy. Tracker
bots merge every funnel — Feed ★-picks, the scout's rows, Quick Add URL pastes, Simplify —
into one deduped **Pipeline** keyed on ATS-native job ids. An Apps Script in Gmail
classifies every ATS email into an **Email Events** tab; the joiner matches events to
Pipeline rows and moves statuses forward with evidence links. Any push touching `resume/`
re-renders both resume variants (hard one-page gate) and publishes them to Drive. All sheet
writes go through one durable layer — tabs by gid, columns by header, rows by key,
fill-blanks-only, fail-loud — so human sorting, renaming, and fat-fingering can't corrupt
anything, and a nightly self-heal + CSV snapshot makes any catastrophe a git restore.

## Subsystems

| Subsystem | Entrypoint | When | What |
|---|---|---|---|
| Discovery monitor | `python -m monitor.run` | daily 07:00 CT | full sweep, reconcile Feed, Health tab, YoE-gated push |
| Priority watch | `python -m monitor.priority` | hourly 06–23 CT | handpicked companies → push within the hour, no YoE gate |
| Tagging review | `python -m monitor.review` | daily 10:00 CT | Haiku-tags any Feed row discovery couldn't tag inline |
| Wide sweep | `python -m monitor.wide` | daily 08:30 CT | hiring.cafe (Apify) + TheirStack safety net; off until `APIFY_TOKEN` |
| Tracker chain | `python -m tracker.promote` → `quickadd` → `scout` → `stale` → `join` | every 2 h | ★-promotions, URL enrich, scout sync + flags, stale flags, email-event join |
| Simplify import | `python -m tracker.simplify` | daily 09:07 CT | best-effort saved-queue import via session cookies |
| Daily digest | `python -m tracker.digest` | daily 06:40 CT | briefing row (Apps Script emails it ~7:00) + capture watchdog |
| Self-heal + snapshot | `python -m tracker.selfheal` + `python -m tracker.snapshot` | nightly 03:23 CT | re-assert schema/protections/gids; commit per-tab CSVs to `snapshots/hq/` |
| Gmail capture | `appsscript/capture/` | every 15 min (in Gmail) | ATS-mail gate → Haiku classify → Email Events + instant OA/interview pushes |
| Resume pipeline | `.github/workflows/resume.yml` | on push to `resume/**` | render base + alt (rendercv==2.8), one-page gate, publish to Drive, preview to phone |
| Resume editor | `editor/` (Vercel) | on demand | phone-first editor for the two YAMLs; comment-preserving commits |
| Provisioning | `python -m tracker.bootstrap` / `tracker.migrate` | one-time | create/repair the spreadsheet; import legacy history |

Tests: **334 passing** — `uv run --python 3.11 --with-requirements requirements.txt --no-project -- pytest`

## Docs

- **[docs/ACTIVATION.md](docs/ACTIVATION.md)** — the one-time ~15-minute go-live checklist.
- **[docs/RUNBOOK.md](docs/RUNBOOK.md)** — every failure mode: symptom → cause → fix.
- **[docs/SPEC.md](docs/SPEC.md)** — the approved consolidation spec (architecture + decisions).
- **[CLAUDE.md](CLAUDE.md)** — operating manual for AI sessions: repo map, the sheet
  durability contract, the resume tailoring system, golden rules.
- **[docs/scout-instructions.md](docs/scout-instructions.md)** — plain-English daily
  instructions for the scout.
- `docs/research/` — six verified research reports (ATS endpoints, Gmail quotas, Sheets
  durability, Simplify internals, aggregators, resume editing) grounding every design call.
- `appsscript/README.md` / `editor/README.md` — provisioning for the two Apps Script
  projects and the editor deploy.

## Cost

**≈ $2–5/month.** Haiku tagging + email classification ~$2–3 · AWS Lambda + EventBridge +
SSM inside the always-free tier, minus pennies of ECR storage (the 2026-07-25 move off
Actions minutes removed the only metered wall) · the two snapshot-committing jobs still on
the GitHub Actions free tier · Apify wide sweep inside the free $5 credit · ntfy, Vercel
hobby, TheirStack free tier: $0.

## Provenance

Designed, researched (~360 verified fetches, endpoints probed live), spec'd, built, and
tested in one pass on 2026-07-13, from `docs/SPEC.md`. The 12 ATS adapters were verified
against live endpoints the same day; re-verify from a real Actions runner via
CI → Run workflow → smoke (datacenter egress differs from residential). History: the
`job-monitor` repo and the resume system merged here with both histories preserved.
