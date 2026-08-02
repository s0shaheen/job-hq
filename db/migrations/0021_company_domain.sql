-- 0021 — the engine fills a company's DOMAIN, and only where no person has
-- answered. The LogoAvatar's backend prerequisite.
--
-- Reading order: 0013_referral.sql, then 0016_linkedin_fill.sql. This file is the
-- same shape as 0016, one column over: a new field on the shared company row, a
-- provenance twin that records WHO last answered it, and one engine-only fill
-- function that writes the field where nobody has and never where somebody has.
-- Everything 0016's header argues about `linkedin_company_id` applies verbatim to
-- `domain`, so it is not re-argued here — only the two things that differ are:
--
--   1. WHAT IT IS FOR. The redesign's LogoAvatar keys a company logo off a bare
--      host: `https://img.logo.dev/{domain}` first, a favicon service second, a
--      2-letter monogram last (docs/plans/LOGO-AVATAR.md). A wrong domain renders
--      the wrong company's logo — silently, behind an <img> that loads — so the
--      column is CANONICALIZED and VALIDATED at the door (`hq_normalize_domain`)
--      and garbage is refused rather than stored. An absent domain is fine: the
--      monogram covers it. A wrong one is not.
--
--   2. WHERE IT COMES FROM, FREE. `monitor/wide.py`'s daily TheirStack sweep already
--      buys job rows whose `company_object` carries `domain` beside the `linkedin_id`
--      0016 harvests (probe #2, 2026-07-26; the domain field measured 2026-07-27).
--      We were parsing that payload and dropping the domain. This function is where
--      it lands — ZERO extra API credits, the same lane, the same pass.
--
-- NB on "nullable". The task framed this column as nullable; it is instead
-- `not null default ''`, byte-identical to `linkedin_company_id` (0013) and its
-- source twin, because the whole blank-guard machinery this file reuses —
-- `hq_blank_trim(x) = ''`, the anchored regex, the conditional touch trigger — is
-- written against '' and never NULL. Blank ('') IS the absent state; the view
-- model (`str()` in supabase-source.ts) maps it to `null` for the UI. Diverging to
-- a genuinely NULL column would fork the emptiness test from the sibling it must
-- agree with, which is the exact divergence 0016's guards exist to prevent.

-- ============================================================ canonicalization

/**
 * A raw domain/URL -> a bare host, or '' when it is not a plausible host.
 *
 * A WRONG DOMAIN IS WORSE THAN A MISSING ONE, the same asymmetry
 * `core.linkedinids` states for the id: the missing one renders a monogram, the
 * wrong one renders another company's logo behind an <img> that loads and looks
 * right. So this REFUSES more than it accepts — anything that does not reduce to
 * `label(.label)*.tld` with an alphabetic TLD answers '', and the caller stores
 * nothing rather than a guess.
 *
 * The steps, in order, are the ones that separate "acme.com" the host from the
 * dozen shapes a provider or a paste delivers it in:
 *   - `hq_blank_trim` — the same zero-width/space fold every id and name goes
 *     through (0010), so `﻿Acme.com ` is `acme.com`, not a third value;
 *   - REFUSE non-ASCII, before anything is folded. `lower()` is the one step whose
 *     behaviour is locale-dependent, and it is where this function and its Python
 *     mirror stopped agreeing: executed under en_US.utf8, `lower('RAMP.CO' ||
 *     chr(304))` (U+0130, dotted capital I) is `ramp.coi` here — the combining dot
 *     dropped, 8 characters, ACCEPTED by the host gate below — while Python's
 *     `str.lower()` yields `i` + U+0307 and refuses it. One input, two stored
 *     answers, decided by which side ran. Turkish dotless ı and the Greek final
 *     sigma are the same bug in different characters. Refusing non-ASCII outright is
 *     the rule both sides can spell identically, and it costs nothing real: the gate
 *     below admits only `[a-z0-9.-]` anyway, and an internationalized domain arrives
 *     punycoded (`xn--…`), which is ASCII. It runs AFTER the trim so a zero-width or
 *     NBSP the trim already removes cannot reject an otherwise-good host;
 *   - lower;
 *   - strip a scheme (`https://`) and a protocol-relative `//`;
 *   - strip userinfo (`user:pass@`) — before the path is cut, so an `@` inside a
 *     path is not mistaken for it;
 *   - cut everything from the first `/`, `?` or `#`: the path, query and fragment;
 *   - cut a `:port`;
 *   - strip a leading `www.` — logo.dev keys on the registrable host and `www` is
 *     noise that would split `www.acme.com` and `acme.com` into two logos.
 *
 * The final gate is a hostname shape with an ALPHABETIC TLD of 2-63 chars, and the
 * ALPHABETIC half is what rejects an IPv4 literal: logo.dev has no logo for an IP,
 * and an IP in this column is a bug upstream, not a host. The LENGTH bound is not
 * what does it — `169.254.169.254` (the cloud metadata address) and `192.168.1.10`
 * both end in labels of 2+ characters and sail straight through an alphanumeric TLD.
 * An earlier version of this comment credited the bound, and the only IP in the test
 * corpus was `1.2.3.4`, whose refusal comes from the bound rather than from `[a-z]` —
 * so widening the TLD to `[a-z0-9]` passed the entire suite while the function
 * started accepting the metadata address.
 *
 * THREE rules refuse a network address and they refuse DIFFERENT ones, so all three
 * are pinned separately (tests/core/test_domains.py's
 * `test_a_network_address_is_never_a_company_domain`, and every string below also
 * runs through THIS function via the shared corpus and the door's refusal list):
 *   - `[a-z]` (the TLD): every DOTTED spelling whose final label is 2+ characters —
 *     169.254.169.254, 192.168.001.010, and the same metadata address written
 *     0xa9.0xfe.0xa9.0xfe (hex) or 0251.0376.0251.0376 (octal). A resolver accepts
 *     all three spellings; the length bound never sees the last two.
 *   - `{2,63}` (the length bound): the dotted forms ending in one digit — 127.0.0.1,
 *     0.0.0.0, 1.2.3.4.
 *   - `(…\.)+` (at least one dot): every FLAT spelling — localhost, 2130706433,
 *     2852039166, 0xa9fea9fe, 017700000001.
 * IPv6 (`::1`, `[fd00::1]`, `[::ffff:169.254.169.254]`, `[2001:db8::1]:8080`) dies on
 * the label CLASS: neither `:` nor a bracket is in `[a-z0-9-]`.
 *
 * `core.domains.normalize_domain` is the Python mirror; `tests/db/test_company_domain.py`
 * runs the two over one corpus so the harvest and the door cannot disagree about
 * which strings are a host — the `core.linkedinids.is_blank` parity pattern.
 */
create or replace function public.hq_normalize_domain(p_raw text)
returns text
language sql
immutable
set search_path = pg_catalog, public, pg_temp
as $$
  with trimmed as (
    select public.hq_blank_trim(coalesce(p_raw, '')) as raw
  ),
  cut as (
    select case
             -- The ASCII gate, before the fold. See the header: `lower()` is where
             -- this function and its Python mirror stop agreeing, so the inputs that
             -- make it diverge are refused before either side folds anything.
             when raw ~ '[^[:ascii:]]' then ''
             else
               regexp_replace(
                 regexp_replace(
                   regexp_replace(
                     regexp_replace(
                       regexp_replace(
                         regexp_replace(
                           lower(raw),
                           '^[a-z][a-z0-9+.-]*://', ''    -- scheme
                         ),
                         '^//', ''                        -- protocol-relative
                       ),
                       '^[^/?#@]*@', ''                   -- userinfo, before any path
                     ),
                     '[/?#].*$', ''                       -- path / query / fragment
                   ),
                   ':[0-9]+$', ''                         -- port
                 ),
                 '^www\.', ''                             -- a leading www.
               )
           end as host
      from trimmed
  )
  select case
           when host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
             then host
           else ''
         end
    from cut
$$;

comment on function public.hq_normalize_domain(text) is
  'canonicalize a raw domain/URL to a bare lowercase host (scheme/userinfo/path/port/www stripped), or '''' when it is not a plausible host — a wrong domain is a wrong logo, so garbage is refused not stored (0021)';

-- ============================================================ the columns

/**
 * The domain, and who last answered it.
 *
 * `domain_source` is 0016's `linkedin_id_source` for this field, and for the same
 * reason: two writers with different authority (an engine harvest, and — the day a
 * correction UI exists — a person) need the row to remember which one spoke, so a
 * BLANK domain carrying `'human'` is a deliberate clear no bot may refill, not an
 * invitation. Free-vocab with no CHECK, 0008's precedent: `public.companies` is
 * bulk-upserted in 500-row chunks, and a table-wide CHECK lets one unrecognised
 * value wedge the whole mirror. The closed set lives in the function below;
 * readers treat anything that is not exactly 'human' as not-human, the safe
 * direction (an engine write is recoverable, overwriting a person is not).
 *
 * No data backfill (unlike 0016's): nothing wrote this column before today, so
 * every existing row is already ('', '') and there is no human research to label.
 *
 * The version token and the touch trigger are 0013's, already installed on this
 * table: `companies_touch` fires `when (old.* is distinct from new.*)`, which
 * covers these new columns for free — a real domain fill moves the shared row's
 * token (correct; a tab holding the old value should conflict) and a no-op fill,
 * which returns before the UPDATE, never reaches the trigger at all.
 */
alter table public.companies
  add column if not exists domain        text not null default '',
  add column if not exists domain_source text not null default '';

comment on column public.companies.domain is
  'company domain as a bare host (the LogoAvatar key), engine-harvested off the same TheirStack company_object as linkedin_company_id; free-vocab at the column, canonicalized+validated at the door (hq_normalize_domain), '''' until filled (0021)';
comment on column public.companies.domain_source is
  'who last answered domain: human | engine | '''' (nobody). A BLANK domain with source=''human'' is a deliberate clear and no bot may refill it (0021)';

/**
 * THE COLUMN'S OWN GUARD, not just the door's.
 *
 * `hq_fill_domain` normalizes what it stores, and `core.domains` normalizes before
 * it calls — but neither is the only writer this column will ever have. The
 * `domain_source = 'human'` vocabulary exists precisely because a BROWSER write path
 * is expected here, `set_human()` in `tests/db/test_company_domain.py` already writes
 * the cell directly, and a psql fix or a bulk mirror reaches the table without
 * passing any door at all. A wrong host in this column renders another company's
 * logo behind an <img> that loads and looks right — a failure with no error and no
 * signal — so the invariant belongs where it cannot be routed around.
 *
 * `company_key = company_name_key(company_key)` (0014/0017) is the exact precedent,
 * down to the shape: assert the value is its own canonical form rather than
 * re-spelling the rule, so there is ONE definition of a host and the CHECK cannot
 * drift from the function the Python mirror is pinned against. `hq_normalize_domain`
 * is `immutable` (required for a CHECK) and carries its own `search_path`, so a
 * shadowed resolution cannot change what it admits.
 *
 * '' passes: `hq_normalize_domain('') = ''`, and '' is the absent state.
 *
 * WHY THIS IS SAFE ON A BULK-UPSERTED TABLE, where the header argues a table-wide
 * CHECK on `domain_source` would be reckless: the 500-row `companies` mirror does not
 * write `domain` at all — only `hq_fill_domain` and a future human door do — so no
 * unrecognised provider value can reach this constraint and wedge the sweep. The
 * asymmetry is real: `domain_source` is free vocabulary whose closed set lives in the
 * function, `domain` is a CANONICAL FORM with exactly one definition.
 *
 * No `not valid`: every existing row is ('', ''), so the validation scan is
 * guaranteed to pass and leaving it unvalidated would only hide that fact.
 */
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'companies_domain_is_canonical') then
    alter table public.companies add constraint companies_domain_is_canonical
      check (domain = public.hq_normalize_domain(domain));
  end if;
end
$$;

-- ============================================================ the grid row, again

/**
 * `app_company_row` re-declared to carry `domain` beside the fields 0016 added.
 *
 * REPLACED, NOT WRAPPED — 0008/0013/0016's rule: the write paths and their replays
 * must not answer differently-shaped objects, and a second builder for "the same
 * row plus one field" is that divergence with a different name. ADDITIVE: one key,
 * nothing reordered, nothing renamed. `toCompanyView` in supabase-source.ts reads
 * it off the nested `companies` object, the same place it takes every other shared
 * fact. `domain_source` is deliberately NOT carried — the UI reads the domain to
 * build a logo URL and nothing gates on its provenance yet, so exposing it would be
 * a field no reader has (the correction control it would feed does not exist).
 */
create or replace function public.app_company_row(uc public.user_companies)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'company_id',   uc.company_id,
           'monitor',      uc.monitor,
           'priority',     uc.priority,
           'seeded',       uc.seeded,
           'review_state', uc.review_state,
           'updated_at',   uc.updated_at,
           'companies', jsonb_build_object(
             'id',                  c.id,
             'name',                c.name,
             'ats',                 c.ats,
             'slug',                c.slug,
             'source',              c.source,
             'reliability_tier',    c.reliability_tier,
             'resolution_method',   c.resolution_method,
             'linkedin_company_id', c.linkedin_company_id,
             'linkedin_id_source',  c.linkedin_id_source,
             'domain',              c.domain,
             'updated_at',          c.updated_at
           )
         )
    from public.companies c
   where c.id = uc.company_id
$$;

revoke all on function public.app_company_row(public.user_companies) from public;

-- ============================================================ the engine door

/**
 * Fill a company's domain from a provider payload — where nobody has answered.
 *
 * This is `hq_fill_linkedin_company_id` (0016) for the `domain` field, and every
 * structural choice is that function's, made for the reasons its header spells out
 * at length: MATCHED BY NORMALIZED NAME (`company_name_key`, never raw `=`); THE
 * WHOLE COMPANY LOCKED `for update` in `id` order BEFORE anything is decided (so the
 * per-company "has anybody answered" judgement holds under a concurrent human write,
 * not merely in sequence); EVERY board row of the company filled together or not at
 * all (a domain is a fact about the COMPANY); `hq_blank_trim` for emptiness, never
 * bare `btrim`; the closed provenance set checked human-first so a tombstone is not
 * read as an invitation; the audit event written only on `filled`; NO
 * command_idempotency row; SERVICE-ROLE only, `p_user_id` naming the lane not
 * authorizing it (NOT security definer — `tests/core/test_migrations.py` makes that
 * a rule).
 *
 * The one thing that is NEW here is the door's shape check: the domain is pushed
 * through `hq_normalize_domain` and a normalized-empty result RAISES, exactly as a
 * non-digit id raises in 0016. The harvest normalizes on the Python side and sends
 * only hosts that survive it, so this raise is defense-in-depth that never fires in
 * production — the same posture as 0016's anchored regex at the engine door.
 *
 * OUTCOMES, returned not raised (each is a thing the caller reports, none is an
 * error), identical set to 0016:
 *   filled       nobody had answered; every board row took the domain.
 *   already_set  the company carries a domain no human has claimed (an earlier
 *                engine fill on any of its rows).
 *   human_owned  a person has answered, INCLUDING by clearing — the tombstone.
 *   no_company   nothing in the universe normalizes to this name; not invented.
 */
create or replace function public.hq_fill_domain(
  p_user_id uuid,
  p_name    text,
  p_domain  text,
  p_source  text
)
returns jsonb
language plpgsql
-- Pinned for 0009/0016's reason: this body calls `company_name_key`,
-- `hq_blank_trim` and `hq_normalize_domain`, and a shadowed resolution of any of
-- them decides whether somebody's answer survives or a wrong host is stored.
set search_path = public, pg_temp
as $$
declare
  v_key     text := public.company_name_key(p_name);
  v_domain  text := public.hq_normalize_domain(p_domain);
  v_ids     bigint[];
  v_matched int;
  v_valued  int;
  v_human   int;
begin
  if p_user_id is null then
    raise exception 'hq_fill_domain needs the user whose lane it writes'
      using errcode = '22023';
  end if;
  if v_key = '' then
    raise exception 'hq_fill_domain needs a company name'
      using errcode = '22023';
  end if;
  -- Normalized-empty means garbage or absent; the harvest must not send it. This is
  -- the id-is-digits-only check of 0016, for a host: refuse rather than store a
  -- value that would render the wrong logo.
  if v_domain = '' then
    raise exception 'a company domain must normalize to a bare host (got %)',
      left(coalesce(p_domain, ''), 80) using errcode = '22023';
  end if;

  -- Lock the whole company first — see the header: this is what makes the decision
  -- below per-COMPANY under concurrency rather than per-row-as-it-was-reached.
  perform 1 from public.companies
   where public.company_name_key(name) = v_key
   order by id
     for update;

  select count(*),
         count(*) filter (where public.hq_blank_trim(domain) <> ''),
         -- Anything not exactly 'human' counts as not-human: an unrecognised
         -- provenance must not lock the column against every future run.
         count(*) filter (where domain_source = 'human')
    into v_matched, v_valued, v_human
    from public.companies
   where public.company_name_key(name) = v_key;

  if v_matched = 0 then
    return jsonb_build_object('outcome', 'no_company', 'company_ids', '[]'::jsonb,
                              'matched', 0, 'domain', v_domain);
  end if;
  -- Human-first, BEFORE already_set: a person who cleared the cell leaves it blank,
  -- so a "is there a value" check first would read the tombstone as an invitation.
  if v_human > 0 then
    return jsonb_build_object('outcome', 'human_owned', 'company_ids', '[]'::jsonb,
                              'matched', v_matched, 'domain', v_domain);
  end if;
  if v_valued > 0 then
    return jsonb_build_object('outcome', 'already_set', 'company_ids', '[]'::jsonb,
                              'matched', v_matched, 'domain', v_domain);
  end if;

  update public.companies
     set domain        = v_domain,
         domain_source = 'engine'
   where public.company_name_key(name) = v_key
     -- Redundant against the counts above while the lock holds, and KEPT: these are
     -- the predicates that would still stand if the lock were ever removed.
     and public.hq_blank_trim(domain) = ''
     and domain_source <> 'human';

  -- Re-read rather than `returning … into`, which keeps only the last row of a
  -- multi-row UPDATE. The event payload names every row this wrote.
  select coalesce(array_agg(id order by id), '{}'::bigint[]) into v_ids
    from public.companies
   where public.company_name_key(name) = v_key
     and domain_source = 'engine'
     and domain = v_domain;

  -- The state change and its audit event in one body, written only on `filled` —
  -- every other path has already returned. `company.domain.filled` is a DIFFERENT
  -- kind from 0016's `company.linkedin_id.filled`: collapsing two harvests into one
  -- kind would make the trail unreadable.
  insert into public.events (user_id, kind, payload, actor)
  values (p_user_id, 'company.domain.filled',
          jsonb_build_object(
            'company_ids', to_jsonb(v_ids),
            'name',        p_name,
            'name_key',    v_key,
            'domain',      v_domain,
            'source', coalesce(nullif(public.hq_blank_trim(p_source), ''), 'engine')),
          'system');

  return jsonb_build_object(
    'outcome',     'filled',
    'company_ids', to_jsonb(v_ids),
    'matched',     v_matched,
    'domain',      v_domain);
end;
$$;

comment on function public.hq_fill_domain(uuid, text, text, text) is
  'engine-only: fill a company''s domain from a provider payload — matched on company_name_key, canonicalized+validated by hq_normalize_domain, the whole company judged under one lock, and never where a person has answered (including a deliberate clear)';

-- `public` is the pseudo-role; `anon` and `authenticated` hold their own grants from
-- Supabase's default privileges and would keep them. All three are revoked by name,
-- because this function takes the acting user as an argument and writes a column
-- every watcher of that company reads.
revoke all on function public.hq_fill_domain(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.hq_fill_domain(uuid, text, text, text)
  to service_role;
