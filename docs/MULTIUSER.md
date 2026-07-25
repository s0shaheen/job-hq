# Running HQ for more than one person

Three people, three spreadsheets, one engine. Salman is the **operator**: the
only person who touches secrets, workflows, or this repo. Everyone else fills
in a Search Profile once and reads their digest.

## What each person gets

| | Salman | Dad | Roommate |
|---|---|---|---|
| Search | PM roles, national + remote | FP&A / reporting / treasury, **Chicago metro** | SWE / FDE, national + remote |
| Own spreadsheet | yes | yes | yes |
| Daily digest | ntfy push + digest | **email only** (no phone pushes) | ntfy push + digest |
| Gmail status capture | yes | yes | yes |
| Sees anyone else's pipeline | no | no | no |

Isolation is structural, not conventional: each user resolves their own
`sheet_id`, tab gids, and ntfy topics from their own registry block. Every
matrix leg exports `HQ_USER`, and `HQ_SHEET_ID` / `HQ_NTFY_TOPIC` env
overrides are **ignored** once a `users:` map exists — a single exported
override pointing three legs at one sheet is exactly the failure this
prevents.

## The Search Profile

`users/<name>/profile.yaml` is the durable record of what someone is looking
for. The Config tab of their own spreadsheet overrides any key at runtime, so
they can tune their search from their phone without a commit.

```yaml
role_family: financial planning & analysis
tag_domain: finance            # picks the tagger's seniority ladder + prompt
board_search_term: financial   # keyword sent to corpus-wide boards
countries: [United States]
metros: [Chicago]              # a LOCAL search; [] = anywhere in countries
yoe_max: 30
yoe_unknown: keep              # a finance ladder makes the PM proxy wrong
notify_channel: email          # ntfy | email | none
titles_include: [...]
titles_exclude: [...]
```

`tag_domain` matters more than it looks: the tagger used to be told it was
reading "product-manager job postings" and to normalize seniority to
`APM..VP`. Pointed at an FP&A posting that produces junk, and the YoE-unknown
gate then acts on the junk. Ladders live in `monitor/tagging.py`.

`metros` is the grain a local search needs. Chicago spans Illinois, Indiana
and Wisconsin suburbs that never contain the word "Chicago" (Naperville,
Hammond, Kenosha), while `state: IL` would admit Peoria, 170 miles away.
Metro membership is resolved deterministically in `monitor/metros.py`;
unrecognized cities resolve to blank and follow the `geo_unknown` policy —
never a guess.

## Adding a user

```sh
# 1. they create a Google Sheet and share it with the service account as Editor
# 2. write users/<name>/profile.yaml (copy the closest existing one)
# 3. provision — migrates a single-user registry to the multi-user shape on
#    first use, leaving the existing instance byte-for-byte equivalent
python -m tracker.provision --user dad \
    --sheet-id THEIR_SHEET_ID --owner them@gmail.com \
    --ntfy-jobs dad-jobs-<random> --ntfy-ops REDACTED-NTFY-TOPIC \
    --seed-companies --dry-run     # inspect, then re-run without --dry-run
# 4. grow their schedule lanes: cd infra/terraform && terraform plan, read it, then apply
#    (schedules = jobs x the registry's users: keys; provision wrote the key)
#    still-on-Actions workflows also need repo variable HQ_USERS = ["salman","dad"]
# 5. deploy the Gmail capture Apps Script in THEIR account (appsscript/README.md)
```

**Read the step-4 plan before applying.** A correct migration apply shows only two kinds of
change: `+ create` for the new user's lanes (`job-hq-<job>-dad`) and `~ update in-place` on the
existing lanes, whose `target.input` gains `"user":"salman"`. The default user
(`default_user` in `hq.config.yaml`) deliberately keeps the flat key and flat name
(`job-hq-monitor`, not `job-hq-monitor-salman`), because a schedule is addressed by map key in
Terraform state and by name in AWS — renaming one is a destroy + create of a live schedule.
**If the plan ever shows an `aws_scheduler_schedule` being destroyed, stop and work out why
before applying**; it means something claimed the flat key away from the default user. (A
missing or typo'd `default_user` fails the plan outright on a precondition, rather than
quietly renaming all seven lanes.)

Point every user's **ops** topic at the operator. A failure in your dad's
instance must page the person who can fix it, not the person who can't.

Step 5 is the only genuinely manual one: the Apps Script OAuth consent is
per-Google-account and cannot be automated. Budget 15 minutes sitting with
them once; after that their statuses advance from their own inbox forever.

## What is shared vs per-user

| Shared (root of `hq.config.yaml`) | Per user (`users.<name>`) |
|---|---|
| `service_account_email` | `sheet_id`, `tabs` (gids) |
| GitHub secrets: `GOOGLE_SERVICE_ACCOUNT_JSON`, `ANTHROPIC_API_KEY`, `APIFY_TOKEN`, `THEIRSTACK_API_KEY` | `ntfy.jobs`, `ntfy.ops`, `owner_email` |
| The company universe CSVs | Their Config tab + `users/<name>/profile.yaml` |

**Service-account quota, the one real scaling limit:** Google's 60 write
requests/minute is charged per *service account* per project — not per
spreadsheet. Three users on one service account share ONE bucket. Today's
volume is far under it (the daily sweep batches, and legs are staggered by
cron), but if 429s ever appear, the fix is a second service account rather
than throttling: each gets its own 60/min bucket. Everything else (Apps
Script quotas, Drive) is already per-Google-account and therefore per-user.

## Operating

- The scheduled bots run on Lambda with one EventBridge schedule per job **per
  user** (`job-hq-<job>-<user>`, payload `{"job":..,"user":..}`) — except the
  default user, whose lanes keep the flat `job-hq-<job>` name so the migration
  never destroys a live schedule; the handler exports `HQ_USER` for that
  invocation. The workflows still on Actions are a
  matrix over `vars.HQ_USERS` (default `["salman"]`, so an unset variable
  behaves exactly like the single-user system).
- `fail-fast: false` — one user's failure never cancels another's run.
- Concurrency groups are per-user (`hq-feed-writers-${{ matrix.user }}`), so
  three users run in parallel instead of queueing behind each other.
- Ops alerts are prefixed with the user (`[dad] Job monitor failed`).
- Snapshots are per-user (`snapshots/<user>/`, `monitor/snapshots/<user>.json`)
  — a shared path would have three legs overwriting each other every morning.

## Coverage for a local search (your dad's case)

A curated company list is the wrong tool for "any Chicagoland employer hiring
FP&A": the Chicago MSA has ~245,000 private establishments, and the hiring
happens on Workday/iCIMS/Taleo/ADP tenants nobody curates. That search is an
aggregator query, configured per user:

```
wide_location_ids: 4887398      # TheirStack catalog IDs (GET /v0/catalog/locations)
wide_credit_budget: 25          # max jobs RETURNED per run — a hard spend cap
```

TheirStack bills **1 credit per job returned**, and re-returning the same job
costs again — which is why the `discovered_at` cursor is mandatory and the
budget is enforced as the request limit rather than checked afterwards. The
free tier is 200 credits/month with a 125-job ceiling per query: fine for the
company-fenced sweep, too small for a metro-wide one. Size a real query for
free first with a blurred preview (`theirstack_body(..., preview=True)`),
then decide whether the $59 tier (1,500 jobs/month) is warranted.

Leaving `wide_location_ids` blank keeps the original company-fenced behavior,
so nothing changes for a national search.
