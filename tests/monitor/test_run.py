import time

import pytest

import monitor.run as run_mod
from monitor.config import RuntimeConfig
from monitor.models import Company, Job, JobRecord
from monitor.run import RunSummary, run_monitor
from monitor.sheet import FakeSheetStore
from monitor.tagging import Tags

TODAY = "2026-07-13"

CFG = RuntimeConfig(include=["product manager"], exclude=["engineer"],
                    workday_search="product", yoe_push_max=4,
                    push_new_jobs=True, push_status_events=True)


def _job(nid, title="Product Manager", company="Stripe"):
    return Job("greenhouse", nid, company, title, "NYC", f"http://x/{nid}")


def _fetch_returns(mapping):
    def fake(ats, slug, company, session, workday_search="product"):
        return mapping.get(company, [])
    return fake


def _tagger_returns(yoe_by_id):
    """id -> yoe string; missing id -> Tags with blank yoe (min_yoe='')."""
    def tag(rec, slug):
        return Tags(yoe=yoe_by_id.get(rec.id, ""), comp_range="$150k")
    return tag


class _Pusher:
    def __init__(self, ok=True):
        self.ok = ok
        self.calls = []

    def __call__(self, title, body, **kw):
        self.calls.append((title, body, kw))
        return self.ok


def _run(store, *, fetch, tagger=None, pusher=None, cfg=CFG, cap=None):
    return run_monitor(store, cfg, fetch=fetch, tagger=tagger, today=TODAY,
                       session=object(), pusher=pusher or _Pusher(),
                       inline_tag_max=60 if cap is None else cap)


# ---- reconcile semantics preserved from the old monitor

def test_empty_titles_include_skips_loudly_and_fetches_nothing(capsys):
    """RM-40 vault audit §9 Step 4: the committed defaults carry no titles, so
    an unconfigured instance must SKIP — visibly — rather than inherit a
    search or burn a run matching nothing."""
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    fetched = []

    def spy_fetch(ats, slug, company, session, workday_search="product"):
        fetched.append(company)
        return [_job("1")]

    cfg = RuntimeConfig(include=[], exclude=[], push_new_jobs=True)
    summary = _run(store, fetch=spy_fetch, cfg=cfg)
    assert summary.new_count == 0 and summary.boards_done == 0
    assert fetched == [], "an unconfigured sweep still fetched boards"
    err = capsys.readouterr().err
    assert "titles_include" in err and "warning" in err.casefold()


def test_first_run_seeds_without_pushing():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=False)], {})
    pusher = _Pusher()
    summary = _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), pusher=pusher)
    assert summary.new_count == 0                    # seeded silently
    assert store.read_history()["greenhouse-1"].status == "Seen"
    assert store.seeded_marks == ["Stripe"]
    assert pusher.calls == []


def test_second_run_surfaces_new_job_and_filters_titles():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    jobs = [_job("9", "Senior Product Manager"), _job("10", "Staff Engineer")]
    summary = _run(store, fetch=_fetch_returns({"Stripe": jobs}),
                   tagger=_tagger_returns({"greenhouse-9": "3+"}))
    assert summary.new_count == 1
    assert "greenhouse-9" in store.read_history()
    assert "greenhouse-10" not in store.read_history()


def test_zero_new_is_quiet_no_heartbeat_push():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    pusher = _Pusher()
    summary = _run(store, fetch=_fetch_returns({"Stripe": []}), pusher=pusher)
    assert summary.new_count == 0
    assert pusher.calls == []                        # digest/heartbeats replace ntfy noise


def test_fetch_error_quarantined_to_health_and_run_continues():
    def boom(ats, slug, company, session, workday_search="product"):
        if company == "Bad":
            raise RuntimeError("404")
        return [_job("1", company="Good")]
    store = FakeSheetStore([Company("Bad", "greenhouse", "bad", seeded=True),
                            Company("Good", "greenhouse", "good", seeded=True)], {})
    summary = _run(store, fetch=boom, tagger=_tagger_returns({}))
    assert summary.errored == 1 and summary.error_companies == ["Bad"]
    assert any(r["result"] == "ERROR" for r in store.health_rows)
    assert "greenhouse-1" in store.read_history()    # Good still processed


def test_closed_job_reappearing_reopens_and_surfaces():
    rec = JobRecord("greenhouse-1", "Stripe", "Product Manager", "NYC",
                    "http://x/1", "Closed", "2026-01-01", "2026-06-01")
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)],
                           {"greenhouse-1": rec}, min_yoe={"greenhouse-1": "2"})
    pusher = _Pusher()
    summary = _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), pusher=pusher)
    assert summary.new_count == 1
    assert store.read_history()["greenhouse-1"].status == "New"
    assert len(pusher.calls) == 1                    # reopened role reaches the push
    assert summary.pushed == 1                       # stored min_yoe=2 clears the bar


def test_stale_missing_job_closed():
    rec = JobRecord("greenhouse-1", "Stripe", "Product Manager", "NYC",
                    "http://x/1", "New", "2026-06-01", "2026-06-01")   # 42 days silent
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)],
                           {"greenhouse-1": rec})
    _run(store, fetch=_fetch_returns({"Stripe": []}))
    assert store.read_history()["greenhouse-1"].status == "Closed"


# ---- inline tagging

def test_inline_tag_cap_limits_attempts():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    jobs = [_job(str(i)) for i in range(5)]
    attempts = []

    def tagger(rec, slug):
        attempts.append(rec.id)
        return Tags(yoe="3+")

    summary = _run(store, fetch=_fetch_returns({"Stripe": jobs}), tagger=tagger, cap=2)
    assert len(attempts) == 2
    assert summary.tagged == 2
    tagged_at = {r.id: t for r, t in store.read_jobs_for_tagging()}
    assert sum(1 for t in tagged_at.values() if t) == 2   # overflow left for review.py


def test_no_tagger_appends_untagged():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    summary = _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), tagger=None)
    assert summary.tagged == 0
    assert store.tags_for("greenhouse-1") is None
    assert "greenhouse-1" in store.read_history()


def test_tag_failure_is_isolated_job_still_appended():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})

    def tagger(rec, slug):
        raise RuntimeError("LLM down")

    summary = _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), tagger=tagger)
    assert summary.tag_failed == 1
    assert "greenhouse-1" in store.read_history()    # append never blocked by tagging


def test_seeds_are_never_inline_tagged():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=False)], {})
    attempts = []

    def tagger(rec, slug):
        attempts.append(rec.id)
        return Tags(yoe="3+")

    _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), tagger=tagger)
    assert attempts == []                            # seed run burns zero LLM calls


# ---- YoE push policy

def test_push_lists_only_roles_within_yoe_bar_and_counts_rest():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    jobs = [_job("1", "Product Manager, Payments"),
            _job("2", "Principal Product Manager"),
            _job("3", "Product Manager, Growth")]
    pusher = _Pusher()
    summary = _run(store, fetch=_fetch_returns({"Stripe": jobs}), pusher=pusher,
                   tagger=_tagger_returns({"greenhouse-1": "3+",
                                           "greenhouse-2": "8+"}))  # 3 untagged -> ""
    assert len(pusher.calls) == 1
    title, body, kw = pusher.calls[0]
    assert "1 new role" in title
    assert "Product Manager, Payments" in body and "Stripe" in body
    assert "$150k" in body                           # comp shown when known
    assert "Principal" not in body                   # 8+ filtered out
    assert "2 more in Feed" in body
    assert kw["click"] == "http://x/1"
    assert summary.pushed == 1
    assert store.pushed_marks == ["greenhouse-1"]


def test_no_push_when_nothing_clears_the_bar():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    pusher = _Pusher()
    summary = _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), pusher=pusher,
                   tagger=_tagger_returns({"greenhouse-1": "8+"}))
    assert pusher.calls == []
    assert summary.pushed == 0 and summary.new_count == 1


def test_untagged_roles_are_never_pushed():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    pusher = _Pusher()
    _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), pusher=pusher,
         tagger=None)                                # no min_yoe -> not pushable
    assert pusher.calls == []


def test_push_toggle_off_silences_pushes():
    cfg = RuntimeConfig(include=["product manager"], exclude=[], push_new_jobs=False)
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    pusher = _Pusher()
    _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), pusher=pusher,
         tagger=_tagger_returns({"greenhouse-1": "0-2"}), cfg=cfg)
    assert pusher.calls == []


def test_failed_push_does_not_mark_pushed():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    pusher = _Pusher(ok=False)                       # topic unset / send failed
    summary = _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), pusher=pusher,
                   tagger=_tagger_returns({"greenhouse-1": "3+"}))
    assert len(pusher.calls) == 1
    assert store.pushed_marks == [] and summary.pushed == 0


# ---- runtime deadline clamp (run_budget_min goes to 120m; Lambda kills at 900s)

def _sweep(budget_min, companies=1):
    store = FakeSheetStore([Company(f"Co{i}", "greenhouse", f"co{i}", seeded=True)
                            for i in range(companies)], {})
    summary = run_monitor(store, CFG, fetch=_fetch_returns({}), today=TODAY,
                          session=object(), pusher=_Pusher(), fetch_workers=1,
                          budget_min=budget_min)
    return summary, store


def test_runtime_deadline_sooner_than_the_budget_clamps_it(monkeypatch, capsys):
    # the killed-mid-flight case: 30m of believed budget inside a 2m runtime
    monkeypatch.setenv(run_mod.RUNTIME_DEADLINE_ENV, str(time.time() + 120))
    summary, store = _sweep(30)
    err = capsys.readouterr().err
    assert "run_budget_min=30m" in err and "clamping to 2.0m" in err   # both numbers, one line
    assert summary.boards_done == 1 and not summary.partial            # 2m still finishes this sweep
    assert len(store.health_rows) == 1


def test_runtime_deadline_later_than_the_budget_is_ignored(monkeypatch, capsys):
    monkeypatch.setenv(run_mod.RUNTIME_DEADLINE_ENV, str(time.time() + 3600))
    summary, _ = _sweep(5)
    assert "clamping" not in capsys.readouterr().err                   # the knob still owns the stop
    assert summary.boards_done == 1


def test_malformed_runtime_deadline_warns_and_leaves_the_budget_alone(monkeypatch, capsys):
    monkeypatch.setenv(run_mod.RUNTIME_DEADLINE_ENV, "in a bit")
    summary, _ = _sweep(30)
    err = capsys.readouterr().err
    assert "malformed" in err and "clamping" not in err
    assert summary.boards_done == 1 and not summary.partial            # a bad hint never skips a sweep


def _two_chunk_sweep(monkeypatch, *, jump_to, budget_min=30):
    """A sweep whose clock moves EXACTLY once: between fetch chunk 1 and chunk 2.

    The tests above only prove _clamp_deadline computes the right number — they pass
    unchanged if run_monitor throws that number away, because their sweeps finish either
    way. This harness makes the two deadlines separable: the clock lands past the clamped
    deadline but short of the `budget_min` one, so which deadline the loop is holding is
    the only thing that decides whether the run goes partial.

    FETCH_CHUNK + 1 boards = two chunks; the fake clock is frozen except for the jump the
    120th fetch performs, which lands after chunk 1's flush and before chunk 2's deadline
    check (monitor.run and monitor.tagworker both read the same patched time module).
    """
    clock = {"t": 1_000.0}
    monkeypatch.setattr(time, "monotonic", lambda: clock["t"])
    monkeypatch.setattr(time, "time", lambda: 5_000.0)      # _clamp_deadline's wall clock
    n = run_mod.FETCH_CHUNK + 1
    store = FakeSheetStore([Company(f"Co{i:03d}", "greenhouse", f"co{i}", seeded=True)
                            for i in range(n)], {})
    calls = {"n": 0}

    def fetch(ats, slug, company, session, workday_search="product"):
        calls["n"] += 1
        if calls["n"] == run_mod.FETCH_CHUNK:               # last board of chunk 1
            clock["t"] = jump_to
        return []

    summary = run_monitor(store, CFG, fetch=fetch, today=TODAY, session=object(),
                          pusher=_Pusher(), fetch_workers=1, budget_min=budget_min)
    return summary, store


def test_the_clamped_deadline_is_what_actually_stops_the_sweep(monkeypatch):
    # 100s of runtime left at t=5000 -> clamped stop at monotonic 1100; the 30m budget
    # would not stop until 2800, and the clock only ever reaches 2000.
    monkeypatch.setenv(run_mod.RUNTIME_DEADLINE_ENV, "5100")
    summary, store = _two_chunk_sweep(monkeypatch, jump_to=2_000.0)
    assert summary.partial is True                          # only the clamped value stops here
    assert summary.boards_done == run_mod.FETCH_CHUNK       # chunk 1 flushed, chunk 2 unvisited
    assert store.sweep_cursor == "Co120"                    # parked: next run resumes there
    assert store.health_rows == []                          # partial never rewrites the tab


def test_without_the_runtime_hint_the_same_clock_finishes_the_sweep(monkeypatch):
    """The control that makes the assertion above non-tautological: identical clock, identical
    budget, only the env var differs — so a discarded clamp would show up as this passing twice."""
    monkeypatch.delenv(run_mod.RUNTIME_DEADLINE_ENV, raising=False)
    summary, store = _two_chunk_sweep(monkeypatch, jump_to=2_000.0)
    assert summary.partial is False
    assert summary.boards_done == summary.boards_total == run_mod.FETCH_CHUNK + 1
    assert getattr(store, "sweep_cursor", "") == ""         # nothing to resume
    assert len(store.health_rows) == run_mod.FETCH_CHUNK + 1


def test_clamped_deadline_floors_at_60s_and_never_extends(monkeypatch):
    started, budget_deadline = 1_000.0, 1_000.0 + 1800     # a 30m budget on the monotonic clock
    monkeypatch.setenv(run_mod.RUNTIME_DEADLINE_ENV, str(time.time() + 5))
    # 5s left is less than the flush needs: take the floor, not a deadline already behind us
    assert run_mod._clamp_deadline(started, budget_deadline, 30) == pytest.approx(started + 60, abs=1)
    monkeypatch.setenv(run_mod.RUNTIME_DEADLINE_ENV, str(time.time() + 7200))
    assert run_mod._clamp_deadline(started, budget_deadline, 30) == budget_deadline
    monkeypatch.setenv(run_mod.RUNTIME_DEADLINE_ENV, "nan")            # parses as float, isn't a time
    assert run_mod._clamp_deadline(started, budget_deadline, 30) == budget_deadline


# ---- main() wiring: config problems -> ops push; heartbeat at end

def test_main_pushes_config_problems_to_ops_and_heartbeats(monkeypatch, tmp_path):
    from core.fakes import fake_hq
    from core.sheets import HQ
    import core.notify
    import monitor.run as run_mod

    hq = fake_hq()
    hq.tab("config").append_records([
        {"key": "yoe_push_max", "value": "banana"},
        # titles stated by the fixture, not inherited from the committed
        # defaults: this test is about a CONFIGURED instance completing, and
        # RM-40 Step 4 empties the committed titles (#251).
        {"key": "titles_include", "value": "product manager"},
    ])
    monkeypatch.setattr(HQ, "open", classmethod(lambda cls: hq))
    monkeypatch.setenv("HQ_SHEET_ID", "test-sheet")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(run_mod, "snapshot_path", lambda user="": str(tmp_path / "hq.json"))
    ops, pushes = [], []
    monkeypatch.setattr(core.notify, "ops_alert",
                        lambda title, body, session=None: ops.append((title, body)))
    monkeypatch.setattr(core.notify, "push",
                        lambda *a, **k: pushes.append(a) or True)

    assert run_mod.main() == 0
    assert ops and "yoe_push_max" in ops[0][1]
    beat = [r for r in hq.tab("config").records() if r["key"] == "heartbeat_monitor"]
    assert beat and beat[0]["value"] != ""
    assert (tmp_path / "hq.json").exists()


def test_main_empty_titles_pages_and_withholds_the_heartbeat(monkeypatch, tmp_path, capsys):
    """#252, end to end: delete one titles_include cell (selfheal re-seeds it
    BLANK under the persona-free defaults) and the old main() still
    snapshotted, mirrored and beat heartbeat_monitor — a permanently green
    discovery halt whose only trace was a log line. Now the run must be
    DISTINGUISHABLE from a healthy one: an ops page naming the cell, no
    heartbeat, no snapshot claiming a completed sweep, and a nonzero exit the
    Lambda envelope pages on and records as a failed bot_runs row."""
    from core import config as core_config
    from core.fakes import fake_hq
    from core.sheets import HQ
    import core.notify
    import monitor.run as run_mod

    # The halt state: persona-free committed defaults (what RM-40 Step 4
    # ships) and no titles anywhere else — cfg.include resolves empty.
    bare = {**core_config.defaults(), "titles_include": []}
    monkeypatch.setattr("core.config.defaults", lambda: bare)
    hq = fake_hq()
    monkeypatch.setattr(HQ, "open", classmethod(lambda cls: hq))
    monkeypatch.setenv("HQ_SHEET_ID", "test-sheet")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(run_mod, "snapshot_path", lambda user="": str(tmp_path / "hq.json"))
    ops = []
    monkeypatch.setattr(core.notify, "ops_alert",
                        lambda title, body, session=None: ops.append((title, body)))
    monkeypatch.setattr(core.notify, "push", lambda *a, **k: True)

    assert run_mod.main() == 1
    assert ops and any("titles_include" in body for _, body in ops)
    assert not any(r["key"] == "heartbeat_monitor"
                   for r in hq.tab("config").records()), \
        "an idle-by-misconfiguration run must not beat green"
    assert not (tmp_path / "hq.json").exists()   # no completed-sweep evidence
    assert "titles_include" in capsys.readouterr().err


def test_main_unconfigured_gives_actionable_message(monkeypatch, capsys):
    import monitor.run as run_mod
    monkeypatch.setattr("core.config.sheet_id", lambda: "")   # nothing pinned anywhere
    assert run_mod.main() == 1
    assert "bootstrap" in capsys.readouterr().err


# ---- SHEET-SUNSET Phase C: the mirror becomes the write.
#
# MUTATION TARGETS:
#   * drop the `first_class()` guard in mirror_pg -> the Phase-A test mirrors
#     when nobody asked, i.e. the flag changes nothing and everything;
#   * move the mirror_pg call after hq.heartbeat("monitor") -> the failure test
#     finds a fresh beat for a sweep that did not finish, and the digest's
#     watchdog is then blind to exactly the outage this flag exists to surface;
#   * swallow the PgError -> the failure test gets exit 0 and no ops push.

def _main_env(monkeypatch, tmp_path):
    """The `main()` harness the two Phase-C tests share (see the config-problems
    test above for the same wiring)."""
    from core.fakes import fake_hq
    from core.sheets import HQ
    import core.notify
    import monitor.run as run_mod

    hq = fake_hq()
    # A configured search, stated by the fixture rather than inherited from
    # the committed defaults (which RM-40 Step 4 empties, #251) — an
    # unconfigured instance skips before the sweep since #252.
    hq.tab("config").append_records([
        {"key": "titles_include", "value": "product manager"}])
    monkeypatch.setattr(HQ, "open", classmethod(lambda cls: hq))
    monkeypatch.setenv("HQ_SHEET_ID", "test-sheet")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(run_mod, "snapshot_path", lambda user="": str(tmp_path / "hq.json"))
    ops = []
    monkeypatch.setattr(core.notify, "ops_alert",
                        lambda title, body, session=None: ops.append((title, body)))
    monkeypatch.setattr(core.notify, "push", lambda *a, **k: True)
    return hq, ops


def _beat(hq, name="heartbeat_monitor"):
    return [r for r in hq.tab("config").records() if r["key"] == name]


def test_phase_a_sweep_never_writes_the_store(monkeypatch, tmp_path):
    from core import pgwrites
    import monitor.pgmirror as pgmirror
    import monitor.run as run_mod

    hq, _ops = _main_env(monkeypatch, tmp_path)
    monkeypatch.delenv(pgwrites.FLAG_ENV, raising=False)
    monkeypatch.setattr(pgmirror, "mirror",
                        lambda *a, **k: pytest.fail("the sweep mirrored in Phase A"))
    assert run_mod.main() == 0
    assert _beat(hq)                       # and the sweep still heartbeats


def test_first_class_sweep_mirrors_the_feed_before_it_heartbeats(monkeypatch, tmp_path):
    from core import pgwrites
    import monitor.pgmirror as pgmirror
    import monitor.run as run_mod

    hq, _ops = _main_env(monkeypatch, tmp_path)
    monkeypatch.setenv(pgwrites.FLAG_ENV, pgwrites.FIRST_CLASS)
    monkeypatch.setenv(pgwrites.USER_ENV, "11111111-1111-1111-1111-111111111111")
    monkeypatch.setattr("core.pg.enabled", lambda: True)
    seen = []
    monkeypatch.setattr(pgmirror, "mirror", lambda h, uid, session=None:
                        seen.append((uid, bool(_beat(h)))) or (7, 7, []))
    assert run_mod.main() == 0
    # the beat was NOT yet written when the store was mirrored — ordering, asserted
    # from inside the call rather than inferred from the source
    assert seen == [("11111111-1111-1111-1111-111111111111", False)]
    assert _beat(hq)


def test_a_store_failure_fails_the_sweep_and_withholds_the_heartbeat(monkeypatch, tmp_path):
    from core import pg, pgwrites
    import monitor.pgmirror as pgmirror
    import monitor.run as run_mod

    hq, ops = _main_env(monkeypatch, tmp_path)
    monkeypatch.setenv(pgwrites.FLAG_ENV, pgwrites.FIRST_CLASS)
    monkeypatch.setenv(pgwrites.USER_ENV, "11111111-1111-1111-1111-111111111111")
    monkeypatch.setattr("core.pg.enabled", lambda: True)

    def boom(*a, **k):
        raise pg.PgError("upsert postings -> HTTP 503: store down")
    monkeypatch.setattr(pgmirror, "mirror", boom)

    assert run_mod.main() == 1
    assert ops and "Monitor run FAILED" in ops[0][0]
    # The sheet lane is untouched by the abort — it finished before pg was called.
    assert (tmp_path / "hq.json").exists()
    assert not _beat(hq), "a sweep that could not write the store must not claim it ran"
