"""Every fetcher says who it is, and says the same thing.

Two guards, because either alone is escapable:

`test_every_fetcher_sends_the_declared_identity` drives all fourteen registered
fetchers through a recording session and reads what actually went on the wire.
That session is seeded with a browser spoof on purpose — a fetcher that omits
its own `User-Agent` inherits whatever the shared session carries (which is how
`monitor/scripts/smoke_adapters.py` used to reach them), so the seed turns
"forgot the header" from a silent inheritance into a red test.

`test_the_fetch_path_declares_no_agent_of_its_own` sweeps the source. The wire
test only sees the paths a fake session can reach; the sweep sees the whole
file, including a constant staged for a branch that fixture data never takes.
It reads the AST rather than grepping, so `"Mozilla" "/5.0"` split across two
adjacent literals is one string to it, and so a value can be required to be the
shared NAME rather than merely to look right.

THE SWEPT SET IS NOT JUST monitor/fetchers/. A per-file sweep that stops at the
fetcher directory is routed around by one line in a CALLER, because every
fetcher is handed a shared `requests.Session` and `session.headers` is a
default the fetchers would inherit. `monitor/scripts/smoke_adapters.py` was
doing exactly that — seeding the Chrome spoof onto the session it passed to
`get_jobs_for` — and a directory-scoped sweep would have called the tree clean
while every smoke request went out impersonating a browser. So the swept set is
the fetcher directory PLUS every module that mentions `get_jobs_for`, found by
reading the tree rather than by a hand-kept list: a new caller is swept the day
it is written, which is the only version of this that survives contact.

The sweep's real target is the attack the issue named: a fetcher that reads its
agent from `os.environ` or config, which is textually spotless and routes the
whole thing around a source-level check on the next deploy. `agent_offenses`
therefore judges values structurally — the value bound to a `User-Agent` key
must be the imported `USER_AGENT` name, not a call, not a subscript, not a
literal that happens to be polite. `test_sweep_flags_*` writes each of those
counterexamples to disk and sweeps it, so the sweep is proven capable of
failing rather than assumed to be.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path
from urllib.parse import urlparse

import pytest

from core.useragent import CONTACT, HOMEPAGE, PRODUCT, USER_AGENT
from monitor.fetchers import _REGISTRY, get_jobs_for

REPO = Path(__file__).resolve().parents[2]
FETCHER_DIR = REPO / "monitor" / "fetchers"
MONITOR_DIR = REPO / "monitor"

# Tokens no server-side client of ours has any business claiming.
_BROWSER = re.compile(
    r"Mozilla/|AppleWebKit|KHTML|Chrome/|Chromium/|Safari/|Firefox/|Edg[e]?/|"
    r"Trident/|Gecko/|Version/\d",
    re.I,
)
# Names a second agent string would plausibly hide behind.
_AGENTISH = re.compile(r"^_*(ua|uas|agent|user_?agent|useragent)_*\d*$", re.I)
_SHARED = "USER_AGENT"


def _is_shared_reference(node: ast.AST) -> bool:
    """`USER_AGENT` or `useragent.USER_AGENT` — and nothing else, deliberately.

    An alias (`import USER_AGENT as UA`) or a wrapper (`_ua()`) would read fine
    and defeat the point, which is that there is ONE spelling to grep for.
    """
    if isinstance(node, ast.Name):
        return node.id == _SHARED
    if isinstance(node, ast.Attribute):
        return node.attr == _SHARED
    return False


def _is_user_agent_key(node: ast.AST) -> bool:
    return (isinstance(node, ast.Constant) and isinstance(node.value, str)
            and node.value.strip().lower() == "user-agent")


def agent_offenses(source: str, label: str) -> list[str]:
    """Every way `label`'s source declares an identity that is not the shared one."""
    found: list[str] = []
    tree = ast.parse(source, filename=label)

    for node in ast.walk(tree):
        # 1. A browser token anywhere in the file, however it is spelled or split.
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if _BROWSER.search(node.value):
                found.append(f"{label}:{node.lineno}: browser-impersonating string")

        # 2. A module- or function-level constant named like an agent.
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for t in targets:
                if isinstance(t, ast.Name) and _AGENTISH.match(t.id):
                    if node.value is None or not _is_shared_reference(node.value):
                        found.append(
                            f"{label}:{node.lineno}: `{t.id}` binds an agent that is "
                            f"not core.useragent.{_SHARED}")
                # 3. session.headers["User-Agent"] = <anything but the shared name>
                elif isinstance(t, ast.Subscript) and _is_user_agent_key(t.slice):
                    if node.value is None or not _is_shared_reference(node.value):
                        found.append(
                            f"{label}:{node.lineno}: assigns a User-Agent that is not "
                            f"core.useragent.{_SHARED}")

        # 4. {"User-Agent": <anything but the shared name>} — the literal, the
        #    env lookup, the config subscript, the helper call.
        elif isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if key is not None and _is_user_agent_key(key):
                    if not _is_shared_reference(value):
                        found.append(
                            f"{label}:{getattr(key, 'lineno', 0)}: User-Agent header "
                            f"value is not core.useragent.{_SHARED}")
    return found


def sweep(directory: Path) -> list[str]:
    """Offenses across every module in a fetcher directory."""
    return sweep_paths(sorted(directory.glob("*.py")))


def sweep_paths(paths) -> list[str]:
    out: list[str] = []
    for path in paths:
        out.extend(agent_offenses(path.read_text(), path.name))
    return out


def declares_shared_identity(source: str) -> bool:
    """Imports the one constant by its one name."""
    return any(isinstance(n, ast.ImportFrom) and n.module == "core.useragent"
               and any(a.name == _SHARED and a.asname is None for a in n.names)
               for n in ast.walk(ast.parse(source)))


def issues_requests(source: str) -> bool:
    """Calls `session.get(...)` / `session.post(...)` — narrow on purpose, since
    a bare `.get` in these modules is almost always a dict lookup."""
    return any(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
               and n.func.attr in ("get", "post")
               and isinstance(n.func.value, ast.Name)
               and n.func.value.id in ("session", "sess", "s")
               for n in ast.walk(ast.parse(source)))


def session_seeders(root: Path) -> list[Path]:
    """Modules outside the fetcher directory that hand a session to the
    fetchers — the surface where a shared-session default can be seeded."""
    return [p for p in sorted(root.rglob("*.py"))
            if FETCHER_DIR not in p.parents and "get_jobs_for" in p.read_text()]


def swept_paths() -> list[Path]:
    return sorted(FETCHER_DIR.glob("*.py")) + session_seeders(MONITOR_DIR)


# ---------------------------------------------------------------- the identity


def test_the_declared_identity_is_not_a_browser():
    assert not _BROWSER.search(USER_AGENT), USER_AGENT
    assert USER_AGENT.startswith(PRODUCT + "/")


def test_the_declared_identity_carries_a_contact_route():
    assert HOMEPAGE in USER_AGENT and CONTACT in USER_AGENT


def test_the_contact_route_is_a_role_address_on_the_product_domain():
    """#184 is pulling the owner's personal address out of this repo; the shared
    identity must not put it back on fourteen more endpoints. Pinning the
    contact to the product's own host forbids a personal mailbox structurally,
    without naming one here."""
    assert CONTACT.endswith("@" + urlparse(HOMEPAGE).netloc)


# ------------------------------------------------------------------- the wire


class _Response:
    """A terminal first page: every fetcher's loop exits after one request."""

    status_code = 200
    text = ""

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload

    def raise_for_status(self):
        return None


_EMPTY_PAGE = {
    "jobs": [], "totalCount": 0, "hits": 0,          # greenhouse/ashby/icims/amazon
    "content": [], "totalFound": 0,                  # smartrecruiters
    "jobPostings": [], "total": 0,                   # workday
    "positions": [], "count": 0,                     # eightfold
    "items": [{}],                                   # oracle_hcm
    "data": {"roleSearch": {"items": [], "totalCount": 0}},   # goldman
    "results": "",                                   # radancy
}
_PAYLOADS = {"lever": []}       # lever's board is a bare list

_SLUGS = {
    "greenhouse": "acme", "ashby": "acme", "lever": "acme", "smartrec": "acme",
    "icims": "jobs.acme.test", "sfsf": "jobs.acme.test",
    "workday": "acme.wd1.myworkdayjobs.com/Careers",
    "amazon": "amazon", "google": "google", "apple": "apple", "goldman": "goldman",
    "radancy": "jobs.acme.test",
    "eightfold": "acme.eightfold.ai|acme.test",
    "oraclehcm": "acme.fa.us2.oraclecloud.com|CX_1001",
}

_SEEDED_SPOOF = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 "
                 "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


class _RecordingSession:
    """Merges session-level and per-request headers the way requests does, so a
    fetcher that sends nothing is recorded as sending the seeded spoof."""

    def __init__(self, payload):
        self._payload = payload
        self.headers = {"User-Agent": _SEEDED_SPOOF}
        self.calls: list[dict] = []

    def get(self, url, **kwargs):
        return self._record(url, kwargs)

    def post(self, url, **kwargs):
        return self._record(url, kwargs)

    def _record(self, url, kwargs):
        sent = dict(self.headers)
        sent.update(kwargs.get("headers") or {})
        self.calls.append({"url": url, "headers": sent})
        return _Response(self._payload)


@pytest.mark.parametrize("ats", sorted(_REGISTRY))
def test_every_fetcher_sends_the_declared_identity(ats):
    session = _RecordingSession(_PAYLOADS.get(ats, _EMPTY_PAGE))
    get_jobs_for(ats, _SLUGS[ats], "Acme", session, workday_search="product manager")

    assert session.calls, f"{ats} made no request to inspect"
    for call in session.calls:
        assert call["headers"].get("User-Agent") == USER_AGENT, (
            f"{ats} sent {call['headers'].get('User-Agent')!r} to {call['url']}")


def test_the_registry_leaves_no_fetcher_unmeasured():
    """A new ATS lands in _REGISTRY and _SLUGS at once, or the wire test above
    silently stops covering it."""
    assert set(_REGISTRY) == set(_SLUGS)


# ------------------------------------------------------------------ the source


def test_the_fetch_path_declares_no_agent_of_its_own():
    # assertion-lint: absence-only: "no second identity anywhere on the fetch
    # path" is the property itself; the test_sweep_flags_* counterexamples below
    # are what prove this can fail, and the positive half lives in the next test.
    assert sweep_paths(swept_paths()) == []


def test_every_fetcher_that_reaches_the_network_names_the_shared_identity():
    """The sweep above only rejects a WRONG agent; a fetcher that sends none at
    all is textually spotless and silently inherits whatever the shared session
    carries. That was the state of five of these files before this change, so
    the absence needs its own positive check rather than trusting the wire test
    to reach every branch."""
    fetching = [p for p in sorted(FETCHER_DIR.glob("*.py"))
                if issues_requests(p.read_text())]
    assert len(fetching) == len(_REGISTRY), [p.name for p in fetching]
    for path in fetching:
        assert declares_shared_identity(path.read_text()), path.name


def test_the_swept_set_reaches_past_the_fetcher_directory():
    """The seeder half is the half a directory-scoped sweep misses; if this set
    ever comes back empty the sweep above still passes and means nothing."""
    seeders = {p.name for p in session_seeders(MONITOR_DIR)}
    assert "smoke_adapters.py" in seeders     # seeds session.headers directly
    assert "run.py" in seeders                # the nightly fetch path


def test_a_new_caller_is_swept_the_day_it_is_written(tmp_path):
    """Discovery reads the tree, so nobody has to remember a list."""
    (tmp_path / "fetchers").mkdir()
    newcomer = tmp_path / "new_caller.py"
    newcomer.write_text("from monitor.fetchers import get_jobs_for\n")
    assert newcomer in session_seeders(tmp_path)


_CONFORMING = '''
from core.useragent import USER_AGENT


def get_jobs(slug, company, session):
    return session.get("https://example.test/jobs",
                       headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
'''

_IMPERSONATES = '''
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def get_jobs(slug, company, session):
    return session.get("https://example.test/jobs", headers={"User-Agent": UA})
'''

_READS_ENV = '''
import os


def get_jobs(slug, company, session):
    return session.get("https://example.test/jobs",
                       headers={"User-Agent": os.environ.get("HQ_FETCH_UA", "")})
'''

_READS_CONFIG = '''
from monitor import settings

_UA = settings.CONFIG["fetch"]["user_agent"]


def get_jobs(slug, company, session):
    return session.get("https://example.test/jobs", headers={"User-Agent": _UA})
'''

_SECOND_HONEST_IDENTITY = '''
def get_jobs(slug, company, session):
    return session.get("https://example.test/jobs",
                       headers={"User-Agent": "job-hq-scraper/2.0 (+https://example.test)"})
'''

_SESSION_HEADER = '''
def get_jobs(slug, company, session):
    session.headers["User-Agent"] = "acme-bot/1.0"
    return session.get("https://example.test/jobs")
'''

# The shape a fetcher-directory-only sweep cannot see: the identity is seeded
# onto the shared session by the CALLER, and every fetcher inherits it.
_SEEDS_THE_SHARED_SESSION = '''
import requests

from monitor.fetchers import get_jobs_for


def main():
    session = requests.Session()
    session.headers["User-Agent"] = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
    return get_jobs_for("greenhouse", "acme", "Acme", session)
'''


def _dir_with(tmp_path: Path, name: str, source: str) -> Path:
    """A fetcher directory holding one conforming module and one candidate.

    Deliberately NOT a copy of the real directory: a counterexample has to fail
    for its own reason, not inherit whichever offense the live tree is currently
    growing — otherwise the day this suite matters is the day its evidence
    becomes unreadable.
    """
    (tmp_path / "conforming.py").write_text(_CONFORMING)
    (tmp_path / name).write_text(source)
    return tmp_path


def test_sweep_passes_a_conforming_new_fetcher(tmp_path):
    """The counterexamples below only mean something if the sweep can say yes."""
    # assertion-lint: absence-only: "no offenses" IS the property — this is the
    # control that stops the counterexamples below passing on a sweep that
    # simply flags everything it is handed.
    assert sweep(_dir_with(tmp_path, "also_conforming.py", _CONFORMING)) == []


@pytest.mark.parametrize("name,source", [
    ("impersonates.py", _IMPERSONATES),
    ("reads_env.py", _READS_ENV),
    ("reads_config.py", _READS_CONFIG),
    ("second_identity.py", _SECOND_HONEST_IDENTITY),
    ("session_header.py", _SESSION_HEADER),
    ("seeds_the_shared_session.py", _SEEDS_THE_SHARED_SESSION),
])
def test_sweep_flags_a_fetcher_that_brings_its_own_agent(tmp_path, name, source):
    offenses = sweep(_dir_with(tmp_path, name, source))
    assert offenses, f"{name} slipped past the sweep"
    assert all(o.startswith(name) for o in offenses), offenses


def test_sweep_reads_the_ast_not_the_text():
    """Adjacent literals concatenate before the check, so splitting the string
    is not a way through."""
    hidden = 'UA = "Mozi" "lla/5.0 (Macintosh) Chr" "ome/126.0"\n'
    assert agent_offenses(hidden, "hidden.py")
