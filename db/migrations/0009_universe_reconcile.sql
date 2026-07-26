-- The reconciler 0008 said belonged to the Python side and did not build.
--
-- 0008 shipped half of the paste↔resolver story and was honest about the other
-- half. A paste of a name the resolver had ALREADY grounded binds to that real
-- board (`app_propose_companies`'s normalized lookup). The reverse did not
-- happen: when the resolver later grounded a name a human had pasted first, it
-- upserted on (name, ats, slug) — a key the pasted row ('Ramp','','') cannot
-- hold — so it wrote a SECOND row and the human's subscription stayed on the
-- unresolved one. A company that reads as watched and is never pulled from,
-- forever. 0008 wrote that limitation into its own header, the propose route's
-- comment and the add form's on-screen copy; this migration is what lets all
-- three be reworded to something better than an apology.
--
-- WHY IT IS SQL, when 0008 said "a job for the Python side"
--
-- Python still owns RESOLUTION — which names get grounded, to which board, by
-- which waterfall step — and `monitor.discover_universe` drives this function
-- once per grounded name. What Python cannot own is the WRITE: the decision
-- ("is there an ungrounded row for this name?") and the update have to be one
-- atomic, locked step, or two sweeps grounding the same name race and the loser
-- creates the very sibling this removes. Same division as the browser and
-- `app_set_company_review_bulk`: the caller decides, the database applies.
--
-- WHAT IT DELIBERATELY DOES NOT DO: merge. If a grounded row for this board
-- ALREADY exists next to the placeholder — the wreckage of a pre-reconciler
-- grounding, or a second spelling of one company — collapsing them means
-- repointing `user_companies` rows from one company id to another, and a repoint
-- is a rewrite of somebody's subscription that no test in this repo covers and
-- no human asked for. It returns 'collision' instead, leaves both rows standing,
-- and (below) writes a `company.grounding_blocked` event to every subscriber of
-- the placeholder so the person whose row is stuck can SEE that it is stuck.
-- An in-place upgrade needs no repoint at all, which is the entire reason the
-- happy path is an UPDATE and not an insert-then-move.
--
-- ON `company_name_key` AND LOCALES (the caveat a reviewer is owed)
--
-- `public.company_name_key` is IMMUTABLE because a functional index requires it,
-- but `lower()` is not actually locale-independent: this database folds
-- 'İ' (U+0130) to a single 'i', while Python's `str.lower()` and JS's
-- `toLowerCase()` both produce 'i' + U+0307. So the three ports of that function
-- CAN disagree off the pinned corpus, and a collation change could in principle
-- disagree with an index built before it (a REINDEX concern, not a new one —
-- 0008's index has the same property).
--
-- What bounds the damage is that **Python's key never reaches SQL**. This
-- function takes the RAW name and computes the key itself, so every match the
-- database performs is Postgres-vs-Postgres. `core/companykeys.py` is used only
-- for LOCAL decisions — batch dedup, and "has this user already ruled on this
-- name" where both sides of the comparison are Python. A divergence there costs
-- a redundant probe or a missed skip, never a wrong write.

-- ============================================================ board identity

-- One board, one company row.
--
-- The collision check inside the function below was a read, and an unlocked read
-- of a row that does not exist yet cannot be made safe by locking: two lanes
-- grounding the same board at the same moment both found nothing, both wrote,
-- and the table ended with two rows on one board — the exact duplicate the
-- 'collision' outcome exists to refuse. A check-then-write is only as good as the
-- constraint underneath it, so here is the constraint.
--
-- PARTIAL, and the predicate is the point: placeholders (ats='' and slug='') are
-- EXEMPT, because they are not on a board yet and 0008's
-- `companies_unresolved_name_key` is what keeps them unique. The table's
-- (name, ats, slug) key stays as it was — one company legitimately has more than
-- one board, and a Greenhouse careers site plus a Workday tenant are two rows
-- and both are true. What this forbids is the reverse: two rows claiming the SAME
-- board, which is never two facts.
--
-- IF THIS MIGRATION FAILS TO APPLY, that is the index doing its job: the database
-- already holds two rows on one board, and this file cannot know which
-- subscriptions to keep. Find them with
--
--   select ats, slug, count(*), array_agg(id), array_agg(name)
--     from public.companies where ats <> '' and slug <> ''
--    group by ats, slug having count(*) > 1;
--
-- and resolve by hand — repointing `user_companies` off the loser and deleting
-- it. Refusing to apply is recoverable; applying and letting the duplicates
-- persist is the silent state this whole migration exists to remove.
create unique index if not exists companies_board_identity_key
  on public.companies (ats, slug)
  where ats <> '' and slug <> '';

comment on index public.companies_board_identity_key is
  'one board, one company row — placeholders (ats='''' and slug='''') exempt, they are not on a board yet';

-- ============================================================ the stuck trace

/**
 * The audit note a blocked grounding leaves behind, for the people it affects.
 *
 * A 'collision' is the one outcome where somebody's row is permanently stuck: a
 * human pasted "Aon PLC", the resolver grounded it onto the board "Aon" already
 * holds, and because merging would repoint their subscription this function
 * refuses — so their row stays tier 3 forever. Reporting that only in the
 * caller's log means the single person who needs to know is the only one who
 * cannot see it: the warning goes to a Lambda log, and they are looking at a grid.
 *
 * `events` is the smallest honest mechanism the schema already has. It is
 * per-user, append-only, and the same trail every human gesture writes to, so a
 * stuck row is queryable next to the paste that created it. It is NOT yet
 * rendered in the /companies grid — surfacing it there is UI work this migration
 * does not do, and the docs say so rather than implying a badge exists.
 *
 * No placeholder (a second spelling with nobody subscribed) means nobody to tell,
 * so this writes nothing. `events.user_id` is a real FK; an unconditional insert
 * of a null user would fail the whole reconcile for the ingesters' normal case.
 */
create or replace function public.note_grounding_blocked(
  p_company_id bigint,
  p_name       text,
  p_ats        text,
  p_slug       text,
  p_blocker_id bigint
)
returns void
language sql
set search_path = public, pg_temp
as $$
  insert into public.events (user_id, kind, payload, actor)
  select uc.user_id,
         'company.grounding_blocked',
         jsonb_build_object(
           'company_id', p_company_id,
           'company', p_name,
           'ats', p_ats,
           'slug', p_slug,
           'blocked_by_company_id', p_blocker_id,
           'reason', 'another company row already holds this board; merging would '
                     || 'repoint this subscription, so it was left alone'
         ),
         'system'
    from public.user_companies uc
   where p_company_id is not null and uc.company_id = p_company_id
$$;

comment on function public.note_grounding_blocked(bigint, text, text, text, bigint) is
  'engine-only: audit note to every subscriber of a placeholder whose grounding was refused as a collision';

revoke all on function public.note_grounding_blocked(bigint, text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.note_grounding_blocked(bigint, text, text, text, bigint)
  to service_role;

-- ============================================================ the reconciler

/**
 * A grounded board, matched against the ungrounded placeholder that names the
 * same company, and applied to THAT row.
 *
 * Returns jsonb, not a bare id, because "nothing happened" has four different
 * meanings and a null cannot tell them apart — the caller reports each one
 * differently:
 *
 *   {"outcome":"upgraded",  "company_id": <id>}  the placeholder became the board
 *   {"outcome":"none",      "company_id": null}  no placeholder AND the board is
 *                                                free — caller upserts as usual
 *   {"outcome":"collision", "company_id": <id>}  the board already has a row;
 *                                                merging is a subscription
 *                                                repoint (see the header). The
 *                                                caller must NOT upsert this
 *                                                spelling — doing so is how a
 *                                                third row gets minted.
 *   {"outcome":"skipped",   "company_id": null}  the name normalizes to nothing
 *
 * 'collision' is answered whether or not a placeholder exists, and that matters
 * for the caller's OTHER write: a second spelling of an already-grounded company
 * ('AON' when 'Aon' holds greenhouse/aon) has no placeholder, so an earlier
 * version returned 'none' and the caller's upsert then hit
 * `companies_board_identity_key` and failed a whole 500-row chunk. Answering
 * 'collision' lets the caller hold that one row back and keep going.
 *
 * NOT security definer, and NOT callable by a browser. `app_propose_companies`
 * writes tier 3 / 'manual' precisely because nothing reachable from the web app
 * probes an ATS, and a function that stamps `reliability_tier = 1` onto a name
 * is the exact fabricated day-of promise that rule exists to prevent. Supabase's
 * default privileges grant execute on new functions to `anon` and
 * `authenticated`, so leaving it at `revoke from public` would NOT have closed
 * that door — both are revoked by name below.
 */
create or replace function public.reconcile_grounded_company(
  p_name   text,
  p_ats    text,
  p_slug   text,
  p_tier   smallint,
  p_method text
)
returns jsonb
language plpgsql
-- Pinned for the same reason the definer functions pin it: this body calls
-- public.company_name_key, and an index built on one resolution of that name
-- disagreeing with a lookup built on another is a bug with no symptom.
set search_path = public, pg_temp
as $$
declare
  v_key     text;
  v_id      bigint;
  v_name    text;
  v_blocker bigint;
  v_holder  text;
begin
  -- Fail loud on a half-resolved board. An empty ats or slug would write the
  -- placeholder back onto itself while claiming a tier — the guessed write this
  -- repo's rules rule out — and would also mean the row never leaves the
  -- `companies_unresolved_name_key` index it is supposed to graduate from.
  if p_ats is null or btrim(p_ats) = '' or p_slug is null or btrim(p_slug) = '' then
    raise exception 'reconcile needs a grounded board (ats and slug)' using errcode = '22023';
  end if;
  if p_tier is null or p_tier not in (1, 2, 3) then
    raise exception 'reconcile needs a reliability tier in (1,2,3)' using errcode = '22023';
  end if;
  if p_method is null or btrim(p_method) = '' then
    raise exception 'reconcile needs the resolution method that grounded it'
      using errcode = '22023';
  end if;

  v_key := public.company_name_key(p_name);
  if v_key = '' then
    -- Common Crawl candidates are slug-only and carry no human name (0008's
    -- `company_name_key('')`), so there is nothing to match; that is not an error.
    return jsonb_build_object('outcome', 'skipped', 'company_id', null);
  end if;

  -- The placeholder, locked before anything is decided about it.
  --
  -- `companies_unresolved_name_key` (0008) already makes at most one of these
  -- exist per normalized name, so the ordering is belt-and-braces rather than a
  -- choice; the `for update` is not. Two sweeps grounding the same name must
  -- serialize here, or both see the placeholder and the loser's UPDATE lands on
  -- a row that is no longer ungrounded.
  select id, name into v_id, v_name
    from public.companies
   where ats = '' and slug = ''
     and public.company_name_key(name) = v_key
   order by id
   limit 1
     for update;

  -- Does SOMEBODY ELSE already hold this board?
  --
  -- (ats, slug) IS the board's identity, now enforced by
  -- `companies_board_identity_key` rather than merely believed by this query. The
  -- read stays because it produces the holder's id and name — the id for the
  -- caller's warning and the event below, the name for the distinction just
  -- below; the INDEX is what makes the answer safe under concurrency, and the
  -- exception handler on the UPDATE is what catches the window between this read
  -- and that write.
  --
  -- `v_id is null or id <> v_id` and not `id is distinct from v_id`: with no
  -- placeholder, v_id is NULL and `id is distinct from null` is true of EVERY
  -- row, so a plain re-run of the same discovery pass reported a collision
  -- between an upgraded row and itself. Found by
  -- test_reconciling_twice_is_idempotent, which is the whole reason it is there.
  select id, name into v_blocker, v_holder
    from public.companies
   where ats = p_ats and slug = p_slug
     and (v_id is null or id <> v_id)
   limit 1;

  if v_blocker is not null then
    -- The board is taken. Whether that is a COLLISION depends on whether the
    -- caller's follow-up upsert would be safe, because 'none' is a licence to
    -- upsert and the upsert conflicts on (name, ats, slug):
    --
    --   * a placeholder also exists → collision, always. Merging the two is the
    --     subscription repoint nobody does silently.
    --   * no placeholder, and the holder carries EXACTLY this name → the work is
    --     already done. The caller's upsert merge-duplicates onto that row and
    --     changes nothing, so this is 'none' and re-running a pass is free.
    --   * no placeholder, and the holder carries a DIFFERENT spelling ('Aon'
    --     holding the board 'AON' just resolved to) → collision. Its
    --     (name, ats, slug) triple is new, so the upsert would INSERT and the
    --     board index would refuse it — taking the whole 500-row chunk down over
    --     one row.
    if v_id is null and v_holder = p_name then
      return jsonb_build_object('outcome', 'none', 'company_id', v_blocker);
    end if;
    perform public.note_grounding_blocked(v_id, v_name, p_ats, p_slug, v_blocker);
    return jsonb_build_object('outcome', 'collision', 'company_id', v_blocker);
  end if;

  if v_id is null then
    return jsonb_build_object('outcome', 'none', 'company_id', null);
  end if;

  -- The upgrade. `name` and `source` are deliberately NOT touched:
  --
  --   * `name` is the human's — they typed it, the normalized keys already match,
  --     and rewriting it to the resolver's spelling is a bot overwriting a person
  --     ("bots fill blanks; humans win"). It is also what keeps the row's identity
  --     stable for anything holding it.
  --   * `source` records where the company ENTERED the universe, which really was
  --     the paste. What changed is how it RESOLVED, and that is `resolution_method`.
  --
  -- The handler is not decoration. Between the read above and this write another
  -- lane can take the board; the index turns that into a unique violation, and a
  -- violation here means exactly what the read would have found a moment later.
  -- Reporting it as 'collision' keeps one racing lane from failing a whole
  -- discovery batch on a condition the caller already knows how to handle.
  begin
    update public.companies
       set ats               = p_ats,
           slug              = p_slug,
           reliability_tier  = p_tier,
           resolution_method = p_method
     where id = v_id;
  exception when unique_violation then
    select id into v_blocker
      from public.companies
     where ats = p_ats and slug = p_slug and id is distinct from v_id
     limit 1;
    perform public.note_grounding_blocked(v_id, v_name, p_ats, p_slug, v_blocker);
    return jsonb_build_object('outcome', 'collision', 'company_id', v_blocker);
  end;

  -- One event per subscriber, because this is the one shared-table write a human
  -- is owed a note about: they were told (on screen, in 0008's copy) that a
  -- pasted row stays tracked, and their row just became a real board. Bounded by
  -- the number of people watching one company, which is the smallest fan-out in
  -- this schema. `actor = 'system'`: no human did this.
  insert into public.events (user_id, kind, payload, actor)
  select uc.user_id,
         'company.grounded',
         jsonb_build_object('company_id', v_id, 'company', v_name,
                            'ats', p_ats, 'slug', p_slug,
                            'reliability_tier', p_tier,
                            'resolution_method', p_method),
         'system'
    from public.user_companies uc
   where uc.company_id = v_id;

  return jsonb_build_object('outcome', 'upgraded', 'company_id', v_id);
end;
$$;

comment on function public.reconcile_grounded_company(text, text, text, smallint, text) is
  'engine-only: upgrade the ungrounded placeholder naming this company to the board the resolver grounded, in place (no subscription repoint)';

-- `public` is the pseudo-role; `anon` and `authenticated` hold their own grants
-- from Supabase's default privileges and would keep them. Revoking all three is
-- what actually keeps a browser from asserting a reliability tier.
revoke all on function public.reconcile_grounded_company(text, text, text, smallint, text)
  from public, anon, authenticated;
grant execute on function public.reconcile_grounded_company(text, text, text, smallint, text)
  to service_role;
