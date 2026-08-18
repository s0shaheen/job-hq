-- 20260818_223038_bound_class_is_decided.sql
--
-- WHAT THIS CHANGES and WHY. Migrations are append-only: this file will run
-- exactly once against production and can never be edited afterwards.
--
-- ADR-015 Q2 IS ANSWERED. Owner ruling on #210, 2026-08-18:
--
--   "the per-user limits are PROVIDER-SPEND PROTECTION, not commercial quotas.
--    Founding users are NOT exempt from them; CLAUDE.md already says the
--    free-forever exemption covers commercial quotas only."
--
-- `20260817_011844_per_user_rate_bounds.sql` shipped four bounds while that
-- question was open, and it routed the open question through this schema in two
-- places. This file closes both. It changes NO limit, NO window, NO class value
-- and NO flag — every behavioural column in `public.rate_bounds` is already
-- exactly what the ruling requires, which is the finding, not an omission:
--
--   quickadd.resolve  security     warm.start      provider
--   warm.concurrent   reliability  export.build    reliability
--
-- `bound_class` is `not null` with `check (bound_class in ('security',
-- 'provider', 'reliability'))`, so every row already carried a decided,
-- non-commercial class and no row could ever have carried a commercial one. The
-- ruling ratifies the classes rather than reassigning them. Reclassifying
-- anything here would be inventing a second ruling.
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE CLASS IS DECIDED; THE VALUES ARE STILL PLACEHOLDERS. The schema does not
-- conflate the two, which is why this file can record one without touching the
-- other. `is_placeholder` is documented as a fact about the NUMBER — "true =
-- nobody has decided this number yet" — and the ruling decided the CLASS. So
-- every row keeps `is_placeholder = true`, `tests/db/test_rate_bounds.py`'s
-- assertion that they all do stays exactly as strict as it was, and clearing a
-- flag here would be this file claiming an owner had picked 60, 10, 3 and 30.
-- Nobody has. The remaining owner input is four integers, and it is still one
-- UPDATE by the operator with no migration and no deploy.
--
-- What DID rot the moment the ruling landed is the prose: two comments and one
-- seeded `note` tell a reader the classification is an open question. A comment
-- that describes a decision as pending, after it was made, is worse than no
-- comment — the next person re-derives the answer, or worse, re-asks it. Prose
-- in the database is the database's problem, and this is the only lane that can
-- reach it.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────── the catalogue's own prose
--
-- `comment on` REPLACES rather than appends, so these three are idempotent by
-- construction — which matters because db/apply.sh's ledger has one documented
-- re-run case: a crash between "file applied" and "ledger row written" re-runs
-- the file. Everything in this migration survives that.

comment on table public.rate_bounds is
  'The per-user bound catalog: one row per meter, carrying its class (security | '
  'provider | reliability - never commercial, which is what founding users are '
  'exempt from), its limit and its window. Operator-writable; no browser role '
  'holds any privilege on it. The CLASS question is settled: ADR-015 Q2, owner '
  'ruling on #210 dated 2026-08-18, classified every per-user limit in this '
  'product as provider-spend and abuse protection rather than a commercial '
  'quota, so a founding account is subject to every row here. is_placeholder = '
  'true means the NUMBER is still an engineering guess.';

comment on column public.rate_bounds.bound_class is
  'security | provider | reliability. A founding user is subject to all three; '
  '"commercial" is deliberately not a value this column can hold. Ratified by '
  'ADR-015 Q2 (owner ruling on #210, 2026-08-18): these limits are provider-spend '
  'and abuse protection, and the free-forever exemption covers commercial quotas '
  'only. A future commercial quota is a different mechanism reading '
  'entitlements.invited, and it will not be able to hide in this table.';

comment on column public.rate_bounds.is_placeholder is
  'true = nobody has decided this NUMBER yet. It says nothing about the class, '
  'which ADR-015 Q2 decided on 2026-08-18 for every meter at once; the two are '
  'separate on purpose, because the class decides the code and the value only '
  'decides the threshold. Asserted true for every seeded row by '
  'tests/db/test_rate_bounds.py, so the flag cannot quietly become a lie.';

-- ─────────────────────────────────────────────────────── the stale seeded note
--
-- `warm.start`'s note ends "The DAILY cap's classification is the open owner
-- question (#210)." It is not open any more, and that sentence sits in data an
-- operator reads when deciding whether to touch the number.
--
-- GUARDED ON THE STALE TEXT, and never `update ... set note = <whole new note>`.
-- The seed's own reason applies here in the other direction: an operator may
-- have rewritten this note, and a blind overwrite would silently discard their
-- words the way `on conflict do update` would have discarded their number. The
-- guard also makes the statement idempotent — a second run matches nothing —
-- which is what the apply.sh crash window needs.
--
-- The daily cap itself is NOT catalogued here and this file does not catalogue
-- it. It lives in `app_start_warm_search`, derived by counting `warm_searches`
-- rows in the last 24 hours, with the number passed in as `p_daily_cap` from
-- `webapp/lib/warm/config.ts`. Moving it into this table is a mechanism change
-- with a live-state counter behind it, and the ruling asked for a
-- classification, not a rewrite. What the ruling settles is that the cap is
-- provider-spend, that it therefore keeps applying to founding accounts, and
-- that `tests/db/test_default_deny.py` is proving the right thing when it
-- asserts HQCAP for an `invited = true` account.

update public.rate_bounds
   set note = replace(
         note,
         'The DAILY cap''s classification is the open owner question (#210).',
         'The DAILY cap is PROVIDER-SPEND too, and applies to founding accounts: '
         'ADR-015 Q2, owner ruling on #210, 2026-08-18. It is still enforced in '
         'app_start_warm_search by counting warm_searches, not by this table.'),
       updated_at = now()
 where meter = 'warm.start'
   and note like '%The DAILY cap''s classification is the open owner question (#210).%';

-- No grants, no policies, no functions and no security-definer bodies are
-- touched by this file: `rate_bounds` keeps the privileges 20260817_011844 gave
-- it (operator-writable, no browser role holds anything), and the one DML
-- statement above rewrites a `note` string on a table no browser role can read.
