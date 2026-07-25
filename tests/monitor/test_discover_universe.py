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

    rows = du.assemble([{"name": "", "source": "commoncrawl", "category": "",
                         "ats": "greenhouse", "slug": "airbnb"}])
    assert rows == [{"name": "", "ats": "greenhouse", "slug": "airbnb",
                     "source": "commoncrawl", "reliability_tier": 1,
                     "resolution_method": "ingested-slug"}]


def test_half_specified_pre_resolved_falls_back_to_name_resolution(monkeypatch):
    # ats present but slug blank is NOT trusted as pre-resolved — it must go through the resolver
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("greenhouse", "acme"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    [row] = du.assemble([{"name": "Acme", "source": "edgar", "ats": "greenhouse", "slug": ""}])
    assert row["slug"] == "acme" and row["resolution_method"] == "discover-greenhouse"


# --- name resolution via the direct-adapter waterfall -----------------------------------------

def test_name_resolution_direct_adapter(monkeypatch):
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("ashby", "ramp"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    [row] = du.assemble([{"name": "Ramp", "source": "edgar", "category": "fintech"}])
    assert row == {"name": "Ramp", "ats": "ashby", "slug": "ramp", "source": "edgar",
                   "reliability_tier": 1, "resolution_method": "discover-ashby"}
    assert "category" not in row   # not a companies column — dropped


def test_workday_fallback_when_direct_adapters_miss(monkeypatch):
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: (None, None))
    monkeypatch.setattr(du, "discover_workday",
                        lambda name, session=None:
                        "ntrs.wd1.myworkdayjobs.com/northerntrust"
                        if name == "Northern Trust" else None)
    [row] = du.assemble([{"name": "Northern Trust", "source": "edgar"}])
    assert row == {"name": "Northern Trust", "ats": "workday",
                   "slug": "ntrs.wd1.myworkdayjobs.com/northerntrust", "source": "edgar",
                   "reliability_tier": 1, "resolution_method": "workday-redirect"}


def test_discover_wins_over_workday(monkeypatch):
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("greenhouse", "stripe"))

    def boom(*a, **k):
        raise AssertionError("Workday must not be tried once discover() grounds the name")

    monkeypatch.setattr(du, "discover_workday", boom)
    [row] = du.assemble([{"name": "Stripe", "source": "edgar"}])
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
    rows = du.assemble([{"name": "Nonexistent Co", "source": "edgar"},
                        {"name": "Also A Ghost", "source": "edgar"}])
    assert rows == []


# --- source is carried through, and defaults to "" (NOT NULL column) --------------------------

def test_missing_source_defaults_to_empty_string(monkeypatch):
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("lever", "acme"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    [row] = du.assemble([{"name": "Acme"}])   # no source key
    assert row["source"] == ""                # companies.source is NOT NULL — never None


# --- dedup on (name, ats, slug), first-seen wins ----------------------------------------------

def test_dedup_resolved_name_first_seen_wins(monkeypatch):
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("greenhouse", "stripe"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    rows = du.assemble([{"name": "Stripe", "source": "edgar"},
                        {"name": "Stripe", "source": "later-source"}])
    assert len(rows) == 1 and rows[0]["source"] == "edgar"


def test_dedup_pre_resolved_slug():
    # no resolver monkeypatch needed — pre-resolved never calls it
    rows = du.assemble([{"name": "", "source": "commoncrawl", "ats": "greenhouse", "slug": "x"},
                        {"name": "", "source": "cc-again", "ats": "greenhouse", "slug": "x"}])
    assert len(rows) == 1 and rows[0]["source"] == "commoncrawl"


# --- row shape is exactly the companies columns -----------------------------------------------

def test_row_shape_is_exactly_company_columns(monkeypatch):
    monkeypatch.setattr(du, "_resolve_ats", lambda name, session=None: ("greenhouse", "stripe"))
    monkeypatch.setattr(du, "discover_workday", lambda name, session=None: None)
    [row] = du.assemble([{"name": "Stripe", "source": "edgar", "category": "fintech",
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
    rows = du.assemble(cands)
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
    sent = []
    monkeypatch.setattr(du.pg, "upsert",
                        lambda table, rows, *, on_conflict, session=None:
                        sent.append((table, on_conflict, rows)) or len(rows))
    cands = [{"name": "Stripe", "source": "edgar"},
             {"name": "Ghost", "source": "edgar"},                     # dropped
             {"name": "", "source": "commoncrawl", "ats": "greenhouse", "slug": "airbnb"}]
    counts = du.run(cands)
    assert counts == {"candidates": 3, "assembled": 2, "upserted": 2}
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
    counts = du.run([{"name": "Stripe", "source": "edgar"}])
    assert counts == {"candidates": 1, "assembled": 1, "upserted": 0}
    assert "discover_universe skipped" in capsys.readouterr().out
