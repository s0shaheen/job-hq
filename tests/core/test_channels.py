"""Notification policy — the choke point that makes a second human safe (AC24).

The failure this file exists for: Dad's profile says `notify_channel: email`, and on
the day he is added a discovery sweep pushes to a phone topic he never asked to
watch. That is not hypothetical — before `core/channels.py` the decision lived at the
CALL SITES, and two of the four push paths (`monitor/wide.py`, `tracker/digest.py`)
never had the check at all.

So every test here asks one of two questions:
  1. can a jobs push reach an email-only user, through ANY job?  (AC24, matrix row 34)
  2. can an OPS alert be suppressed by a user's preference?      (it must not)

The four-job tests deliberately drive the real `core.notify.push` rather than a fake
pusher: a spy substituted for the choke point cannot prove the choke point works.
`tests/conftest.py`'s autouse stub is what keeps that off the real ntfy topics.
"""
import ast
import datetime as dt
from pathlib import Path

import pytest

from core import channels, notify
from core.fakes import fake_hq
from core.profile import Profile

REPO = Path(__file__).resolve().parents[2]
TODAY = "2026-07-19"


# --------------------------------------------------------------- policy unit

def test_email_only_user_drops_every_jobs_event():
    """AC24 at the policy level: dad's ceiling is `email`, so nothing routes to push."""
    for event in channels.EVENTS:
        d = channels.allow("dad", event=event)
        assert d.verdict == channels.DROP, f"{event} was allowed for an email-only user"
        assert "push" not in d.channel


def test_ntfy_user_gets_the_events_their_matrix_says_yes_to():
    """The canary for the test above — if this one ever goes red the drop tests
    stop meaning anything, because *nothing* would be pushing."""
    assert channels.allow("salman", event="new_roles").verdict == channels.SEND
    assert channels.allow("salman", event="digest").verdict == channels.SEND


def test_per_event_matrix_overrides_the_coarse_channel():
    """Roommate watches ntfy but asked for no status-change or nudge pings —
    the per-event knob has to be able to say no inside a yes ceiling."""
    assert channels.allow("roommate", event="new_roles").verdict == channels.SEND
    assert channels.allow("roommate", event="status_change").verdict == channels.DROP
    assert channels.allow("roommate", event="stale_nudge").verdict == channels.DROP


def test_notify_channel_is_a_ceiling_the_matrix_cannot_raise():
    """The committed default for `digest` is `both`. An email-only user must get
    the email leg and NOT the push leg — a matrix that merged instead of clamping
    would push to him by default, which is exactly the AC24 regression."""
    assert Profile.load("dad").notify_digest == "both"      # inherited, unedited
    assert channels.channel_for(Profile.load("dad"), "digest") == "email"
    assert channels.allow("dad", event="digest").verdict == channels.DROP


def test_unknown_notify_channel_is_treated_as_silence_not_as_yes():
    prof = Profile.load("salman")
    prof.notify_channel = "carrier pigeon"
    assert channels.channel_for(prof, "new_roles") == "none"


def test_unknown_event_fails_loud():
    """An event nobody registered is a code bug, and guessing either way is worse
    than a red run: guess `send` and you spam somebody, guess `drop` and the
    notification vanishes silently."""
    with pytest.raises(ValueError):
        channels.allow("salman", event="new_rolez")


def test_ops_alerts_are_never_suppressed_by_a_users_preference():
    """Ops alerts page the OPERATOR about a broken system (every user's ops topic
    points at Salman). A user preference must not be able to silence them."""
    for user in ("dad", "roommate", "salman", ""):
        assert channels.allow(user, event=channels.OPS_EVENT,
                              kind="ops").verdict == channels.SEND


def test_ops_alert_reaches_the_wire_for_an_email_only_user(blocked_ntfy):
    assert notify.ops_alert("[dad] tracker failed", "boom", user="dad") is True
    assert len(blocked_ntfy.posts) == 1


# --------------------------------------------------- the bypass is not borrowable

def test_the_ops_bypass_cannot_be_borrowed_by_a_jobs_caller(blocked_ntfy):
    """The exact probe. `kind` picks the TOPIC, so a bypass keyed on the EVENT
    name would let any jobs caller write `event="ops"` and get: dad's email-only
    ceiling skipped, his quiet hours skipped, and the push delivered to his JOBS
    topic. Three checks defeated by one string.

    It raises rather than dropping quietly, because reaching this line is a
    caller bug and a silent `False` is how a caller bug becomes a habit."""
    with pytest.raises(ValueError, match="kind='ops'"):
        notify.push("t", "b", event=channels.OPS_EVENT, kind="jobs", user="dad")
    assert blocked_ntfy.posts == [], "the ops bypass leaked a jobs push"


def test_the_same_probe_at_the_policy_level():
    with pytest.raises(ValueError):
        channels.allow("dad", event=channels.OPS_EVENT)          # kind defaults to jobs
    with pytest.raises(ValueError):
        channels.allow("salman", event=channels.OPS_EVENT, kind="jobs")
    # the canary: named with its own kind it is still the bypass
    assert channels.allow("dad", event=channels.OPS_EVENT, kind="ops").verdict \
        == channels.SEND


def test_the_bypass_keys_on_kind_not_on_the_event_name():
    """`kind="ops"` is authoritative even for a registered jobs event: an ops
    alert composed with a jobs event name still pages the operator rather than
    being clamped by the user's matrix."""
    assert channels.allow("dad", event="digest", kind="jobs").verdict == channels.DROP
    assert channels.allow("dad", event="digest", kind="ops").verdict == channels.SEND


# ------------------------------------------------- a named user with no profile

def test_a_named_user_with_no_profile_file_gets_silence_not_the_defaults(capsys):
    """Fails CLOSED. The committed default channel is `ntfy`, so a registry user
    whose `users/<name>/profile.yaml` is missing (added to the registry but not
    the repo; or the Lambda image built before the file landed) would otherwise
    inherit a push — and on a flat registry that push lands on the OPERATOR's
    topic, carrying somebody else's search."""
    from core.profile import Profile
    prof = Profile.load("nobody")
    assert prof.notify_channel == "none"
    assert "nobody" in capsys.readouterr().err
    for event in channels.EVENTS:
        assert channels.allow("nobody", event=event).verdict == channels.DROP


def test_single_user_mode_is_untouched_by_that_rule(blocked_ntfy):
    """`user=""` is the live registry shape: there is no per-user file to miss,
    so the committed defaults stay the answer and the push still goes out."""
    from core.profile import Profile
    assert Profile.load("").notify_channel == "ntfy"
    assert notify.push("t", "b", event="new_roles", user="") is True
    assert len(blocked_ntfy.posts) == 1


def test_a_flat_single_user_registry_still_pushes(blocked_ntfy):
    """Backwards compatibility: the live registry is flat, so `user=""` resolves
    the committed defaults and must behave exactly as it did before this module."""
    assert notify.push("t", "b", event="new_roles") is True
    assert len(blocked_ntfy.posts) == 1


def test_push_requires_an_event():
    with pytest.raises(TypeError):
        notify.push("t", "b")


# ------------------------------------------------- AC24 through all four jobs
# One recording session, four real jobs, one assertion: an email-only user's
# phone stays silent. Each driver also runs for a push user, so a driver that
# silently stopped producing a pushable role cannot fake a pass.
#
# The recorder is passed as `session=`, not left to conftest's module stub,
# because three of the four jobs hand their own live requests.Session to
# push() — reaching the real network is precisely what that would do.

def _jobs_posts(recorder):
    """Posts to the JOBS topic only. Ops alerts share the recorder and must be
    ignored here: the digest legitimately ops-alerts ("HQ backups stale") on a
    fixture with no heartbeats, and suppressing THAT would be its own bug."""
    ops = notify._topic("ops")
    return [p for p in recorder.posts if not p[0].endswith(ops)]


def _drive_monitor(user, title, recorder, _mp):
    from monitor.config import RuntimeConfig
    from monitor.models import Company, Job
    from monitor.run import run_monitor
    from monitor.sheet import FakeSheetStore
    from monitor.tagging import Tags

    cos = [Company(name="Acme", ats="greenhouse", slug="a", monitor=True, seeded=True)]
    job = Job("greenhouse", "1", "Acme", title, "Chicago, IL", "http://x")
    cfg = RuntimeConfig(include=[title.casefold()], exclude=[], workday_search="product",
                        yoe_push_max=4, push_new_jobs=True, push_status_events=True)
    s = run_monitor(FakeSheetStore(cos, {}), cfg,
                    fetch=lambda *a, **k: [job],
                    tagger=lambda rec, slug: Tags(yoe="2+ years"),
                    today=TODAY, session=recorder, fetch_workers=1, user=user)
    return s.new_count


def _drive_priority(user, title, recorder, _mp):
    from monitor.models import Job
    from monitor.priority import run as priority_run

    hq = fake_hq()
    hq.user = user
    hq.tab("companies").append_records([{"name": "Plaid", "ats": "greenhouse",
                                         "slug": "plaid", "monitor": "TRUE",
                                         "seeded": "TRUE", "priority": "TRUE"}])
    hq.tab("config").append_records([{"key": "titles_include", "value": title}])
    job = Job("greenhouse", "11", "Plaid", title, "Chicago, IL", "http://11")
    s = priority_run(hq, fetch=lambda *a, **k: [job], tagger=None, today=TODAY,
                     session=recorder)
    return s.new


def _drive_wide(user, title, recorder, monkeypatch):
    from monitor.wide import run as wide_run
    from tests.monitor.test_wide import FakeApify, cafe_item

    monkeypatch.setenv("APIFY_TOKEN", "token")
    hq = fake_hq()
    hq.user = user
    item = cafe_item(title=title, location="Chicago, Illinois, United States", yoe=2,
                     posted=f"{TODAY}T04:00:00.000Z")   # newer than the default cursor
    s = wide_run(hq, session=recorder,
                 client_factory=lambda t: FakeApify(items=[item]),
                 today=TODAY, sources=("cafe",))
    return s.appended


def _drive_digest(user, _title, _recorder, _mp):
    from tracker import digest

    hq = fake_hq()
    hq.user = user
    hq.registry["sheet_id"] = "SHEETID"
    out = digest.run(hq, now=dt.datetime(2026, 7, 19, 15, 0, tzinfo=dt.timezone.utc))
    return 1 if out["body"] else 0


DRIVERS = {"monitor": _drive_monitor, "priority": _drive_priority,
           "wide": _drive_wide, "digest": _drive_digest}
# each user's own matching title — a role the profile does not match would make
# the whole test vacuous
TITLES = {"dad": "Senior Financial Analyst", "salman": "Senior Product Manager"}


@pytest.mark.parametrize("job", sorted(DRIVERS))
def test_no_job_pushes_to_an_email_only_user(job, blocked_ntfy, monkeypatch):
    """AC24 / matrix row 34, per job. Four jobs, one enforcement point."""
    produced = DRIVERS[job]("dad", TITLES["dad"], blocked_ntfy, monkeypatch)
    assert produced > 0, f"{job} produced nothing pushable — test is vacuous"
    assert _jobs_posts(blocked_ntfy) == [], f"{job} pushed to an email-only user"


@pytest.mark.parametrize("job", sorted(DRIVERS))
def test_the_same_four_jobs_do_push_for_a_push_user(job, blocked_ntfy, monkeypatch):
    """The mutation canary for the test above: same drivers, a ntfy user, and now
    a push MUST land. Without this pair, a driver that quietly stopped pushing
    would make every AC24 assertion pass for the wrong reason."""
    DRIVERS[job]("salman", TITLES["salman"], blocked_ntfy, monkeypatch)
    assert len(_jobs_posts(blocked_ntfy)) == 1, f"{job} did not push for a ntfy user"


# ------------------------------------------------------------ static defences

def _live_strings(tree: ast.AST) -> list[str]:
    """Every string LITERAL the interpreter can use, docstrings excluded.

    Prose about ntfy is not a second door to ntfy; a URL in a docstring is
    documentation. What matters is a literal something can post to."""
    docs = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef,
                             ast.AsyncFunctionDef)):
            first = node.body[0] if getattr(node, "body", None) else None
            if (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
                    and isinstance(first.value.value, str)):
                docs.add(id(first.value))
    return [n.value for n in ast.walk(tree)
            if isinstance(n, ast.Constant) and isinstance(n.value, str)
            and id(n) not in docs]


def _repo_modules():
    for path in sorted(REPO.glob("**/*.py")):
        rel = path.relative_to(REPO).as_posix()
        if rel.startswith((".claude/", ".venv/", "tests/", "webapp/", "editor/",
                           "node_modules/")):
            continue
        yield rel, path


def test_no_module_outside_core_notify_holds_an_ntfy_endpoint():
    """Matrix row 34, made unrepeatable — checked on the parse tree, not the
    file text.

    The text grep this replaces answered a weaker question ("does `ntfy.sh`
    appear anywhere in the bytes?"). It fired on comments and docstrings, which
    pushes future authors toward euphemism rather than toward the choke point.
    The AST asks the question that matters: is there a literal the interpreter
    could hand to `requests.post`? Adjacent-literal and f-string pieces are
    Constants too, so both of the obvious ways around the grep are covered.

    Deliberate exceptions: `infra/alerter/index.py` is a SEPARATE stdlib-only
    Lambda (SNS -> ntfy) that exists precisely for the case where the bots
    cannot report anything, and `appsscript/` has no Python runtime at all.
    """
    offenders = []
    for rel, path in _repo_modules():
        if rel in ("core/notify.py", "infra/alerter/index.py"):
            continue
        try:
            tree = ast.parse(path.read_text())
        except SyntaxError:                       # not importable anyway
            continue
        if any("ntfy.sh" in s for s in _live_strings(tree)):
            offenders.append(rel)
    assert offenders == [], (f"{offenders} name an ntfy endpoint in live code — route "
                            "it through core.notify.push so the channel policy applies")


def test_send_is_the_only_poster_in_core_notify_and_push_its_only_caller():
    """The other side of the same door. One module owning the URL is worth
    nothing if three functions inside it can post: the policy runs in `push`,
    so `push` has to be the only way to reach `_send`, and `_send` the only
    thing that posts."""
    tree = ast.parse((REPO / "core" / "notify.py").read_text())
    funcs = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}

    def calls(fn, name):
        return any(isinstance(c, ast.Call) and (
            (isinstance(c.func, ast.Attribute) and c.func.attr == name)
            or (isinstance(c.func, ast.Name) and c.func.id == name))
            for c in ast.walk(fn))

    assert {n for n, f in funcs.items() if calls(f, "post")} == {"_send"}
    assert {n for n, f in funcs.items() if calls(f, "_send")} == {"push"}


def test_config_validators_accept_exactly_the_documented_channels():
    """Drift guard: a knob whose validator allows a value `channel_for` cannot
    resolve would fall back to the default and confuse the operator."""
    from core.config import VALIDATORS
    for event in channels.EVENTS:
        parse = VALIDATORS[f"notify_{event}"]
        for good in channels.CHANNELS:
            assert parse(good) == good
        with pytest.raises(ValueError):
            parse("sometimes")


def test_every_event_has_a_committed_default_and_a_profile_field():
    from core.config import defaults
    base, prof = defaults(), Profile.load("salman")
    for event in channels.EVENTS:
        key = f"notify_{event}"
        assert base[key] in channels.CHANNELS, f"{key} missing from config_defaults.yaml"
        assert hasattr(prof, key), f"Profile has no {key} field"
        assert (key, key) in Profile.OVERLAY, f"{key} is not Config-tab overridable"
