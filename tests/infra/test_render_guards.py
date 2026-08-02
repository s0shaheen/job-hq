"""The résumé render service's two security boundaries, tested against a DOUBLE of rendercv
that still has both vulnerabilities.

WHY A DOUBLE, when tests/infra/test_render_live.py exercises the real library: `rendercv[full]
==2.8` needs Python >= 3.12 and pulls ~27 packages, and this repo's suite runs on 3.11 with
requirements.txt only. If these tests needed the real thing they would SKIP in CI — and a
security test that skips is a security test that does not exist. So the boundary is tested
here, always, and the live file's job is the different one of proving this double still
matches the library it stands in for.

THE DOUBLE IS THE ATTACK, NOT A MOCK OF IT. `_vulnerable_model_builder` reproduces rendercv
2.8's `validate_design()` line for line — unknown theme -> `input_file_path.parent / theme`
-> `spec.loader.exec_module()` of its `__init__.py` — and `_vulnerable_templater` reproduces
`download_photo_from_url()` -> `urlretrieve(cv.photo)`. Each is proven live by its own test
(`test_the_double_really_does_execute...`, `test_the_double_really_does_fetch...`) BEFORE the
guard is tested against it, which is what makes the guard tests non-vacuous: delete
`_checked_theme`'s raise and the canary test fails, delete `_strip_photo`'s pop and the fetch
test fails. Both mutations were run; see the PR body.

Nothing here touches the network. The SSRF double records the URL it was handed and returns;
the one test that proves a real socket is opened uses a loopback stand-in server it started
itself (test_render_live.py). No test in this file may ever be pointed at a real address.
"""
from __future__ import annotations

import importlib.util
import io
import json
import sys
import types
from pathlib import Path

import pytest
import yaml

RENDER_PY = Path(__file__).resolve().parents[2] / "infra" / "render" / "render.py"

#: What rendercv 2.8 ships. The double refuses these as "custom themes" exactly as the library
#: does, so the allowlist cross-check in render.py has something real to compare against.
BUILT_IN_THEMES = [
    "classic", "ember", "engineeringclassic", "engineeringresumes", "harvard",
    "ink", "moderncv", "opal", "sb2nov",
]

CV = {
    "name": "Alex Rivera",
    "email": "alex.rivera@example.com",
    "sections": {"experience": [{"company": "Northwind Logistics", "position": "PM"}]},
}


# --- the double -------------------------------------------------------------------------------

class Recorder:
    """Everything the doubles saw. The assertions are all "was this reached?" questions."""

    def __init__(self):
        self.photo_fetches: list[str] = []
        self.themes_built: list[str] = []
        self.compiles: list[dict] = []


def _vulnerable_model_builder(rec: Recorder, executed: list[Path]):
    """rendercv 2.8 `validate_design()`, reproduced.

    The order matters and is the library's: an unknown theme name is treated as a FOLDER next
    to the input file, and its `__init__.py` is executed DURING VALIDATION — before the error
    the library eventually raises. The `*.j2.typ` precondition is the library's too (verified
    against 2.8: without such a file it bails before the exec, which is why an incomplete
    proof-of-concept reports "safe").
    """
    def build(cv_yaml, design_yaml_file=None, settings_yaml_file=None, input_file_path=None):
        design = (yaml.safe_load(design_yaml_file) or {}).get("design", {})
        theme = str(design.get("theme", "classic"))
        rec.themes_built.append(theme)
        if theme not in BUILT_IN_THEMES:
            folder = Path(input_file_path).parent / theme
            init = folder / "__init__.py"
            if folder.is_dir() and any(folder.rglob("*.j2.typ")) and init.exists():
                spec = importlib.util.spec_from_file_location("theme", init)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)          # <-- arbitrary code, attacker's file
                executed.append(init)
            raise RuntimeError(f"custom theme {theme!r} is not usable")
        cv = (yaml.safe_load(cv_yaml) or {}).get("cv", {})
        return {}, {"cv": cv, "design": design}
    return build


def _vulnerable_templater(rec: Recorder):
    """rendercv 2.8 `render_full_template()` -> `download_photo_from_url()`, reproduced.

    The library calls `urllib.request.urlretrieve(url, dest)` with no host allowlist, no
    timeout and no size cap, so a `cv.photo` of `http://169.254.169.254/...` is a server-side
    request to link-local from inside the account. The double records instead of fetching:
    the point under test is whether this function is ever REACHED with a URL in hand.
    """
    def templater(model, fmt):
        photo = (model.get("cv") or {}).get("photo")
        if isinstance(photo, str) and photo.startswith(("http://", "https://")):
            rec.photo_fetches.append(photo)              # <-- the SSRF, at the moment it fires
        return "#set page(paper: \"us-letter\")\nrendered"
    return templater


class _FakeCompiler:
    """`state` is read per call, not per construction: the compiler is built once at import
    (as the real one is) but a test needs to change the page count afterwards."""

    def __init__(self, rec: Recorder, state: dict):
        self._rec, self._state = rec, state

    def compile(self, input=None, format=None, root=None, **kw):
        self._rec.compiles.append({"format": format, "root": root, **kw})
        pages = self._state["pages"]
        if format == "png":
            return [b"png"] * pages
        return b"%PDF-fake\n" + str(pages).encode()


def _fake_pypdf():
    mod = types.ModuleType("pypdf")

    class PdfReader:
        def __init__(self, stream):
            raw = stream.getvalue() if isinstance(stream, io.BytesIO) else stream
            n = int(raw.rsplit(b"\n", 1)[-1] or 1)
            page = types.SimpleNamespace(extract_text=lambda: "Alex Rivera")
            self.pages = [page] * n

    mod.PdfReader = PdfReader
    return mod


def _fake_ruamel():
    """ruamel is what rendercv pins and what the render image installs; the repo suite has
    PyYAML. Both are safe loaders and the guards under test operate on the loaded dict, so the
    substitution changes nothing they can observe."""
    ruamel = types.ModuleType("ruamel")
    yaml_mod = types.ModuleType("ruamel.yaml")

    class YAML:
        def __init__(self, typ=None, pure=False):
            self.default_flow_style = False

        def load(self, text):
            return yaml.safe_load(text)

        def dump(self, data, stream):
            yaml.safe_dump(data, stream, default_flow_style=False, sort_keys=False)

    yaml_mod.YAML = YAML
    ruamel.yaml = yaml_mod
    return ruamel, yaml_mod


@pytest.fixture
def render_mod(monkeypatch, tmp_path):
    """`infra/render/render.py` loaded by path (infra/render is not a package — the idiom
    tests/infra/test_lambda_handler.py uses), on top of the doubles."""
    rec = Recorder()
    executed: list[Path] = []
    state = {"pages": 1}

    rendercv = types.ModuleType("rendercv")
    templater_mod = types.ModuleType("rendercv.renderer.templater.templater")
    templater_mod.render_full_template = _vulnerable_templater(rec)
    builtin_mod = types.ModuleType("rendercv.schema.models.design.built_in_design")
    builtin_mod.available_themes = list(BUILT_IN_THEMES)
    builder_mod = types.ModuleType("rendercv.schema.rendercv_model_builder")
    builder_mod.build_rendercv_dictionary_and_model = _vulnerable_model_builder(rec, executed)

    typst_mod = types.ModuleType("typst")
    typst_mod.Compiler = lambda **kw: _FakeCompiler(rec, state)
    fonts_mod = types.ModuleType("rendercv_fonts")
    fonts_mod.__file__ = str(tmp_path / "fonts" / "__init__.py")
    ruamel, ruamel_yaml = _fake_ruamel()

    for name, mod in {
        "rendercv": rendercv,
        "rendercv.renderer": types.ModuleType("rendercv.renderer"),
        "rendercv.renderer.templater": types.ModuleType("rendercv.renderer.templater"),
        "rendercv.renderer.templater.templater": templater_mod,
        "rendercv.schema": types.ModuleType("rendercv.schema"),
        "rendercv.schema.models": types.ModuleType("rendercv.schema.models"),
        "rendercv.schema.models.design": types.ModuleType("rendercv.schema.models.design"),
        "rendercv.schema.models.design.built_in_design": builtin_mod,
        "rendercv.schema.rendercv_model_builder": builder_mod,
        "typst": typst_mod,
        "rendercv_fonts": fonts_mod,
        "ruamel": ruamel,
        "ruamel.yaml": ruamel_yaml,
        "pypdf": _fake_pypdf(),
    }.items():
        monkeypatch.setitem(sys.modules, name, mod)

    import importlib.metadata as md
    monkeypatch.setattr(md, "version", lambda name: "0-double")

    spec = importlib.util.spec_from_file_location("hq_render_under_test", RENDER_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    # Every render works inside a directory this test owns, so a planted theme folder lands
    # exactly where rendercv would look for one and nothing is written to the real /tmp/render.
    workdirs: list[Path] = []

    def _workdir():
        d = tmp_path / f"work{len(workdirs)}"
        d.mkdir()
        workdirs.append(d)
        return d

    monkeypatch.setattr(mod, "_make_workdir", _workdir)
    mod._test = types.SimpleNamespace(
        rec=rec, executed=executed, workdirs=workdirs, state=state, tmp=tmp_path
    )
    return mod


def _plant_hostile_theme(workdir: Path, name: str, canary: Path) -> Path:
    """The attacker's half: a theme folder, next to the input file, whose import writes a file.

    A file write stands in for whatever the payload would really do (read the Lambda's env,
    call STS, exfiltrate the document being rendered) — it is the observable that says CODE
    RAN. `*.j2.typ` is present because rendercv requires it before it reaches the import.
    """
    folder = workdir / name
    folder.mkdir(parents=True)
    (folder / "main.j2.typ").write_text("")
    (folder / "__init__.py").write_text(
        f"import pathlib; pathlib.Path({str(canary)!r}).write_text('executed')\n"
    )
    return folder


# --- the double is real ------------------------------------------------------------------------

def test_the_double_really_does_execute_a_theme_folder(render_mod, tmp_path):
    """Non-vacuity, half one: handed an unknown theme, the stand-in for rendercv EXECUTES the
    attacker's __init__.py. If this ever stops being true the guard tests below prove nothing
    and must be re-derived against the library."""
    work = tmp_path / "raw"
    work.mkdir()
    canary = tmp_path / "canary-raw"
    _plant_hostile_theme(work, "eviltheme", canary)

    build = sys.modules["rendercv.schema.rendercv_model_builder"].build_rendercv_dictionary_and_model
    with pytest.raises(RuntimeError):
        build(
            yaml.safe_dump({"cv": CV}),
            design_yaml_file=yaml.safe_dump({"design": {"theme": "eviltheme"}}),
            input_file_path=work / "cv.yaml",
        )
    assert canary.read_text() == "executed", "the double is no longer vulnerable — see docstring"


def test_the_double_really_does_fetch_a_photo_url(render_mod):
    """Non-vacuity, half two: the templater reached with a `photo` URL performs the fetch."""
    templater = sys.modules["rendercv.renderer.templater.templater"].render_full_template
    templater({"cv": dict(CV, photo="http://169.254.169.254/latest/meta-data/")}, "typst")
    assert render_mod._test.rec.photo_fetches == ["http://169.254.169.254/latest/meta-data/"]


# --- HARDENING 1: the theme allowlist ----------------------------------------------------------

def test_a_hostile_theme_folder_is_never_reached(render_mod, tmp_path):
    """THE RCE VECTOR, end to end. The folder is planted where the renderer will put its input
    file, so the only thing standing between the request and `exec_module` is the allowlist."""
    canary = tmp_path / "canary"
    # The workdir the next render will use, planted before the call — this is what an
    # attachment-upload feature that writes user files next to the input hands an attacker.
    work = tmp_path / "work0"
    work.mkdir()
    _plant_hostile_theme(work, "eviltheme", canary)
    render_mod._make_workdir = lambda: work

    with pytest.raises(render_mod.ThemeNotAllowed):
        render_mod.render(cv=CV, design={"theme": "eviltheme"})

    assert not canary.exists(), "the theme folder's __init__.py executed — HARDENING 1 is gone"
    assert render_mod._test.executed == []
    assert render_mod._test.rec.themes_built == [], "the model builder was reached at all"


def test_a_probe_theme_goes_through_the_same_gate(render_mod, tmp_path):
    """probe_themes are RENDERED, so an unchecked probe list is the same vector by another
    field name. It must fail before any render starts, not on the probe's own turn."""
    with pytest.raises(render_mod.ThemeNotAllowed):
        render_mod.render(cv=CV, design={"theme": "classic"}, probe_themes=["eviltheme"])
    assert render_mod._test.rec.compiles == [], "the main document rendered before the probe was checked"


def test_gate_themes_refuses_a_theme_outside_the_allowlist(render_mod):
    with pytest.raises(render_mod.ThemeNotAllowed):
        render_mod.gate_themes(CV, themes=["classic", "eviltheme"])


@pytest.mark.parametrize("theme", ["../../etc", "Classic", "classic/../evil", " classic", 7, 0,
                                   None, ""])
def test_only_exact_built_in_names_pass(render_mod, theme):
    """Path traversal, case tricks and non-strings all land in the same place: not an exact
    member of the frozen set. Falsy values (`None`, `""`, `0`) are the exception — they mean
    "no theme given" and take the default, which is itself allowlisted. That is safe for the
    same reason the rest is: nothing falsy can name a folder, and the value that ends up in
    the design block is `DEFAULT_THEME`, not the input."""
    if not theme:
        assert render_mod._checked_theme({}) == render_mod.DEFAULT_THEME
        return
    with pytest.raises(render_mod.ThemeNotAllowed):
        render_mod._checked_theme({"theme": theme})


def test_every_allowlisted_theme_is_a_real_built_in(render_mod):
    assert render_mod.ALLOWED_THEMES == frozenset(BUILT_IN_THEMES)
    assert render_mod.DEFAULT_THEME in render_mod.ALLOWED_THEMES


def test_the_allowlist_is_never_a_path_or_a_pattern(render_mod):
    """A regex or a prefix match is how an allowlist becomes a folder loader again."""
    import re
    for name in render_mod.ALLOWED_THEMES:
        assert re.fullmatch(r"[a-z0-9]+", name), name


# --- HARDENING 2: the photo strip --------------------------------------------------------------

def test_a_photo_url_never_reaches_the_fetch(render_mod):
    """THE SSRF VECTOR, end to end: the classic link-local metadata address as `cv.photo`."""
    out = render_mod.render(
        cv=dict(CV, photo="http://169.254.169.254/latest/meta-data/iam/security-credentials/"),
        design={"theme": "classic"},
    )
    assert render_mod._test.rec.photo_fetches == [], "the renderer fetched a user-supplied URL"
    assert out["warnings"] == ["cv.photo was removed: this renderer never fetches remote images."]


@pytest.mark.parametrize("url", [
    "http://169.254.169.254/latest/meta-data/",      # EC2 / link-local
    "http://[fd00:ec2::254]/latest/meta-data/",      # its IPv6 twin
    "http://127.0.0.1:8000/admin",                   # loopback
    "http://10.0.0.5/internal",                      # RFC1918
    "http://192.168.1.1/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "https://example.com/headshot.png",              # even a benign one: there is no photo feature
    "/etc/passwd",                                   # the ExistingPathRelativeToInput arm
])
def test_no_photo_value_of_any_kind_survives(render_mod, url):
    render_mod.render(cv=dict(CV, photo=url), design={"theme": "classic"})
    assert render_mod._test.rec.photo_fetches == []


def test_a_photo_key_that_moved_fails_loud_instead_of_silently_reopening_the_hole(render_mod):
    """Defense in depth: the strip covers `cv.photo`. If a future schema nests it, the render
    must STOP — a strip that quietly stopped covering the field is the vulnerability back."""
    with pytest.raises(render_mod.PhotoFieldMoved) as e:
        render_mod.render(cv={**CV, "header": {"photo": "http://169.254.169.254/"}},
                          design={"theme": "classic"})
    # The SHAPE, not the path: `header` happens to be a rendercv field, but the same code
    # path reports `cv.sections.<the author's own section title>.[0].photo`, and a key the
    # author chose is caller-supplied text like any other.
    assert "<key>.<key>" in str(e.value)
    assert "photo" in str(e.value), "the diagnostic must still say WHAT was found"
    assert e.value.detail["path"] == ["header", "photo"], (
        "positive control: the real path must still reach the CALLER, or the redaction has "
        "thrown the diagnostic away rather than moved it"
    )
    assert render_mod._test.rec.photo_fetches == []


def test_a_document_with_no_photo_warns_about_nothing(render_mod):
    assert render_mod.render(cv=CV, design={"theme": "classic"})["warnings"] == []


# --- the per-theme one-page gate ---------------------------------------------------------------

def test_gate_themes_raises_and_names_every_theme_over_target(render_mod):
    render_mod._test.state["pages"] = 2
    with pytest.raises(render_mod.ThemeGateFailed) as e:
        render_mod.gate_themes(CV, themes=["classic", "harvard"])
    assert e.value.failures == {"classic": 2, "harvard": 2}
    assert "classic=2" in str(e.value) and "harvard=2" in str(e.value)


def test_gate_themes_covers_the_whole_allowlist_by_default(render_mod):
    out = render_mod.gate_themes(CV)
    assert set(out["themes"]) == render_mod.ALLOWED_THEMES
    assert out["ok"] is True


def test_gate_themes_can_report_instead_of_raising_but_never_lies_about_ok(render_mod):
    render_mod._test.state["pages"] = 3
    out = render_mod.gate_themes(CV, themes=["classic"], strict=False)
    assert out["ok"] is False and out["themes"]["classic"] == {"pages": 3, "ok": False}


def test_gate_themes_refuses_a_target_that_would_pass_everything(render_mod):
    for bad in (0, -1):
        with pytest.raises(render_mod.RenderError):
            render_mod.gate_themes(CV, themes=["classic"], page_target=bad)


def test_the_photo_strip_applies_to_the_gate_too(render_mod):
    render_mod.gate_themes(dict(CV, photo="http://169.254.169.254/"), themes=["classic"])
    assert render_mod._test.rec.photo_fetches == []


# --- the surrounding contract ------------------------------------------------------------------

def test_each_render_gets_its_own_workdir_and_leaves_nothing_behind(render_mod):
    """The typst sandbox root is a directory: a shared one would let render N+1 read render N's
    document off a warm /tmp."""
    render_mod.render(cv=CV, design={"theme": "classic"})
    render_mod.render(cv=CV, design={"theme": "classic"})
    a, b = render_mod._test.workdirs
    assert a != b
    assert not a.exists() and not b.exists()


def test_the_workdir_is_cleaned_up_even_when_the_render_raises(render_mod):
    """A render that dies mid-compile must still take the document with it."""
    def boom(*a, **k):
        raise RuntimeError("typst died")
    render_mod._compile = boom
    with pytest.raises(RuntimeError):
        render_mod.render(cv=CV, design={"theme": "classic"})
    assert all(not d.exists() for d in render_mod._test.workdirs)


def test_the_compiler_root_is_the_per_render_workdir(render_mod):
    render_mod.render(cv=CV, design={"theme": "classic"})
    roots = {c["root"] for c in render_mod._test.rec.compiles}
    assert roots == {str(render_mod._test.workdirs[0])}


def test_an_unknown_event_key_is_refused_rather_than_ignored(render_mod):
    """Refused, and REPORTED rather than raised — see `handler`. The stray key is named in
    `detail`, which goes to the caller, and not in the message, which goes to CloudWatch: the
    keys are caller-supplied text like everything else in the event."""
    out = render_mod.handler({"cv": CV, "output_folder": "/etc"}, None)
    assert out["ok"] is False
    assert out["error"]["detail"]["unknown_keys"] == ["output_folder"]
    assert "output_folder" not in out["error"]["message"]
    # The counterexample the old assertion was really making: a stray key is not IGNORED.
    assert "pages" not in out


def test_an_unknown_format_is_refused(render_mod):
    with pytest.raises(render_mod.RenderError):
        render_mod.render(cv=CV, formats=["pdf", "exe"])


def test_the_default_page_target_is_the_strict_one(render_mod):
    """A caller that forgets the field must get the honest verdict, not a silent pass."""
    assert render_mod.DEFAULT_PAGE_TARGET == 1
    render_mod._test.state["pages"] = 2
    assert render_mod.handler({"cv": CV}, None)["gate"] == {
        "page_target": 1, "pages": 2, "ok": False
    }


# ---------------------------------------------------------------- HARDENING 4: the log

#: A string that appears nowhere in this repo and is not a plausible fragment of anything else,
#: planted in the document so a substring search over an exception is a real search.
SECRET = "Q7-private-resume-content-do-not-log-Q7"


def _traceback_text(exc: BaseException) -> str:
    """Everything Lambda serialises when a handler raises: the message, the repr, the args and
    the chained causes. Lambda writes `errorType`/`errorMessage`/`stackTrace` to the function's
    log group, so this is the string that reaches CloudWatch."""
    import traceback
    return "\n".join([
        str(exc), repr(exc), repr(getattr(exc, "args", ())),
        "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
    ])


def test_a_validation_failure_never_puts_the_document_in_the_exception(render_mod):
    """BLOCKER-A. `logs:PutLogEvents` is the ONLY capability the render role holds, which makes
    a log the one place a compromise of this function can put anything — and the guards were
    putting the user's résumé there themselves.

    `_mapped` copied rendercv's `yaml_source` — the offending snippet of the user's document —
    into the error list, and `RenderValidationError` serialised that list into the exception
    MESSAGE, which Lambda writes to the log group verbatim. CLAUDE.md: never expose private
    user content in logs. 14-day retention does not make it not-a-log.

    The position is kept, because a form needs to know WHERE; the value is not, because nothing
    downstream of the caller needs it and the caller already has the document.
    """
    class _Err:
        schema_location = ("cv", "sections", "experience", 0, "start_date")
        yaml_location = ((12, 5), (12, 22))
        yaml_source = f"    start_date: {SECRET}"
        message = "This is not a valid date"

    class _Rejected(Exception):
        validation_errors = [_Err()]

    mapped = render_mod._mapped(_Rejected())
    assert isinstance(mapped, render_mod.RenderValidationError)
    assert SECRET not in _traceback_text(mapped), (
        "the user's document reached the exception message — and therefore CloudWatch"
    )
    # Positive control: the diagnostic that is NOT content survived, so this is not a test that
    # would pass against an exception carrying nothing at all.
    #
    # The message keeps the path's SHAPE — depth and list position — and the readable path
    # moved to `detail`, where every other caller-supplied value already lives. A rendercv
    # `schema_location` runs straight through the author's own section titles
    # (`cv.sections.<title>.…`), so the readable version published a key the AUTHOR chose: at
    # a stealth employer that name is itself the private fact, and a résumé pasted into a key
    # name was the whole résumé.
    assert "<key>.<key>.<key>.0.<key>" in _traceback_text(mapped), (
        "the path shape was thrown away too — depth and list position carry no content"
    )
    assert mapped.detail["errors"][0]["schema_location"] == [
        "cv", "sections", "experience", 0, "start_date"
    ], "positive control: the real path must still reach the CALLER"


def test_unparseable_yaml_is_reported_by_position_not_by_quoting_it(render_mod):
    """ruamel's `str(e)` includes the offending SOURCE LINE, and `_load_yaml` interpolated it
    straight into a message that Lambda logs."""
    with pytest.raises(render_mod.RenderError) as e:
        render_mod._load_yaml(f"cv:\n  name: [{SECRET}\n", "cv")
    assert SECRET not in _traceback_text(e.value), "ruamel quoted the document into the message"
    assert "cv" in str(e.value), "positive control: the message no longer says what failed"


def test_the_handler_returns_user_errors_instead_of_raising_them(render_mod):
    """The structural half of the fix, and the reason the `Errors` alarm can be trusted.

    A raised exception is a log line AND an `AWS/Lambda Errors` datapoint — indistinguishable
    from an OOM or a timeout, so one malformed résumé pages ntfy and the alarm gets muted. A
    user's typo is a RESULT, returned to the synchronous caller that is waiting for it.
    """
    out = render_mod.handler({"cv": CV, "design": {"theme": "../../etc"}}, None)
    assert out["ok"] is False and out["error"]["type"] == "ThemeNotAllowed", out
    assert "detail" in out["error"]
    # Positive control: a good document is still a result, and still says so.
    ok = render_mod.handler({"cv": CV}, None)
    assert ok["ok"] is True and "pages" in ok


def test_a_bug_in_the_renderer_still_raises_so_the_alarm_still_means_something(render_mod):
    """The counterexample for the test above. If `handler` swallowed EVERYTHING, the Errors
    alarm would go permanently silent and an OOM would look like a bad résumé."""
    def boom(*a, **kw):
        raise MemoryError("out of memory")
    render_mod._compile = boom
    with pytest.raises(MemoryError):
        render_mod.handler({"cv": CV}, None)


#: One hostile value per TYPE the invoke boundary can deliver. JSON gives strings, numbers,
#: booleans, null, objects and arrays; a huge int and a negative one are there because the two
#: numeric fields used to take `int(...)` with no bounds at all, and every string carries the
#: canary so a leak is unambiguous rather than inferred.
HOSTILE_VALUES = [
    SECRET,
    f"{SECRET}\n{SECRET}" * 8,          # multi-line, ~600 chars — the ValueError payload size
    {"nested": {"deeper": [SECRET]}},
    [SECRET, SECRET],
    10 ** 9,
    -1,
    0,
    1.5,
    True,
    None,
]


def test_the_path_redaction_keeps_indices_and_drops_key_names(render_mod):
    """`_redacted_path` decides by TYPE, because the spellings overlap.

    A list position arrives as a real `int` and a mapping key as a `str`. Matching on
    `str(p)` instead meant an all-digit KEY — `2024:` as a section name, a phone number
    pasted as a key — matched the index pattern and was emitted VERBATIM, which is caller
    text in the one function whose whole job is removing it.

    KILLED BY: restoring the `\d+` alternative, i.e. deciding by spelling again.
    """
    redact = render_mod._redacted_path

    # A real list index is a count the caller only chose the magnitude of: it stays.
    assert redact(["cv", "sections", "work", 0, "company"]) == "<key>.<key>.<key>.0.<key>"
    assert redact(["cv", "[3]", "x"]) == "<key>.[3].<key>"

    # An all-digit STRING is a key the caller wrote. It goes.
    assert redact(["cv", "sections", "2024"]) == "<key>.<key>.<key>"
    assert redact(["cv", "5551234567"]) == "<key>.<key>"
    assert redact(["cv", "MY_STEALTH_EMPLOYER"]) == "<key>.<key>"

    # A bool is an int in Python and is not an index.
    assert redact(["cv", True]) == "<key>.<key>"

    assert redact([]) == "<document>"


def test_no_render_error_carries_document_text_in_its_message(render_mod):
    """The rule, driven over the module's DECLARED failure surface rather than over a curated
    list of attempts.

    The previous version of this test said it asserted the rule "over every failure this module
    can be made to produce" and was six hand-picked calls. Review found the two it did not
    reach — `page_target` and `png_dpi`, coerced with a bare `int()` outside every guard, where
    a non-numeric value raised `ValueError` (not a `RenderError`, so `handler` did not catch it)
    and CPython embeds the caller's string verbatim: roughly 200 characters of the document into
    CloudWatch, plus an `AWS/Lambda Errors` datapoint for a malformed request. A hand-picked
    list cannot find its own omissions.

    So the surface is ENUMERATED instead:

      * every key in `render_mod.EVENT_KEYS` — the module's own statement of what a caller may
        send — crossed with one hostile value per JSON type;
      * both other public entry points, `render()` and `gate_themes()`, driven the same way;
      * an unknown event key whose NAME is the canary, since key names are caller text too.

    A field added to `EVENT_KEYS` next month is covered on the day it is added.

    THREE properties, and the second and third are what the old version was missing:

      1. no canary in any message, repr, args tuple or chained traceback — the four things
         Lambda serialises;
      2. everything `render()` and `gate_themes()` raise is a `RenderError`, which is what makes
         `handler`'s `except RenderError` a complete boundary rather than a mostly-complete one;
      3. `handler` never raises for ANY of it — a malformed request is a returned result, so it
         is not a log line and not an `Errors` datapoint.
    """
    marker_cv = {**CV, "name": SECRET, "email": f"{SECRET}@example.com"}
    fields = sorted(render_mod.EVENT_KEYS)
    assert len(fields) >= 7, f"EVENT_KEYS shrank — the enumeration would cover less: {fields}"

    leaked: list[str] = []
    escaped: list[str] = []
    raised_by_handler: list[str] = []
    refusals = 0

    def check(label, call):
        nonlocal refusals
        try:
            call()
        except render_mod.RenderError as exc:
            refusals += 1
            if SECRET in _traceback_text(exc):
                leaked.append(label)
        except Exception as exc:            # noqa: BLE001 — an escape is itself the finding
            escaped.append(f"{label}: {type(exc).__name__}")
            if SECRET in _traceback_text(exc):
                leaked.append(label)

    for field in fields:
        for n, value in enumerate(HOSTILE_VALUES):
            event = {"cv": marker_cv, field: value}
            # 1+2. the library entry point: it may refuse, and only as a RenderError.
            check(f"render[{field}={n}]", lambda e=event: render_mod.render(**e))
            # 3. the Lambda entry point: it may not raise at all.
            try:
                out = render_mod.handler(dict(event), None)
            except Exception as exc:        # noqa: BLE001
                raised_by_handler.append(f"handler[{field}={n}]: {type(exc).__name__}")
                if SECRET in _traceback_text(exc):
                    leaked.append(f"handler[{field}={n}]")
                continue
            if SECRET in json.dumps(out.get("error", {}).get("message", "")):
                leaked.append(f"handler[{field}={n}] message")

    # gate_themes: same treatment, its own parameter names.
    for n, value in enumerate(HOSTILE_VALUES):
        check(f"gate_themes[themes={n}]",
              lambda v=value: render_mod.gate_themes(cv=marker_cv, themes=v))
        check(f"gate_themes[page_target={n}]",
              lambda v=value: render_mod.gate_themes(cv=marker_cv, themes=["classic"],
                                                     page_target=v))
        check(f"gate_themes[design={n}]",
              lambda v=value: render_mod.gate_themes(cv=marker_cv, design=v))

    # An unknown event key whose NAME is the canary.
    out = render_mod.handler({"cv": marker_cv, SECRET: 1}, None)
    if SECRET in str(out.get("error", {}).get("message", "")):
        leaked.append("handler[unknown key name]")

    # DOCUMENT KEY NAMES, not just event values. The sweep above varies what a caller puts
    # IN a known field and never what they NAME a field inside the document, which is a
    # different code path: key names reach rendercv's own error REPORTER. An all-digit key
    # (`2024:` as a section name, a phone number pasted as a key) raised a bare KeyError
    # straight through `handler` — full traceback and the key itself into the log group —
    # and the redaction's `\d+` alternative then emitted an all-digit key verbatim. Both
    # were live until 2026-08-02.
    hostile_keys = [SECRET, "2024", "5551234567", "0", "photo", "  ", "a" * 400]
    for n, key in enumerate(hostile_keys):
        for label, doc in (
            (f"docKey[top={n}]", {**marker_cv, key: "x"}),
            (f"docKey[nested={n}]", {**marker_cv, "sections": {key: [{"name": "x"}]}}),
        ):
            check(label, lambda d=doc: render_mod.render(cv=d))
            try:
                out = render_mod.handler({"cv": doc}, None)
            except Exception as exc:        # noqa: BLE001
                raised_by_handler.append(f"handler[{label}]: {type(exc).__name__}")
                if SECRET in _traceback_text(exc):
                    leaked.append(f"handler[{label}]")
                continue
            if SECRET in json.dumps(out.get("error", {})):
                leaked.append(f"handler[{label}] error")

    # Deep nesting: a RecursionError is still an escape, and it is caller-reachable.
    deep: dict = {"name": "x"}
    for _ in range(3000):
        deep = {"k": deep}
    check("deeply nested document", lambda: render_mod.render(cv={**marker_cv, "sections": deep}))
    try:
        render_mod.handler({"cv": {**marker_cv, "sections": deep}}, None)
    except Exception as exc:                # noqa: BLE001
        raised_by_handler.append(f"handler[deep nesting]: {type(exc).__name__}")

    assert leaked == [], f"document text reached an exception message via: {leaked}"
    assert escaped == [], (
        "render()/gate_themes() raised something that is NOT a RenderError, so handler's "
        f"`except RenderError` does not cover it and Lambda logs it: {escaped}"
    )
    assert raised_by_handler == [], (
        "handler raised instead of returning — a log line AND an AWS/Lambda Errors datapoint "
        f"for a malformed request: {raised_by_handler}"
    )
    # Non-vacuity: an enumeration where nothing was ever refused proves nothing at all.
    assert refusals >= 40, f"only {refusals} of the hostile values were refused — is the sweep reaching the guards?"


def test_the_two_numeric_arguments_are_refused_as_render_errors_not_value_errors(render_mod):
    """A-residual-1, named on its own so the regression has a test with its name on it.

    `page_target = int(page_target)` / `png_dpi = int(png_dpi)` sat outside every guard. The
    exact production consequence, reproduced before the fix:

        ValueError: invalid literal for int() with base 10: '<~200 chars of the caller's text>'

    `ValueError` is not a `RenderError`, so `handler` did not catch it; Lambda serialised it
    into the log group and incremented `AWS/Lambda Errors`. Both faults, one line each.

    KILLED BY: replacing either `_int_arg(...)` call with `int(...)` — this test then sees a
    ValueError and both assertions below fail.
    """
    for field in ("page_target", "png_dpi"):
        with pytest.raises(render_mod.RenderError) as e:
            render_mod.render(cv=CV, **{field: SECRET})
        assert SECRET not in _traceback_text(e.value)
        assert field in str(e.value), "the diagnostic must still name WHICH argument"
        assert e.value.detail["value"] == SECRET, (
            "positive control: the rejected value must still reach the caller in detail"
        )
        # And through the Lambda boundary it is a RESULT, not an exception.
        out = render_mod.handler({"cv": CV, field: SECRET}, None)
        assert out["ok"] is False and SECRET not in out["error"]["message"]

    # The bounds are real, not decorative: an unbounded png_dpi is an OOM inside a 1024 MB
    # function, which is the one failure the Errors alarm exists to catch.
    for field, value in (("png_dpi", 10 ** 9), ("page_target", 10 ** 9)):
        assert render_mod.handler({"cv": CV, field: value}, None)["ok"] is False

