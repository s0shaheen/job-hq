"""Discovery integration — assemble ingested candidates into companies rows.

Pure-transform unit tests: the resolution waterfall (discover / discover_workday) and the pg
write are monkeypatched, so nothing here touches the network or Postgres. assemble()'s contract
is the whole surface under test — pre-resolved passthrough, name resolution, Workday fallback,
ungrounded-drop, dedup, and the exact companies-row shape. upsert_universe is a thin reviewed
wrapper over core.pg.upsert; we only assert it is called with the right conflict key.
"""
from monitor import discover_universe as du


# --- pre-resolved passthrough (Common Crawl) --------------------------------------------------

def test_pre_resolved_passthrough_and_resolver_not_called(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("resolver must not run for a pre-resolved candidate")

    monkeypatch.setattr(du, "_resolve_ats", boom)
    monkeypatch.setattr(du, "discover_workday", boom)

    rows, _ = du.assemble([{"name": "", "source": "commoncrawl", "category": "",
                            "ats": "greenhouse", "slug": "airbnb"}])
    assert rows == [{"name": "", "ats": "greenhouse", "slug": "airbnb",
                     "source": "commoncrawl", "reliability_tier": 1,
                     "resolution_method": "ingested-slug"}]


def test_half_specified_pre_resolved_falls_back_to_name_resolution(monkeypatch):
    # ats present but slug blank is NOT trusted as pre-resolved — it must go through the resolver
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("greenhouse", "acme"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    [row], _ = du.assemble([{"name": "Acme", "source": "edgar", "ats": "greenhouse", "slug": ""}])
    assert row["slug"] == "acme" and row["resolution_method"] == "discover-greenhouse"


# --- name resolution via the direct-adapter waterfall -----------------------------------------

def test_name_resolution_direct_adapter(monkeypatch):
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("ashby", "ramp"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    [row], _ = du.assemble([{"name": "Ramp", "source": "edgar", "category": "fintech"}])
    assert row == {"name": "Ramp", "ats": "ashby", "slug": "ramp", "source": "edgar",
                   "reliability_tier": 1, "resolution_method": "discover-ashby"}
    assert "category" not in row   # not a companies column — dropped


def test_workday_fallback_when_direct_adapters_miss(monkeypatch):
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: (None, None))
    monkeypatch.setattr(du, "discover_workday",
                        lambda name, session=None:
                        "ntrs.wd1.myworkdayjobs.com/northerntrust"
                        if name == "Northern Trust" else None)
    [row], _ = du.assemble([{"name": "Northern Trust", "source": "edgar"}])
    assert row == {"name": "Northern Trust", "ats": "workday",
                   "slug": "ntrs.wd1.myworkdayjobs.com/northerntrust", "source": "edgar",
                   "reliability_tier": 1, "resolution_method": "workday-redirect"}


def test_discover_wins_over_workday(monkeypatch):
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("greenhouse", "stripe"))

    def boom(*a, **k):
        raise AssertionError("Workday must not be tried once discover() grounds the name")

    monkeypatch.setattr(du, "discover_workday", boom)
    [row], _ = du.assemble([{"name": "Stripe", "source": "edgar"}])
    assert row["resolution_method"] == "discover-greenhouse"


def test_session_is_threaded_to_the_resolver(monkeypatch):
    seen = []

    def fake_resolve(name, session=None):
        seen.append(session)
        return ("greenhouse", "stripe")

    monkeypatch.setattr(du, "_resolve_ats", fake_resolve)
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    sentinel = object()
    du.assemble([{"name": "Stripe", "source": "edgar"}], session=sentinel)
    assert seen == [sentinel]


# --- ungrounded names are dropped (recall self-corrects) --------------------------------------

def test_ungrounded_names_are_dropped(monkeypatch):
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: (None, None))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    rows, _ = du.assemble([{"name": "Nonexistent Co", "source": "edgar"},
                        {"name": "Also A Ghost", "source": "edgar"}])
    assert rows == []


# --- source is carried through, and defaults to "" (NOT NULL column) --------------------------

def test_missing_source_defaults_to_empty_string(monkeypatch):
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("lever", "acme"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    [row], _ = du.assemble([{"name": "Acme"}])   # no source key
    assert row["source"] == ""                # companies.source is NOT NULL — never None


# --- dedup on (name, ats, slug), first-seen wins ----------------------------------------------

def test_dedup_resolved_name_first_seen_wins(monkeypatch):
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("greenhouse", "stripe"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    rows, _ = du.assemble([{"name": "Stripe", "source": "edgar"},
                        {"name": "Stripe", "source": "later-source"}])
    assert len(rows) == 1 and rows[0]["source"] == "edgar"


def test_dedup_pre_resolved_slug():
    # no resolver monkeypatch needed — pre-resolved never calls it
    rows, _ = du.assemble([{"name": "", "source": "commoncrawl", "ats": "greenhouse", "slug": "x"},
                        {"name": "", "source": "cc-again", "ats": "greenhouse", "slug": "x"}])
    assert len(rows) == 1 and rows[0]["source"] == "commoncrawl"


# --- row shape is exactly the companies columns -----------------------------------------------

def test_row_shape_is_exactly_company_columns(monkeypatch):
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("greenhouse", "stripe"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    [row], _ = du.assemble([{"name": "Stripe", "source": "edgar", "category": "fintech",
                          "extra": "ignored"}])
    assert set(row) == set(du.COMPANY_COLUMNS)


# --- mixed batch: the whole contract in one pass ----------------------------------------------

def test_mixed_batch_end_to_end(monkeypatch):
    monkeypatch.setattr(du, "_resolve_ats",
                        lambda name, session=None:
                        {"Stripe": ("greenhouse", "stripe"),
                         "Ramp": ("ashby", "ramp")}.get(name, (None, None)))
    monkeypatch.setattr(du, "discover_workday",
                        lambda name, session=None:
                        "ntrs.wd1.myworkdayjobs.com/nt" if name == "Northern Trust" else None)
    cands = [
        {"name": "Stripe", "source": "edgar"},
        {"name": "Ramp", "source": "edgar"},
        {"name": "Northern Trust", "source": "edgar"},
        {"name": "Ghost Co", "source": "edgar"},                       # dropped: ungrounded
        {"name": "", "source": "commoncrawl", "ats": "greenhouse", "slug": "airbnb"},
        {"name": "Stripe", "source": "edgar"},                         # dedup dup
    ]
    rows, _ = du.assemble(cands)
    assert [(r["name"], r["ats"], r["slug"], r["resolution_method"]) for r in rows] == [
        ("Stripe", "greenhouse", "stripe", "discover-greenhouse"),
        ("Ramp", "ashby", "ramp", "discover-ashby"),
        ("Northern Trust", "workday", "ntrs.wd1.myworkdayjobs.com/nt", "workday-redirect"),
        ("", "greenhouse", "airbnb", "ingested-slug"),
    ]
    assert all(r["reliability_tier"] == 1 for r in rows)


# --- upsert_universe: thin wrapper over the one pg write path ----------------------------------

def test_upsert_universe_uses_companies_conflict_key(monkeypatch):
    calls = []
    monkeypatch.setattr(du.pg, "upsert",
                        lambda table, rows, *, on_conflict, session=None:
                        calls.append((table, on_conflict, len(rows))) or len(rows))
    rows = [{"name": "X", "ats": "lever", "slug": "x", "source": "edgar",
             "reliability_tier": 1, "resolution_method": "discover-lever"}]
    assert du.upsert_universe(rows) == 1
    assert calls == [("companies", "name,ats,slug", 1)]


# --- run(): assemble → upsert, with a clean skip when pg is not provisioned --------------------

def test_run_assembles_then_upserts(monkeypatch):
    monkeypatch.setattr(du, "_resolve_ats",
                        lambda name, session=None:
                        ("greenhouse", "stripe") if name == "Stripe" else (None, None))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    monkeypatch.setattr(du.pg, "enabled", lambda: True)
    monkeypatch.setattr(du.pg, "rpc", _rpc({}))                        # no placeholders anywhere
    sent = []
    monkeypatch.setattr(du.pg, "upsert",
                        lambda table, rows, *, on_conflict, session=None:
                        sent.append((table, on_conflict, rows)) or len(rows))
    cands = [{"name": "Stripe", "source": "edgar"},
             {"name": "Ghost", "source": "edgar"},                     # dropped
             {"name": "", "source": "commoncrawl", "ats": "greenhouse", "slug": "airbnb"}]
    counts = du.run(cands)
    assert counts == {"candidates": 3, "assembled": 2, "reconciled": 0,
                      "collisions": 0, "batch_collisions": 0, "upserted": 2}
    assert len(sent) == 1
    table, on_conflict, rows = sent[0]
    assert table == "companies" and on_conflict == "name,ats,slug" and len(rows) == 2


def test_run_skips_write_cleanly_when_pg_disabled(monkeypatch, capsys):
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("greenhouse", "stripe"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    monkeypatch.setattr(du.pg, "enabled", lambda: False)

    def boom(*a, **k):
        raise AssertionError("must not upsert when pg is not provisioned")

    monkeypatch.setattr(du.pg, "upsert", boom)
    # Reconcile is a WRITE, so it must be skipped too: one that "ran" against no database
    # would report upgrades that never happened.
    monkeypatch.setattr(du.pg, "rpc", boom)
    counts = du.run([{"name": "Stripe", "source": "edgar"}])
    assert counts == {"candidates": 1, "assembled": 1, "reconciled": 0,
                      "collisions": 0, "batch_collisions": 0, "upserted": 0}
    assert "discover_universe skipped" in capsys.readouterr().out


# --- reconcile(): the pasted placeholder becomes the board, instead of a ghost sibling --------
#
# The RPC's behaviour lives in Postgres and is proved there
# (tests/db/test_universe_reconcile.py, incl. the exact P7-review scenario). What is under
# test HERE is the wiring: which rows get sent, with which arguments, and what the caller
# does with each of the four outcomes.

def _rpc(outcomes: dict, calls: list | None = None):
    """A recorder standing in for `core.pg.rpc`; `outcomes` maps a name to its jsonb reply."""
    def fake(fn, params, *, session=None):
        if calls is not None:
            calls.append((fn, params))
        return outcomes.get(params["p_name"], {"outcome": "none", "company_id": None})
    return fake


def test_an_upgraded_row_is_held_out_of_the_upsert(monkeypatch):
    """The whole point of reconciling BEFORE upserting.

    The upgraded row keeps the human's spelling of the name, so re-upserting the resolver's
    spelling on the same board would conflict on nothing and mint the very sibling the
    upgrade just removed.
    """
    monkeypatch.setattr(du, "_resolve_ats",
                        lambda name, session=None:
                        {"Ramp": ("ashby", "ramp"), "Stripe": ("greenhouse", "stripe")}[name])
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    monkeypatch.setattr(du.pg, "enabled", lambda: True)
    monkeypatch.setattr(du.pg, "rpc", _rpc({"Ramp": {"outcome": "upgraded", "company_id": 7}}))
    sent = []
    monkeypatch.setattr(du.pg, "upsert",
                        lambda table, rows, *, on_conflict, session=None:
                        sent.append(rows) or len(rows))

    counts = du.run([{"name": "Ramp", "source": "edgar"}, {"name": "Stripe", "source": "edgar"}])
    assert counts["reconciled"] == 1 and counts["assembled"] == 2 and counts["upserted"] == 1
    assert [r["name"] for r in sent[0]] == ["Stripe"]


def test_reconcile_sends_the_grounded_board_and_the_tier_that_grounded_it(monkeypatch):
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: (None, None))
    monkeypatch.setattr(du, "discover_workday",
                        lambda name, session=None: "ntrs.wd1.myworkdayjobs.com/nt")
    calls = []
    monkeypatch.setattr(du.pg, "rpc", _rpc({}, calls))
    rows, _ = du.assemble([{"name": "Northern Trust", "source": "edgar"}])
    remaining, counts = du.reconcile(rows)
    assert calls == [(du.RECONCILE_FN, {
        "p_name": "Northern Trust", "p_ats": "workday",
        "p_slug": "ntrs.wd1.myworkdayjobs.com/nt", "p_tier": 1,
        "p_method": "workday-redirect"})]
    assert remaining == rows and counts == {"upgraded": 0, "collisions": 0}


def test_a_slug_only_candidate_never_costs_a_round_trip(monkeypatch):
    """Common Crawl rows carry no human name, so there is nothing to match. Sending them
    would be a request per mined slug for an answer the caller can compute locally."""
    def boom(*a, **k):
        raise AssertionError("a nameless row must not be sent to the reconciler")

    monkeypatch.setattr(du.pg, "rpc", boom)
    rows, _ = du.assemble([{"name": "", "source": "commoncrawl",
                         "ats": "greenhouse", "slug": "airbnb"}])
    remaining, counts = du.reconcile(rows)
    assert remaining == rows and counts == {"upgraded": 0, "collisions": 0}


def test_a_collision_is_counted_warned_and_still_upserted(monkeypatch, capsys):
    """Pre-reconciler wreckage: a placeholder AND the grounded sibling. Merging them means
    repointing a subscription, which 0009 refuses to do silently — so it is reported, and
    the row still upserts (a no-op merge onto the row that already exists). A collision must
    not take the batch down, and it must not pass unnoticed either."""
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("greenhouse", "both"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    monkeypatch.setattr(du.pg, "rpc",
                        _rpc({"Both Shapes": {"outcome": "collision", "company_id": 42}}))
    rows, _ = du.assemble([{"name": "Both Shapes", "source": "edgar"}])
    remaining, counts = du.reconcile(rows)
    assert counts == {"upgraded": 0, "collisions": 1}
    # HELD OUT, not passed through: upserting the colliding spelling conflicts on nothing, so
    # it INSERTS a third row — which `companies_board_identity_key` then refuses, failing the
    # whole 500-row chunk over one row.
    assert remaining == []
    out = capsys.readouterr().out
    assert "discover_universe collision" in out and "42" in out and "Both Shapes" in out


def test_an_unexpected_or_empty_reply_leaves_the_row_alone(monkeypatch):
    """An outcome this caller does not know is not a licence to drop the row: the upsert is
    idempotent, so keeping it is recoverable where silently discarding it is data loss."""
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("lever", "x"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    for reply in ({}, None, {"outcome": "something-new"}):
        monkeypatch.setattr(du.pg, "rpc", lambda fn, params, *, session=None, r=reply: r)
        rows, _ = du.assemble([{"name": "Acme", "source": "edgar"}])
        remaining, counts = du.reconcile(rows)
        assert remaining == rows and counts == {"upgraded": 0, "collisions": 0}


# --- exclude_keys: the human's verdict reaches the resolver -----------------------------------

def test_excluded_names_are_dropped_before_the_resolver_runs(monkeypatch):
    """A dismissed name must cost neither a row nor an HTTP probe. `probed` is what makes
    the second half of that real."""
    probed = []

    def fake_resolve(name, session=None):
        probed.append(name)
        return ("greenhouse", name.lower())

    monkeypatch.setattr(du, "_resolve_ats", fake_resolve)
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    rows, _ = du.assemble([{"name": "Stripe", "source": "edgar"},
                        {"name": "Dismissed Co", "source": "edgar"}],
                       exclude_keys={"dismissed co"})
    assert [r["name"] for r in rows] == ["Stripe"]
    assert probed == ["Stripe"]


def test_exclusion_matches_the_normalized_name_not_the_raw_string(monkeypatch):
    """An ingester's spelling is not the human's — 'AON' and a trailing NBSP are the same
    company as the 'Aon' they dismissed."""
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("greenhouse", "aon"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    for spelling in ("AON", "  aon  ", "Aon" + chr(0x00A0)):
        rows, _ = du.assemble([{"name": spelling, "source": "edgar"}],
                              exclude_keys={"aon"})
        assert rows == [], spelling


def test_run_fills_exclusions_from_the_users_dismissals(monkeypatch):
    """`user_id` is what makes this a per-user pass, and dismissals are the only verdict it
    applies: an APPROVED company still belongs in the shared universe and still wants its board
    refreshed. Only "no" means "stop bringing me this"."""
    from monitor import universe

    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("greenhouse", "s"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    monkeypatch.setattr(du.pg, "enabled", lambda: True)
    monkeypatch.setattr(du.pg, "rpc", _rpc({}))
    monkeypatch.setattr(du.pg, "upsert",
                        lambda table, rows, *, on_conflict, session=None: len(rows))
    asked = []

    def fake_dismissed(user_id, session=None):
        asked.append(user_id)
        return {"dismissed co"}

    monkeypatch.setattr(universe, "dismissed_name_keys", fake_dismissed)

    counts = du.run([{"name": "Dismissed Co", "source": "edgar"}], user_id="u-1")
    assert asked == ["u-1"]
    assert counts["assembled"] == 0 and counts["upserted"] == 0


def test_an_explicit_exclude_set_wins_over_the_user_lookup(monkeypatch):
    """A caller that passed its own set means it: no second, surprising read."""
    from monitor import universe

    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("greenhouse", "s"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    monkeypatch.setattr(du.pg, "enabled", lambda: True)
    monkeypatch.setattr(du.pg, "rpc", _rpc({}))
    monkeypatch.setattr(du.pg, "upsert",
                        lambda table, rows, *, on_conflict, session=None: len(rows))

    def boom(*a, **k):
        raise AssertionError("an explicit exclude_keys must not be overridden by a lookup")

    monkeypatch.setattr(universe, "dismissed_name_keys", boom)
    counts = du.run([{"name": "Kept Co", "source": "edgar"}], exclude_keys=set(), user_id="u-1")
    assert counts["assembled"] == 1


# --- dedup: the raw name is not an identity, and a board belongs to one company ---------------

def test_two_spellings_of_one_company_produce_one_row(monkeypatch):
    """The bug a raw-tuple dedup left open.

    'Aon' and 'AON ' both ground to greenhouse/aon, and deduping on the RAW (name, ats, slug)
    let both through — so the upsert wrote two grounded rows for one company. That is the
    ghost this feature removes, arriving from the other direction, and it reported zero
    collisions while doing it.
    """
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("greenhouse", "aon"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    rows, counts = du.assemble([{"name": "Aon", "source": "edgar"},
                                {"name": "AON ", "source": "later"},
                                {"name": "  aon", "source": "later"},
                                {"name": "Aon" + chr(0x00A0), "source": "later"}])
    assert [r["name"] for r in rows] == ["Aon"]          # first spelling wins
    assert rows[0]["source"] == "edgar"
    assert counts["batch_collisions"] == 0, "one company under four spellings is not a collision"


def test_two_different_companies_on_one_board_is_a_reported_collision(monkeypatch, capsys):
    """One board belongs to one company row — and the likeliest cause of two names landing on
    one board is the resolver grounding one of them wrongly (the ADM→'archer' shape P1 fixed).
    So it is neither written nor dropped quietly: it is counted and named."""
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("greenhouse", "shared"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    rows, counts = du.assemble([{"name": "First Co", "source": "edgar"},
                                {"name": "Second Co", "source": "edgar"}])
    assert [r["name"] for r in rows] == ["First Co"]
    assert counts["batch_collisions"] == 1
    out = capsys.readouterr().out
    assert "batch collision" in out and "Second Co" in out and "First Co" in out


def test_a_batch_collision_is_kept_out_of_the_upsert(monkeypatch):
    """Letting it through would fail the upsert's whole 500-row chunk against
    `companies_board_identity_key`, which is a worse outcome than one skipped row."""
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("ashby", "one"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    monkeypatch.setattr(du.pg, "enabled", lambda: True)
    monkeypatch.setattr(du.pg, "rpc", _rpc({}))
    sent = []
    monkeypatch.setattr(du.pg, "upsert",
                        lambda table, rows, *, on_conflict, session=None:
                        sent.append(rows) or len(rows))
    counts = du.run([{"name": "A Co", "source": "edgar"}, {"name": "B Co", "source": "edgar"}])
    assert counts["batch_collisions"] == 1 and counts["upserted"] == 1
    assert [r["name"] for r in sent[0]] == ["A Co"]


def test_two_mined_slugs_for_one_board_dedupe_without_a_collision(monkeypatch):
    """Pre-resolved Common Crawl rows are nameless, so both normalize to '' — the same company
    on the same board, which is a duplicate to drop, not a collision to report."""
    rows, counts = du.assemble([{"name": "", "source": "commoncrawl",
                                 "ats": "greenhouse", "slug": "x"},
                                {"name": "", "source": "cc-again",
                                 "ats": "greenhouse", "slug": "x"}])
    assert len(rows) == 1 and rows[0]["source"] == "commoncrawl"
    assert counts["batch_collisions"] == 0


def test_a_slug_only_candidate_is_never_excluded_by_name(monkeypatch):
    """`company_name_key('')` is '', which is in no exclusion set — but a guard that tested
    the key before checking whether there IS a name would drop every Common Crawl row the
    moment any exclusion was passed."""
    rows, _ = du.assemble([{"name": "", "source": "commoncrawl",
                            "ats": "greenhouse", "slug": "airbnb"}],
                           exclude_keys={"", "aon"})
    assert [r["slug"] for r in rows] == ["airbnb"]
