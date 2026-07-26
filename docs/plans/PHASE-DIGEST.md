# Phase 8 — the actionable email digest

Build-order step 8 (`docs/PRODUCT-SPEC.md` §J). Journey B4, notifications §F,
acceptance criteria **24** and **25**.

The premise: Dad may never open the app. So the email is the app. Every posting
line carries one-click **Interested** / **Not for me** links backed by signed
tokens, no login. And nobody gets a notification they did not ask for, on a
channel they did not pick, at an hour they said not to.

---

## 1. What exists today (verified against the code, not the spec)

The spec asserts three engine gaps. All three are real. Two are narrower than
stated, one is worse. A fourth gap the spec does not mention is the one that
would break B4 on day one.

| Spec claim | Verdict | What is actually there |
|---|---|---|
| "no quiet-hours logic exists" | **Confirmed** | `grep -ri "quiet"` over the whole repo hits only `docs/PRODUCT-SPEC.md`. No timezone is stored anywhere: `core/profile.py` has no `timezone` field, `users/*/profile.yaml` have none. Quiet hours needs a tz before it needs a clock. |
| "two push paths ignore `notify_channel`" | **Confirmed, and name them** | `monitor/wide.py:488` pushes unconditionally — it *does* load the profile (`monitor/wide.py:315`) but only reads `titles_*` and `gate_config()`. `tracker/digest.py:204` pushes unconditionally. The two that *do* respect it are `monitor/run.py` (`push_channel=prof.notify_channel` at :335, gated at :277) and `monitor/priority.py:156`. There is also a **third** path outside Python: `appsscript/capture/Code.gs:214` fires `jobsPush_` for OA/interview/recruiter/offer with no channel check at all. |
| "the digest email goes to a hardcoded address" | **Confirmed** | `appsscript/capture/Code.gs:175` — `MailApp.sendEmail(OWNER_EMAIL, ...)` where `OWNER_EMAIL` is the literal `"shaheensalmant@gmail.com"` at :34. `core/profile.py:55` declares `notify_email: str = ""` and **nothing in the repo reads it** (single grep hit). Per-user `owner_email` does resolve through `core.config.registry(user)`, so the value exists; the sender just never asks. |

**The fourth gap, unmentioned and fatal to B4.** `appsscript/capture/Code.gs`
converts the digest markdown to HTML with `markdownLiteToHtml_` (:496). It
handles `#`, `##`, `- ` and `**bold**`. It has **no link handling** — there is
no `href` anywhere in `Code.gs`. `tracker/digest.py:89` emits
`- [Acme — Product Manager](https://…)` per row, and that renders in the email
as literal bracket-and-paren text. *The current digest email cannot render a
link.* One-click action links are not a small addition to it; the composer has
to be replaced.

**Other things that do not exist and must be created:**

- `app_set_triage` — the Postgres function `webapp/lib/data/supabase-source.ts:161`
  calls by RPC. **It is in neither `db/migrations/0001_init.sql` nor
  `0002_invariants.sql`.** Production triage writes cannot work today; only the
  fixture source does. This phase has to build it anyway (the token action is
  the same command), so it lands here.
- Any email sender in Python. `core/notify.py` is ntfy-only. No `smtplib`,
  no Resend, no SendGrid anywhere in the repo.
- `profiles.notify` — the jsonb column exists (`0001_init.sql`, commented
  "digest email, ntfy topic, push preferences") with `default '{}'`. Nothing
  writes it, nothing reads it, it has no defined shape.
- `docs/plans/` (this file creates it).

---

## 2. Architecture

**The digest is composed and sent by the web app, triggered by the existing
cron.** Not by `tracker/digest.py`, and not by Apps Script.

Reasons, in order: the token secret must live in exactly one process, and the
process that verifies a token is a Next.js route on a public origin — so that
is where minting belongs; the HTML has to be generated next to the routes it
links to or the two drift; and Apps Script cannot render a link at all.

```
digest.yml (GitHub Actions, 06:40 CT)
  └─ POST https://<app>/api/digest/send   (header: X-HQ-Cron: <shared secret>)
       └─ for each user:  compose → mint tokens → Mailer.send
                                        │
   email ─ Interested ──► GET  /d/<token>   read-only confirm page
                          POST /d/<token>   ── app_set_triage(...) ──► one row + one event
```

`tracker/digest.py` and the Apps Script `sendDigest` keep running unchanged
against the sheet until the store flips (`docs/PRODUCT-SPEC.md` §I migration).
Two digests briefly land in the same inbox during rollout; that is visible and
correct, and better than a cutover.

**Email transport mirrors the DataSource keystone.** `webapp/lib/mail/mailer.ts`
— `Mailer` interface, `ResendMailer` (one `fetch` to `api.resend.com/emails`
with an `AbortSignal.timeout`, no SDK), `CaptureMailer` (in-memory, used by
every test and by demo mode). Rule 1 of "Rules that already cost a production
incident": every external call gets a bound.

---

## 3. Token design

### 3.1 Format

```
/d/<v1>.<kid>.<payload_b64url>.<sig_b64url>
payload = {"u":<user uuid>,"p":<posting_key>,"a":"interested"|"dismissed",
           "t":"digest_action","e":<exp epoch s>,"j":<16 random bytes b64url>}
sig     = HMAC-SHA256(SECRET[kid], "v1." + kid + "." + payload_b64url)
```

Node `crypto.createHmac` + `crypto.timingSafeEqual`. No new dependency. Route
handlers declare `export const runtime = "nodejs"`.

Decisions, and why each one:

- **The action is inside the signature.** One token = one user × one posting ×
  one action, so two links per row = two tokens. The tempting shortcut —
  one token plus `?a=interested` — makes the action forgeable by anyone
  holding either link, and a URL-rewriting mail gateway is entitled to mangle
  query strings.
- **The token is a path segment, not a query parameter.** Query strings land in
  `Referer`, in proxy access logs, and in analytics. The routes also send
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store`,
  `X-Robots-Tag: noindex`.
- **Expiry 7 days.** The digest is daily; a Monday email opened Saturday should
  still work, and a link older than the next week's digest is noise. Expiry is
  a floor, not the only check: the handler independently refuses if the posting
  is `Closed` or the row already carries a triage.
- **`kid` (key id) is in the signed prefix.** Rotation retires a secret and
  every outstanding token signed with it dies at once. Two keys are accepted
  during a rotation window (`HQ_DIGEST_KEYS` = `kid:secret` pairs, newest first).
- **`j` (jti) makes state possible.** It is the primary key of `digest_tokens`,
  which is what single-use, revocation, and replay-with-the-same-answer all
  hang off.

### 3.2 Prefetch — the failure mode to design around

Outlook ATP Safe Links, Proofpoint URL Defense, Mimecast, Barracuda and
several mobile clients **GET every link in an email before a human sees it**.
A GET that mutates will therefore fire itself. This is not hypothetical and it
is not solvable with User-Agent sniffing.

**Rule: `GET /d/<token>` never writes. Ever.** It verifies the signature and
renders a confirmation page whose single large button POSTs the same token
back. The mutation lives only in `POST /d/<token>`.

Consequences accepted deliberately:

- It costs one extra tap. The confirmation page is one full-width button,
  autofocused, above the fold, with the company and title restated — which is
  also the last chance to notice a misclick.
- CSRF is a non-issue: the token *is* the bearer secret, and an attacker who
  can forge a cross-site POST still cannot know it. No cookie, no session.
- A scanner that executes JS and clicks buttons would still fire it.
  Considered and rejected: requiring a GET-issued nonce in the POST body. It
  adds a second state machine to defend against a scanner class that also
  defeats it (it would GET first). The real defense is the next section:
  the action is idempotent and reversible in one click.
- The GET records `first_viewed_at` on the token row for debugging, labelled as
  *viewed*, never as *opened by a human*. A prefetch must not become a metric
  that lies.

### 3.3 Single-use, replay, revocation

Single-use for the **state change**; replay-safe for the **display**.

| POST arrives | Behaviour |
|---|---|
| first time, row untriaged | `app_set_triage` runs; `digest_tokens.used_at` + `outcome` recorded; success page |
| again, same token | no write; renders the recorded outcome ("Already saved Tuesday") + Undo |
| the *sibling* token (other action), row already triaged by the first | no write; "You already marked this Interested" + a one-click *change to Not for me* |
| row triaged in the app since the email went out | no write; "You already decided this in the app" |
| after `used_at`, `revoked_at` set | generic invalid page |

Undo is its own freshly-minted single-use token (24h, `t:"digest_undo"`)
handed to the success page — never the original token replayed with an inverted
action, because the original is by then a known-used value that may sit in a
proxy log.

Revocation has three levers, coarse to fine:

1. `kid` retirement — kills every token signed with that secret.
2. `profiles.notify.token_epoch` (integer, in the signed payload as `n`) — a
   user clicking *"this wasn't me"* bumps it and every outstanding link of
   theirs dies, with no effect on anyone else.
3. `digest_tokens.revoked_at` — one link.

### 3.4 Landing page states (all six ship together)

| State | Page shows |
|---|---|
| valid, unused | company · title · comp · location, one big **Yes, I'm interested** / **Not for me** button, and a "view in the app" link |
| POST success | "Saved — Acme, Senior Financial Analyst is in your pipeline", Undo, and the next untriaged posting as a second offer |
| already used, same action | "Already saved on Tue 21 Jul", current state, Undo |
| already used, other action / decided in app | states which decision won and offers the reverse in one click |
| expired | "This link expired on 28 Jul." + sign-in link to `/queue`, and the posting is named so the email still has value |
| bad signature, unknown kid, revoked, wrong epoch | one generic *"This link isn't valid any more."* — deliberately identical copy for forged and revoked, so the page is not an oracle |

Every state renders standalone HTML with inline styles and no client JS beyond
the form submit — the landing page is reached from a mail client's in-app
browser, which is the least capable browser in the fleet.

---

## 4. Channel matrix and quiet hours (§F, AC 24 + 25)

### 4.1 The choke point is the fix, not the call sites

`monitor/priority.py:156` gets this right by checking
`prof.notify_channel == "ntfy"` at the call site. That pattern is precisely why
`monitor/wide.py` and `tracker/digest.py` are broken: a call-site check is a
thing a future caller forgets.

New `core/channels.py`:

```python
def allow(user: str, *, event: str, urgency: str = "normal",
          now: datetime | None = None) -> Decision   # send | drop | defer(until)
```

`core/notify.py:push()` gains a required `event=` argument and calls `allow()`
before it resolves a topic. `kind="ops"` bypasses (ops alerts page the
operator, not the user — AC24 is about `kind="jobs"`). The call-site checks in
`run.py` and `priority.py` are then deleted, because two enforcement points is
one too many.

Event types: `digest`, `new_roles`, `status_change`, `oa_interview`,
`stale_nudge`. Channels per type: `push` | `email` | `both` | `none`.

Defaults (`core/config_defaults.yaml` + `profiles.notify` shape):

| | owner | Dad | roommate |
|---|---|---|---|
| digest | both | email | push |
| new_roles | push | email | push |
| status_change | push | email | none |
| oa_interview | push | email | push |
| stale_nudge | none | email | none |

`Profile.notify_channel` stays as the coarse per-user default and seeds the
matrix, so no existing YAML breaks; the matrix overrides per type.

### 4.2 Quiet hours

- New `Profile.timezone` (default `America/Chicago`) and
  `Profile.quiet_hours` (default `"21:00-07:00"`). Neither exists today.
- `urgency="urgent"` (`oa_interview`, `offer`) ignores quiet hours entirely.
- Non-urgent inside the window **defers, never drops**. The decision returns a
  wake time; the caller writes a row to `notification_outbox`; the existing
  2-hourly `tracker.yml` chain flushes anything due. A dropped notification is
  indistinguishable from a broken system.
- Local calendar day, not UTC — same trap as edge case G14 (snooze at 23:50).
  Computed with `zoneinfo`, no offset arithmetic.

### 4.2b What increments 1 and 2 actually landed

Written down because the sections above describe the design and the design is
larger than what ships. Verified against the code, not the intent:

- **The shipped default window is `21:00-06:30`, not `21:00-07:00`.** The digest
  composes at 06:40 CT and a 07:00 window would hold the daily briefing until
  the next flush at 07:31.
- **Two of the five events have a producer.** `digest` (`tracker.digest`) and
  `new_roles` (`monitor.run`, `monitor.wide`, and `monitor.priority`, which is
  retired to local runs — in no workflow and no `handler.JOBS` chain).
  `status_change`, `oa_interview` and `stale_nudge` are knobs with validators,
  Profile fields and no Python caller — reserved, and labelled as such in the
  RUNBOOK's knob table.
- **The Outbox tab will stay near-empty until a later phase.** Every scheduled
  producer composes between 06:40 and 18:00 CT in daylight time, and the flush
  re-asks the policy before delivering, so nothing sends inside the window
  either. The crons are fixed UTC: in standard time the digest (05:40 CT) and
  the morning sweep (06:00 CT) do fall inside it and will start deferring in
  November. Until then a rows-in-Outbox observation is a signal, not routine.
- **The Apps Script capture path is not behind the choke point.**
  `appsscript/capture/Code.gs` calls `jobsPush_` for OA / interview / recruiter
  / offer on a 15-minute trigger and posts to ntfy directly — no channel
  ceiling, no quiet hours, a 3am push. For OA and interview that agrees with
  the policy (both are urgent and exempt). For recruiter and offer it does not.
  It has no Python runtime, so `core.channels` cannot reach it; the fix lands
  with the Apps Script work, not here.
- **A leak today reaches the operator, not Dad.** The live registry is flat, so
  `core.notify._topic` resolves one jobs topic for every user. An AC24
  regression right now is noise on Salman's phone; it becomes a real leak the
  day the registry grows per-user topics, which is why the enforcement lands
  before the users do.
- **Accepted trade: a queued push is marked "pushed" before it is sent.**
  `push()` returns True for "sent OR durably queued", and `monitor.run` stamps
  `pushed_at` on the Feed rows on that True. If the row is later abandoned
  those rows still read as pushed and are never re-pushed. Un-marking would
  mean reaching back into three producers' sheets hours later to reverse a
  write — a larger correctness surface than the failure it fixes. Instead the
  abandon path pages ops with the row key and the notification's own text, so
  the affected roles are named exactly once more.

### 4.3 Unsubscribe

- Visible footer link → `/n/unsub/<token>` where the token carries the **event
  type of the email it was in**. The page shows the whole matrix with that one
  row highlighted and pre-toggled off, and a "turn everything off" that needs a
  second explicit click.
- `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  (RFC 8058) headers, pointing at the same token. The mail provider POSTs it
  without asking the user, so it **must** map to the single event type — a
  global opt-out fired by a provider heuristic is exactly the outcome §F
  forbids. Idempotent: a second POST changes nothing.

---

## 5. Schema (migration `db/migrations/0003_digest.sql` — does not exist)

```sql
-- the function webapp/lib/data/supabase-source.ts already calls, and which
-- has never existed. Row + audit event in ONE transaction, security definer.
create function public.app_set_triage(
  p_user_id uuid, p_posting_key text, p_triage text, p_snooze_until date,
  p_reason text, p_idem text, p_expected_updated_at timestamptz
) returns jsonb ...   -- raises 'conflict' / 'stale'; replays on a seen p_idem

create table public.command_idempotency (   -- what makes a double-tap free
  user_id uuid, idem_key text, result jsonb, created_at timestamptz,
  primary key (user_id, idem_key));

create table public.digest_sends (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  digest_date date not null,
  sent_at timestamptz, provider_id text, row_count int not null default 0,
  unique (user_id, digest_date));          -- a cron retry cannot double-send

create table public.digest_tokens (
  jti text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  posting_key text not null references public.postings(key) on delete cascade,
  action text not null check (action in ('interested','dismissed','undo')),
  send_id bigint references public.digest_sends(id) on delete cascade,
  expires_at timestamptz not null,
  first_viewed_at timestamptz,             -- prefetch, NOT "a human opened it"
  used_at timestamptz, outcome jsonb, revoked_at timestamptz,
  created_at timestamptz not null default now());

create table public.notification_outbox (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  event text not null, channel text not null, urgency text not null default 'normal',
  payload jsonb not null default '{}', deliver_after timestamptz not null,
  delivered_at timestamptz, attempts int not null default 0);
```

RLS: `digest_tokens`, `digest_sends`, `notification_outbox`,
`command_idempotency` get RLS enabled and **no browser policies at all** —
they are touched only by the service role inside route handlers, matching the
`0001_init.sql` closing rule. `profiles.notify` gains a documented shape and a
`check (jsonb_typeof(notify) = 'object')`.

The token routes need the service role, which the app has deliberately never
held (`webapp/lib/supabase/server.ts` says so). They get it through a separate
`webapp/lib/supabase/admin.ts` that is `import "server-only"`, reads
`SUPABASE_SERVICE_ROLE_KEY`, and is importable **only** from `app/d/**`,
`app/n/**` and `app/api/digest/**` — enforced by a unit test that greps the
import graph, because a convention here is worth nothing.

---

## 6. Tests, written before the code

Layer rule from `docs/WEBAPP-BUILD.md`: Vitest for logic, Playwright for
anything with layout. **An email body is HTML, so it gets a layout test** —
rendered into a Playwright page at 320px and 600px. jsdom cannot do it.

**Vitest — `webapp/tests/unit/digest-token.test.ts`**
1. round-trip mint → verify.
2. one flipped byte in payload or sig → reject.
3. `a` swapped from `interested` to `dismissed` → reject (it is signed).
4. unknown / retired `kid` → reject; both keys accepted mid-rotation.
5. `exp` in the past → reject with `expired`, distinct from `invalid`
   internally, identical in the rendered copy.
6. bumped `token_epoch` → reject.
7. verify is constant-time (`timingSafeEqual` is used — asserted structurally).

**Vitest — `webapp/tests/unit/digest-email.test.ts`**
8. every posting row emits exactly two `<a href="https://…/d/">` links.
9. no `display:flex`, no `display:grid`, no `<style>` block, no external
   stylesheet, no `class=` doing layout work — Outlook's Word engine ignores
   all of it.
10. rendered size < 90 KB (Gmail clips at ~102 KB and would eat the footer,
    the unsubscribe link, and the last postings).
11. row cap honoured with an explicit "+N more in the app" line.
12. two users composed in one run → each body contains only its own postings
    and its own recipient (AC-adjacent to 24; the multi-user leak class).
13. every URL is absolute https against the configured origin; a missing
    origin env var fails the compose loudly rather than emitting `/d/…`.

**Vitest — `tests/core/test_channels.py` (Python)**
14. **AC24** — `notify_channel=email`: every `notify.push(event=…, kind="jobs")`
    for that user returns `drop`, exercised through `monitor.run`,
    `monitor.priority`, `monitor.wide` and `tracker.digest` with a recording
    fake. Plus a static test asserting no module posts to ntfy except
    `core.notify._send` (the `wide.py` regression, made unrepeatable).
15. `kind="ops"` is never suppressed by a user's channel setting.
16. **AC25** — 22:00 local, `event="new_roles"` → `defer(until=07:00 local next
    day)`, outbox row written, nothing sent; flushing at 07:00 sends exactly
    once. 22:00 local, `event="oa_interview"` → sends immediately.
17. quiet hours across a DST boundary and across midnight-in-UTC resolve on the
    user's local calendar day.

**Playwright — `webapp/tests/e2e/digest-links.spec.ts`**
18. `GET /d/<token>` returns 200, renders the confirm button, and
    `user_postings.updated_at` is **unchanged** — the prefetch test. Run twice
    to simulate Safe Links then the human.
19. POST → success page; the fixture source shows one application at `Queued`
    and one event (**AC9** reused through a second entry point).
20. POST the same token again → no second application, no second event, the
    recorded outcome page (**AC26** semantics via a different door).
21. Undo from the success page → triage reverts, compensating event appended
    (**AC10**).
22. expired / revoked / tampered tokens → their three pages, no writes.
23. the email HTML rendered at 320px: no horizontal overflow, each action link
    ≥ 44×44 px with ≥ 8px separation, axe `wcag2a/wcag2aa` clean in both color
    schemes.
24. `/n/unsub/<token>` one-click POST flips exactly one matrix key; the others
    are byte-identical afterwards.

**Human check, per the rule that produced matrix rows 22–24:** a demo-only
`/dev/digest-preview` route renders the last composed email. Open it. Look at
it. On a phone.

---

## 7. New failure-mode matrix rows

Append to `docs/WEBAPP-BUILD.md`, continuing from 24.

| # | Failure mode | Enforced by | Status |
|---|---|---|---|
| 25 | **Outlook Safe Links prefetches the action link and triages the row before a human sees the email** | `GET /d/<token>` has no write path; E2E asserts `updated_at` unchanged after two GETs; unit test greps the GET module for any `app_set_triage` / service-role call | ⬜ |
| 26 | Same emailed link clicked again next week → duplicate application + duplicate event | `digest_tokens.used_at` + `command_idempotency`; replay renders the recorded outcome; test POSTs 3× and asserts exactly one event | ⬜ |
| 27 | Action swapped by editing the URL (`interested` → `dismissed`) | action is inside the HMAC payload; tamper test asserts 400 and zero writes | ⬜ |
| 28 | Leaked or logged token still works after rotation | `kid` in the signed prefix + `token_epoch` in the payload; test retires a key and replays | ⬜ |
| 29 | Digest links point at localhost or a preview deployment | compose requires an absolute https origin from env and throws otherwise; unit test | ⬜ |
| 30 | Gmail clips the email at ~102 KB, eating the last rows and the unsubscribe footer | body size asserted < 90 KB; hard row cap with "+N more" | ⬜ |
| 31 | Email renders as a broken stack in Outlook (Word engine: no flex, no grid, no `<style>`) | HTML lint test — tables-only layout, inline styles only, no flex/grid/stylesheet | ⬜ |
| 32 | Action buttons untappable on a phone (small or adjacent targets) | email HTML rendered in Playwright at 320px: ≥ 44×44 px, ≥ 8px apart, no horizontal overflow | ⬜ |
| 33 | Dark-mode mail client inverts the email into unreadable text | explicit background + color on every container; axe contrast on the rendered body in both schemes | ⬜ |
| 34 | A user on `notify_channel=email` gets an ntfy push from *any* job | enforcement moved into `core.notify.push` (choke point); AC24 test across all four jobs; static test that nothing else posts to ntfy | ⬜ |
| 35 | Quiet-hours suppression silently **drops** instead of deferring | `notification_outbox` row asserted at suppress time; flush test delivers exactly once at 07:00 local | ⬜ |
| 36 | An OA invite is held until morning by quiet hours | urgency override test at 22:00 local (AC25, second half) | ⬜ |
| 37 | Unsubscribe (especially the provider's RFC 8058 one-click POST) turns off everything | test asserts exactly one matrix key changed and the rest are byte-identical; no code path writes all keys | ⬜ |
| 38 | Digest sent to the wrong person — hardcoded address, or one matrix leg's rows in another's email | recipient resolved from the same query that selected the rows; two-user compose test asserts per-user isolation of body *and* recipient | ⬜ |
| 39 | Cron retry sends the digest twice | `digest_sends unique (user_id, digest_date)`; second send is a no-op returning the first send id | ⬜ |
| 40 | Landing page reveals a posting the token's user was never gated | user comes from the signed token, never a query param; test uses A's token against a posting only B has | ⬜ |
| 41 | Posting closed between send and click → the link 500s or triages a dead row | handler checks `postings.status`; renders "no longer listed" and offers `dismissed`/`expired`; test | ⬜ |
| 42 | Digest email renders literal `[title](url)` markdown (today's real behaviour: `Code.gs:496` has no link support) | the new composer emits HTML directly and never markdown-lite; test asserts an `<a href` per posting row | ⬜ |

---

## 8. Increments

Each ships alone and is verifiable alone.

| # | Ships | Discharges | Size |
|---|---|---|---|
| **1** | `core/channels.py` + `notify.push(event=…)` choke point; matrix defaults in `core/config_defaults.yaml` and `profiles.notify`; delete the two call-site checks | **AC24**, rows 34, 38 | S — half a day. Value alone: Dad stops being phone-spammed the moment he is added, which today he would be. |
| **2** | `Profile.timezone` + `quiet_hours`; `allow()` returns `defer`; `notification_outbox` + a flush step in the `tracker.yml` chain | **AC25**, rows 35, 36 | M — a day. Value alone: no 3am pushes. |
| **3** | `0003_digest.sql`: `app_set_triage`, `command_idempotency`, RLS. Point `SupabaseDataSource.setTriage` at the real function | AC9/10/26 in production (they only pass against fixtures today) | M — a day. Value alone: **triage writes work against Postgres for the first time.** |
| **4** | `webapp/lib/tokens.ts` mint/verify; `digest_tokens`; `app/d/[token]` GET + POST with all six states; `lib/supabase/admin.ts` + its import-graph test | rows 25–28, 40, 41; AC9/10 through a second door | L — two days. The core of the phase. |
| **5** | `lib/digest/compose.ts` (HTML), `lib/mail/mailer.ts` (Resend + Capture), `app/api/digest/send` + the cron header, `digest_sends`, `/dev/digest-preview` | rows 29–33, 39, 42 | L — two days. Value alone: **B4 works end to end.** |
| **6** | `/n/unsub/[token]`, `List-Unsubscribe` headers, the per-type preferences page in the app | row 37 | S — half a day. |

Order is load-bearing: 1 and 2 are pure engine work that makes the system safe
to point at a second human, and they ship before anything mails anybody. 3
unblocks 4. 5 is worthless without 4.

## 9. Decisions not to re-litigate

1. **GET never writes.** Any future "make it one click instead of two" must be
   answered with row 25, not with a UA allowlist.
2. **One token per action.** Not one token plus a query parameter.
3. **The digest is composed by the web app.** `tracker/digest.py` keeps serving
   the sheet era and is not extended with links.
4. **Suppressed ≠ dropped.** Quiet hours always writes an outbox row.
5. **Unsubscribe is per-type.** The provider's one-click POST maps to the type
   of the email it fired from, and nothing wider.
6. **The channel check lives in `core.notify.push`.** Call-site checks are how
   `wide.py` ended up broken; do not add a second enforcement point.
