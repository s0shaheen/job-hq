"""The render service against the REAL `rendercv[full]==2.8` — the two vulnerabilities as the
library actually has them, plus the one-page gate over every theme.

WHY THIS EXISTS ALONGSIDE test_render_guards.py: that file tests the boundary against a double,
so it can run in the repo's 3.11 suite where rendercv is not installed. A double is only worth
what its fidelity is worth, and fidelity to a third-party library decays silently on every
version bump. This file is the check on that: it re-derives both vectors FROM THE LIBRARY, so
the day rendercv changes shape the double is caught being wrong rather than quietly protecting
against an attack that moved.

It skips where rendercv is absent — which is the repo's own `tests` job, because rendercv 2.8
requires Python >= 3.12 and the bots' requirements.txt is 3.11. It does NOT skip in CI: the
`render` job in ci.yml installs infra/render/requirements.txt on 3.12 and runs this file, and
that job is the one that must be green before the render Lambda ships.

NETWORK: exactly one test opens a socket, to a loopback HTTP server this file starts on an
ephemeral port. Nothing here may ever be pointed at 169.254.169.254 or any other real internal
address — the string is used as DATA (the value handed to the renderer) and the observation is
made on the local stand-in.
"""
from __future__ import annotations

import copy
import http.server
import importlib.metadata
import importlib.util
import json
import os
import pathlib
import re
import sys
import threading

import pytest

RENDER_DIR = pathlib.Path(__file__).resolve().parents[2] / "infra" / "render"
FIXTURES = RENDER_DIR / "fixtures"

#: The pin. Not `>=`: rendercv breaks compatibility inside 2.x, and both vectors below are
#: statements about 2.8's code. A different version must re-derive them, not inherit them.
PINNED = "2.8"

_why = None
try:
    _installed = importlib.metadata.version("rendercv")
    if _installed != PINNED:
        _why = f"rendercv {_installed} installed, this suite is derived from {PINNED}"
except importlib.metadata.PackageNotFoundError:
    _why = "rendercv is not installed (see infra/render/requirements.txt)"

# HQ_REQUIRE_RENDERCV=1 turns the skip into a collection error — set by ci.yml's `render` job,
# which is the one place these tests are supposed to RUN. Without it, a broken pin there would
# skip the entire security suite and the job would report green. Same shape as HQ_REQUIRE_DB.
if _why and os.environ.get("HQ_REQUIRE_RENDERCV") == "1":
    raise RuntimeError(f"HQ_REQUIRE_RENDERCV=1 but {_why}")

pytestmark = pytest.mark.skipif(_why is not None, reason=_why or "")


@pytest.fixture(scope="module")
def render():
    sys.path.insert(0, str(RENDER_DIR))
    try:
        spec = importlib.util.spec_from_file_location("hq_render_live", RENDER_DIR / "render.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        sys.path.remove(str(RENDER_DIR))


@pytest.fixture
def workdir(render, tmp_path, monkeypatch):
    """Pin the per-render work dir so a hostile theme folder can be planted where rendercv
    looks for one. This is the seam `_make_workdir` documents."""
    d = tmp_path / "work"
    d.mkdir()
    monkeypatch.setattr(render, "_make_workdir", lambda: d)
    return d


CV = {
    "name": "Alex Rivera",
    "email": "alex.rivera@example.com",
    "sections": {"experience": [{"company": "Northwind Logistics", "position": "PM",
                                 "highlights": ["Owned the order-routing service"]}]},
}


def _plant_hostile_theme(workdir: pathlib.Path, name: str, canary: pathlib.Path):
    folder = workdir / name
    folder.mkdir(parents=True)
    # rendercv requires a *.j2.typ before it reaches the import — a proof-of-concept without
    # one bails early and reports "not vulnerable", which is how this gets missed.
    (folder / "main.j2.typ").write_text("")
    (folder / "__init__.py").write_text(
        f"import pathlib; pathlib.Path({str(canary)!r}).write_text('executed')\n"
    )


# --- HARDENING 1: theme-folder RCE, against the real validator ---------------------------------

def test_rendercv_itself_still_executes_a_theme_folders_init_py(render, tmp_path):
    """The vector, live. `validate_design()` treats an unknown theme as a folder next to the
    input file and `exec_module()`s its `__init__.py` DURING VALIDATION. The error it raises
    afterwards is not protection — the code has already run, which is what this asserts.

    If this test ever fails because the canary was NOT written, rendercv has been fixed
    upstream: check the version, then decide deliberately whether the allowlist stays. Do not
    delete it on the strength of one version.
    """
    from rendercv.schema.rendercv_model_builder import build_rendercv_dictionary_and_model

    work = tmp_path / "raw"
    work.mkdir()
    canary = tmp_path / "canary-raw"
    _plant_hostile_theme(work, "eviltheme", canary)

    with pytest.raises(Exception):
        build_rendercv_dictionary_and_model(
            render._dump_yaml({"cv": CV}),
            design_yaml_file=render._dump_yaml({"design": {"theme": "eviltheme"}}),
            input_file_path=work / "cv.yaml",
        )
    assert canary.read_text() == "executed", (
        "rendercv no longer executes a custom theme folder — re-derive HARDENING 1"
    )


def test_the_render_service_never_lets_the_folder_be_reached(render, workdir, tmp_path):
    canary = tmp_path / "canary"
    _plant_hostile_theme(workdir, "eviltheme", canary)

    with pytest.raises(render.ThemeNotAllowed):
        render.render(cv=CV, design={"theme": "eviltheme"})
    assert not canary.exists()


def test_a_built_in_name_still_beats_a_same_named_folder(render, workdir, tmp_path):
    """THE UNSTATED DEPENDENCY UNDER HARDENING 1, pinned so a version bump fails loudly.

    The allowlist stops names rendercv does not recognise. It does NOT stop an ALLOWLISTED name
    that also resolves as a folder: `theme: classic` with a hostile `./classic/` planted next
    to the input file passes the allowlist by construction. It is safe today only because
    rendercv 2.8 resolves its nine built-ins BEFORE it looks at the filesystem — the LIBRARY's
    behaviour, not the guard's, and nothing here was asserting it.

    A future rendercv that prefers a sibling folder, or that merges the two lookups, turns
    every allowlisted name into an execution primitive the moment an attacker can write next to
    the input file — which is what any attachment-upload feature eventually provides. If this
    goes red, the allowlist is no longer sufficient on its own and HARDENING 1 needs the second
    control (render in a directory the user cannot write to, or pass a resolved theme object).
    """
    canary = tmp_path / "canary-shadow"
    _plant_hostile_theme(workdir, "classic", canary)
    out = render.render(cv=CV, design={"theme": "classic"})
    assert out["pages"] >= 1, "the render did not complete, so this proves nothing"
    assert not canary.exists(), (
        "rendercv executed a folder that SHADOWS a built-in theme name — the allowlist no "
        "longer implies safety, because the name it allows is now the name it executes"
    )


def test_a_design_side_photo_is_still_refused_by_rendercvs_own_schema(render):
    # No `workdir` fixture: that pins ONE directory and `render()` rmtree's it in its
    # `finally`, so a second render in the same test compiles against a root that is no
    # longer there. This test renders three times and needs the real per-render dir.
    """THE UNSTATED DEPENDENCY UNDER HARDENING 2, same reasoning.

    `_strip_photo` scans the CV block and only the CV block. `design.photo` and
    `design.header.photo` are refused — but by rendercv's `extra=forbid` on the design models,
    not by anything in render.py. That is sufficient today and it is somebody else's decision:
    a rendercv that relaxes design validation (or grows a real `design.photo`) reopens the SSRF
    silently, on a path the guard never looks at.

    If this goes red, extend `_strip_photo` to the design block before shipping the bump.
    """
    # The MECHANISM, asserted directly: every built-in theme model forbids extra keys. This is
    # the line that would change in the version bump that reopens it.
    from rendercv.schema.models.design.built_in_design import ClassicTheme
    assert ClassicTheme.model_config.get("extra") == "forbid", (
        "rendercv's design models no longer forbid unknown keys — design.photo is now a key "
        "that reaches the renderer, and _strip_photo does not scan design"
    )

    # And the behaviour that mechanism produces.
    for design in ({"theme": "classic", "photo": "http://127.0.0.1:1/x"},
                   {"theme": "classic", "header": {"photo": "http://127.0.0.1:1/x"}}):
        with pytest.raises(Exception) as e:
            render.render(cv=CV, design=design)
        assert not isinstance(e.value, render.PhotoFieldMoved), (
            "reaching PhotoFieldMoved here would mean render.py caught it; it does not scan "
            "design, so this test would be asserting the wrong guard"
        )
    # Positive control: the same design without the extra key renders, so the refusals above
    # are about the key and not about the call.
    assert render.render(cv=CV, design={"theme": "classic"})["pages"] >= 1


def test_the_allowlist_is_exactly_the_libraries_built_in_set(render):
    from rendercv.schema.models.design.built_in_design import available_themes
    assert render.ALLOWED_THEMES == frozenset(available_themes)


def test_the_custom_theme_name_pattern_is_still_what_the_allowlist_assumes(render):
    """The allowlist is the boundary, but the reason it needs no traversal handling is that
    rendercv constrains a custom theme name to ^[a-z0-9]+$. If that ever loosens, a name like
    `../../etc` becomes reachable for anyone who drops the allowlist."""
    from rendercv.schema.models.design.design import custom_theme_name_pattern
    assert custom_theme_name_pattern.pattern == r"^[a-z0-9]+$"


# --- HARDENING 2: photo SSRF, against the real fetcher -----------------------------------------

@pytest.fixture
def stand_in_server():
    """A loopback HTTP server standing in for the metadata endpoint. The renderer's fetch is
    unauthenticated and unvalidated, so a loopback address proves the identical property with
    no packet leaving the machine."""
    hits: list[str] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            hits.append(self.path)
            body = b"\x89PNG\r\n\x1a\n" + b"0" * 64
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{srv.server_port}", hits
    finally:
        srv.shutdown()
        srv.server_close()


def test_rendercv_itself_still_fetches_a_photo_url(render, stand_in_server, tmp_path):
    """The vector, live: a URL in `cv.photo` becomes a server-side GET from inside the account.

    Same rule as the RCE twin — a failure here means the library changed, not that the strip
    is unnecessary.
    """
    from rendercv.renderer.templater.templater import render_full_template
    from rendercv.schema.rendercv_model_builder import build_rendercv_dictionary_and_model

    base, hits = stand_in_server
    url = f"{base}/latest/meta-data/iam/security-credentials/"
    work = tmp_path / "raw"
    work.mkdir()
    try:
        _, model = build_rendercv_dictionary_and_model(
            render._dump_yaml({"cv": dict(CV, photo=url)}),
            design_yaml_file=render._dump_yaml({"design": {"theme": "classic"}}),
            input_file_path=work / "cv.yaml",
        )
        render_full_template(model, "typst")
    except Exception:
        pass          # the render may still fail on the fetched bytes; the GET is the finding
    assert hits == ["/latest/meta-data/iam/security-credentials/"], (
        "rendercv no longer fetches cv.photo — re-derive HARDENING 2"
    )


def test_the_render_service_never_opens_that_socket(render, workdir, stand_in_server):
    base, hits = stand_in_server
    out = render.render(cv=dict(CV, photo=f"{base}/latest/meta-data/"), design={"theme": "classic"})
    assert hits == []
    assert out["warnings"] == ["cv.photo was removed: this renderer never fetches remote images."]
    assert out["pages"] >= 1          # and the document still rendered


# --- the per-theme one-page gate ---------------------------------------------------------------

def _reference() -> tuple[str, str]:
    return ((FIXTURES / "reference_cv.yaml").read_text(),
            (FIXTURES / "reference_design.yaml").read_text())


def test_every_theme_holds_the_reference_resume_on_one_page(render):
    """The gate. A theme the product offers that cannot fit a full one-page résumé is a
    shipping defect, and ThemeGateFailed names each one with its page count."""
    cv, design = _reference()
    out = render.gate_themes(cv, design)
    assert out["ok"] is True
    assert set(out["themes"]) == render.ALLOWED_THEMES
    assert all(v["pages"] == 1 for v in out["themes"].values()), out["themes"]


def test_the_gate_is_not_vacuous(render):
    """The counterexample, and the only thing that makes the test above mean anything: a
    document too long for one page must fail the gate for EVERY theme, by name. Without this,
    a gate that silently stopped counting pages would read exactly as green as a real pass.

    Six copies of the experience section, not two — the themes differ enormously in density
    (harvard still fits three copies on one page, which is why a two-theme spot check was not
    enough), and the counterexample has to be past the last one of them.
    """
    cv, design = _reference()
    padded = render._as_block(cv, "cv", "cv")
    # deepcopy per repeat, not `* 6`: repeating the same dict objects makes the YAML dumper
    # emit anchors and aliases, which rendercv rejects — the test would then "fail" on a
    # validation error and prove nothing about page counts.
    entries = padded["sections"]["experience"]
    padded["sections"]["experience"] = [copy.deepcopy(e) for _ in range(6) for e in entries]
    with pytest.raises(render.ThemeGateFailed) as e:
        render.gate_themes(padded, design)
    assert set(e.value.failures) == set(render.ALLOWED_THEMES)
    assert all(p > 1 for p in e.value.failures.values())


def test_the_reference_fixture_carries_no_real_person(render):
    """A fixture is committed and public. The owner's résumé is private user data and may never
    become one — this pins the invented identity so a future "just use the real one" edit is a
    red test rather than a leak."""
    cv_text, _ = _reference()
    cv = render._as_block(cv_text, "cv", "cv")
    assert cv["name"] == "Alex Rivera"
    assert cv["email"].endswith("@example.com")
    assert re.search(r"555-01\d\d", cv["phone"])          # the reserved fictional-number block
    assert "shaheen" not in cv_text.lower()


def test_the_engine_report_is_read_from_the_installed_distributions(render):
    assert render.ENGINE["rendercv"] == PINNED
    assert render.ENGINE["schema"] == render.SCHEMA_VERSION


def test_a_library_bug_on_a_caller_reachable_path_is_still_a_RenderError(render):
    """The fallthrough in `_mapped`, which the big sweep does NOT reach.

    A MINIMAL document is required: add a hostile key to the full reference CV and rendercv
    finds a structured validation error first, so `_mapped` takes its first branch and the
    fallthrough never runs. With only the required fields present, an all-digit key reaches
    rendercv's own error REPORTER, which raises `KeyError(5551234567)` — a library bug, on a
    path a résumé with `2024:` as a section name reaches. Returning it untouched put the key
    and a full traceback in the log group and spent an `Errors` datapoint.

    This test exists because the sweep passed with the fix mutated away: an enumeration that
    does not reach a branch cannot defend it, however many cases it runs.

    KILLED BY: `return exc` as the last line of `_mapped`.
    """
    minimal = {"name": "P", "email": "a@b.co"}
    for key in ("5551234567", "2024"):
        out = render.handler({"cv": {**minimal, key: "x"}}, None)   # must not raise
        error = out.get("error", {})
        assert error, f"a {key!r} key produced no error at all"
        assert key not in json.dumps(error), (
            f"the caller's key {key!r} reached the returned error: {error}"
        )
        # The class name is ours or the library's, and is the only thing that may survive.
        assert error.get("message", "").endswith("KeyError"), (
            f"expected the class name and nothing else, got {error.get('message')!r}"
        )
