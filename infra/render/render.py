"""The HQ resume render service — a pure function of two YAML documents.

    {"cv": ..., "design": ...}  ->  {"pages": 1, "pdf_b64": "...", ...}

It holds NO secrets, opens NO sockets, and makes NO AWS API calls. Its IAM role is
CloudWatch Logs and nothing else (infra/terraform/render.tf), so the worst a hostile
document can reach from in here is an empty account. That is the whole reason this is a
second function instead of another `JOBS` entry in the bots image: the bots Lambda can read
every `/job-hq/*` SecureString and write the backup bucket, and it runs one of nine
scheduled chains — putting a renderer for USER-SUPPLIED documents in that blast radius
would hand an attacker-authored resume the same credentials the sweep uses.

WHY IT DOES NOT PUSH ntfy: this function is invoked SYNCHRONOUSLY by a webapp server action.
Its report goes to its caller — an exception here surfaces to the person who typed the
document that caused it, which is where a validation error belongs. The second layer is the
CloudWatch `Errors` alarm in alerts.tf (SNS -> the same stdlib alerter the bots use), which
catches what in-process code cannot report: a timeout, an OOM kill, a broken image.

THE PIPELINE (all in memory — nothing but the throwaway work dir touches the filesystem):

    build_rendercv_dictionary_and_model(cv_yaml, design_yaml_file=..., input_file_path=...)
    -> render_full_template(model, "typst")   -> a Typst source STRING
    -> COMPILER.compile(input=..., format=...) -> PDF bytes / PNG bytes
    -> pypdf                                   -> page count + extracted text

NEVER CALL THE RENDERCV CLI (`rendercv.cli`, `run_rendercv`) FROM HERE. Two reasons, both
verified against 2.8: its error handler CATCHES exceptions and PRINTS them, so a failed
render returns success with no artifact; and its typer callback runs a PyPI version check
with TLS verification disabled. This module imports the library and only the library.
"""
from __future__ import annotations

import base64
import importlib.metadata
import io
import json
import pathlib
import re
import shutil
import uuid

import pypdf
import rendercv_fonts
import typst
from rendercv.renderer.templater.templater import render_full_template
from rendercv.schema.models.design.built_in_design import available_themes as _AVAILABLE_THEMES
from rendercv.schema.rendercv_model_builder import build_rendercv_dictionary_and_model
from ruamel.yaml import YAML

#: Bumped when the shape of the returned dict changes. The caller pins on it.
SCHEMA_VERSION = 1

# --- HARDENING 1: RCE — the theme allowlist ---------------------------------------------------
# `validate_design()` (rendercv/schema/models/design/design.py) treats a theme name it does not
# recognise as a FOLDER — `input_file_path.parent / theme`, falling back to `Path.cwd()` — and
# `spec.loader.exec_module()`s that folder's `__init__.py` DURING VALIDATION. Proven, not
# theoretical: a canary file was written before validation then raised. The error rendercv
# raises afterwards is NOT protection; the code already ran. The theme name itself is
# constrained to ^[a-z0-9]+$ so there is no path traversal, which means exploitation needs an
# attacker-placed folder next to the input file — exactly what any attachment-upload feature
# eventually provides. So: a hardcoded allowlist, checked BEFORE the model is built, and never
# a path. Anything else raises ThemeNotAllowed.
ALLOWED_THEMES = frozenset({
    "classic",
    "ember",
    "engineeringclassic",
    "engineeringresumes",
    "harvard",
    "ink",
    "moderncv",
    "opal",
    "sb2nov",
})
DEFAULT_THEME = "classic"

# Cross-check against the installed library at import. A version bump that ADDS a theme would
# otherwise silently make this list wrong in the safe direction (a real theme rejected) and a
# bump that RENAMES one wrong in the unsafe direction (a name that now resolves as a folder).
# Either way it is a loud init failure, not a surprise at request time.
if frozenset(_AVAILABLE_THEMES) != ALLOWED_THEMES:
    raise RuntimeError(
        "rendercv's built-in themes have drifted from the allowlist: "
        f"installed={sorted(_AVAILABLE_THEMES)} allowlist={sorted(ALLOWED_THEMES)}. "
        "Update ALLOWED_THEMES deliberately — this list is a security boundary."
    )

FORMATS = frozenset({"pdf", "png", "typst"})
EVENT_KEYS = frozenset({
    "cv", "design", "formats", "png_dpi", "probe_themes", "page_target", "ats_tokens",
})
DEFAULT_PNG_DPI = 144
#: Default page target. 1 is the product default (docs/DECISIONS D5); 0 disables the check.
#: Deliberately the STRICT value: a caller that forgets the field gets the honest verdict
#: rather than a silent pass.
DEFAULT_PAGE_TARGET = 1

# --- HARDENING 3: one work dir per render -----------------------------------------------------
# Typst's sandbox root is a directory, and everything under it is readable by the compiled
# document (`#read`, image paths). A single shared root would therefore let one render read
# another's input. Each render gets `/tmp/render/<uuid>/` and `shutil.rmtree`s it in a `finally`.
# /tmp PERSISTS ACROSS WARM INVOCATIONS on Lambda — the cleanup is what keeps invocation N+1
# from finding invocation N's document sitting there.
WORK_ROOT = pathlib.Path("/tmp/render")

# --- HARDENING 4 + the warm compiler ----------------------------------------------------------
# `ignore_system_fonts=True` with the bundled `rendercv_fonts` package as the ONLY font source.
# Without it the font set is whatever the host image happens to ship, and font metrics decide
# line breaks, which decide the page count, which decides whether a publish is blocked. A gate
# that depends on the base image is not a gate.
#
# The compiler is hoisted to module scope because constructing one costs ~0.4 s and the first
# compile in a process pays a further ~0.1 s font index, against ~2-7 ms for every compile
# after that. THE TRADEOFF, RESOLVED: a Compiler is built with a `root=`, but the work dir is
# per-render. Rather than choose between a warm compiler and a per-render sandbox, `compile()`
# takes a per-call `root=` override — so one process-wide compiler serves every render and each
# render still compiles inside its own directory. The constructor root is only the fallback and
# is never used by the code below.
FONT_PATHS = [str(pathlib.Path(rendercv_fonts.__file__).parent)]
WORK_ROOT.mkdir(parents=True, exist_ok=True)
COMPILER = typst.Compiler(root=str(WORK_ROOT), font_paths=FONT_PATHS, ignore_system_fonts=True)

ENGINE = {
    # Read from the installed distributions, never hardcoded: a lockfile bump that changes the
    # renderer must change what the response says it used, or the page count in an old record
    # is attributed to the wrong engine.
    "rendercv": importlib.metadata.version("rendercv"),
    "typst": importlib.metadata.version("typst"),
    "rendercv_fonts": importlib.metadata.version("rendercv-fonts"),
    "pypdf": importlib.metadata.version("pypdf"),
    "schema": SCHEMA_VERSION,
}


# --- errors -----------------------------------------------------------------------------------
#
# HARDENING 5: THE MESSAGE IS A LOG LINE, SO IT NEVER CARRIES THE DOCUMENT.
#
# `logs:PutLogEvents` is the ONLY capability the render role holds (infra/terraform/render.tf).
# That is the whole security argument for the second function — and it means a log is the one
# place a compromise of this process can put anything at all. Writing the user's résumé there
# ourselves hands that channel over for free, and CLAUDE.md is unconditional: never expose
# private user content in logs. Fourteen-day retention does not make it not-a-log.
#
# So every exception below has TWO channels and they are not interchangeable:
#
#   str(exc)   THE DIAGNOSTIC. Field paths, error class names, counts, positions, lengths,
#              valid-value lists. Lambda serialises this into the log group whenever anything
#              escapes `handler`, so it is written as if it were public — because it is.
#
#   exc.detail THE CALLER'S COPY. May name values, because `handler` RETURNS it over the
#              synchronous invoke to the authenticated owner of the document, and a return
#              value is not written to CloudWatch. This is what the editor renders in its form.
#
# The rule that follows, and the one the tests enforce: NO CALLER-SUPPLIED STRING is
# interpolated into a message. Not the résumé, and not the small fields either — `theme`,
# `format` and the event keys are attacker-chosen text, so `theme {theme!r} is not allowed`
# was a general-purpose write-anything-to-the-log primitive with the document as its payload.
# Lengths and counts say the same thing to a human debugging it and carry nothing.
#
# WHAT THE FIRST PASS OF THIS RULE MISSED, both found by review rather than by the test that
# claimed to assert the rule "over every failure this module can be made to produce":
#
#   1. KEY NAMES. A field PATH is caller-supplied whenever the caller chooses the key — and in
#      rendercv it does: `cv.sections.<anything>` is the author's own section name. So
#      `… at cv.MY_SECRET_EMPLOYER_Acme_Stealth_Labs` published the one fact a stealth-mode
#      job seeker is hiding, and a résumé pasted into a key name published the résumé.
#      `_redacted_path` below reduces every path to its SHAPE — depth and list positions, which
#      is what a human debugging a schema error actually reads — and the real path goes to the
#      caller in `detail`, like every other value.
#
#   2. ARGUMENT COERCION. `int(page_target)` and `int(png_dpi)` sat outside every guard, so a
#      non-numeric value raised `ValueError`, which is not a `RenderError`, which means
#      `handler` did not catch it — and CPython embeds the offending string verbatim
#      ("invalid literal for int() with base 10: '<200 characters of the caller's>'"). That is
#      the same write-anything-to-CloudWatch primitive, on a path the rule's own test never
#      drove. `_int_arg` / `_str_list_arg` below put every scalar and list argument on the
#      validated path, so the ONLY way into this module is through a `RenderError`.

class RenderError(Exception):
    """Base for every error this module raises on its own behalf.

    `message` is the log-safe diagnostic; `detail` is the structured copy returned to the
    caller. See the section header above — the split is a security control, not a style.
    """

    def __init__(self, message: str, detail: dict | None = None):
        self.detail = dict(detail or {})
        super().__init__(message)


#: Upper bounds on the two numeric arguments. They are NOT decoration and they are new:
#: `int(png_dpi)` accepted 10**9, and a PNG at a billion DPI is an OOM inside a 1024 MB
#: function — the one failure the `Errors` alarm exists to catch, reachable from an
#: unauthenticated-shaped request. 600 is well past print quality; 5 is the maximum
#: `resume_documents.page_target` can hold (0026's CHECK), so no legitimate stored document
#: can exceed it and the renderer refuses what the store would have refused.
MAX_PNG_DPI = 600
MAX_PAGE_TARGET = 5
#: How deep a document may nest. A résumé is a handful of levels; 64 is far past any real one
#: and far short of the interpreter's limit. Without it, a deeply nested document produced a
#: `RecursionError` — not a `RenderError` — from inside the YAML dump, so `handler`'s
#: `except RenderError` did not cover it and Lambda logged a traceback and spent an `Errors`
#: datapoint on a request that was simply invalid.
MAX_DOCUMENT_DEPTH = 64


def _int_arg(value, name: str, *, minimum: int, maximum: int) -> int:
    """A caller-supplied integer, or a `RenderError` that carries none of it.

    `int(value)` was what this replaces, and it had two separate faults. It raised `ValueError`
    — not a `RenderError` — so `handler` did not catch it, the Lambda runtime serialised it into
    the log group, and CPython's message quotes the offending string in full. And it accepted
    any magnitude, so `png_dpi` had no ceiling at all.

    `name` is a literal from this module, never from the event, so it is safe to interpolate;
    `type(value).__name__` is a Python type name, likewise. The rejected VALUE goes to `detail`.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        # bool is an int subclass; `png_dpi=True` meaning 1 DPI is a silent absurdity.
        raise RenderError(
            f"{name} must be an integer between {minimum} and {maximum}, "
            f"got {type(value).__name__}",
            {"argument": name, "value": value, "min": minimum, "max": maximum},
        )
    if not minimum <= value <= maximum:
        raise RenderError(
            f"{name} must be between {minimum} and {maximum}, got {value}",
            {"argument": name, "value": value, "min": minimum, "max": maximum},
        )
    return value


def _str_list_arg(value, name: str) -> list[str]:
    """A caller-supplied list of strings, or a `RenderError`.

    `list(value or [])` was what this replaces. It turned a string into its characters
    (`formats="pdf"` -> `['p','d','f']`, reported as three unknown formats) and raised a bare
    `TypeError` for anything not iterable — again outside `handler`'s `except RenderError`, so
    again a fault-shaped invoke and an `Errors` alarm for a malformed request.

    A `tuple` is accepted because `gate_themes` and the tests pass one and there is no reason
    for a renderer to care; a `str` is REFUSED rather than wrapped, because guessing that the
    caller meant a one-element list is the kind of guess CLAUDE.md forbids.
    """
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        raise RenderError(
            f"{name} must be a list of strings, got {type(value).__name__}",
            {"argument": name, "value": value if isinstance(value, (int, float)) else None},
        )
    bad = [i for i, v in enumerate(value) if not isinstance(v, str)]
    if bad:
        raise RenderError(
            f"{name} must contain only strings; {len(bad)} of {len(value)} "
            f"element(s) are not, at index/indices {bad}",
            {"argument": name, "bad_indices": bad},
        )
    return list(value)


#: A schema path reduced to its SHAPE. `cv.sections.MY_STEALTH_EMPLOYER.[0].photo` becomes
#: `<key>.<key>.<key>.[0].<key>` — same depth, same list positions, no caller text. That is
#: what a human reading a validation error off a log line actually uses (how deep, which
#: element of which list); the readable path is in `detail["errors"][i]["schema_location"]`,
#: which goes back to the document's owner over the return value.
#:
#: Index positions are kept verbatim because they are integers the caller can only choose the
#: MAGNITUDE of, and a magnitude is a count — the same class of fact as `len(text)` elsewhere
#: in this file.
def _redacted_path(parts) -> str:
    if not parts:
        return "<document>"
    out = []
    for p in parts:
        # TYPE, not spelling. rendercv reports a list position as a real int and a mapping
        # key as a str, so the int is the thing the caller only chose the magnitude of.
        # Matching on `str(p)` instead let an all-digit KEY — `2024:` as a section name, a
        # phone number pasted as a key — through verbatim, which is caller text in the one
        # place this function exists to remove it. (`[0]` stays matched for any caller that
        # hands us the bracketed spelling.)
        if isinstance(p, int) and not isinstance(p, bool):
            out.append(str(p))
        elif _INDEX.fullmatch(str(p)):
            out.append(str(p))
        else:
            out.append("<key>")
    return ".".join(out)


#: ONLY the bracketed form. The bare `\d+` alternative meant an all-digit MAPPING key — a
#: résumé with `2024:` as a section name — matched and was emitted verbatim, so the redaction
#: had a hole shaped exactly like the caller's own text. A list index arrives bracketed; a
#: key never does.
_INDEX = re.compile(r"\[\d+\]")


class RenderInternalError(RenderError):
    """A failure this module did not predict, stripped of the caller's text.

    Its existence is the point: `_mapped` used to return an unrecognised exception
    untouched, so a library bug on a caller-reachable path put the caller's own text and a
    traceback in the log group. Everything leaving this module is now a `RenderError`, and
    the unpredicted ones say only which class failed.
    """


class ThemeNotAllowed(RenderError):
    """A theme that is not one of the nine built-ins. See HARDENING 1."""


class PhotoFieldMoved(RenderError):
    """A `photo` key survived the strip, i.e. the schema moved. See HARDENING 2."""


class ThemeGateFailed(RenderError):
    """A theme rendered the gate document over `page_target`. See `gate_themes`."""

    def __init__(self, failures: dict, page_target: int):
        self.failures = failures
        self.page_target = page_target
        super().__init__(
            f"theme(s) over the {page_target}-page target: "
            + ", ".join(f"{t}={p}" for t, p in sorted(failures.items()))
        )


class RenderValidationError(RenderError):
    """RenderCV rejected the document. `exc.detail["errors"]` is what the caller renders in its
    form; `str(exc)` names the FIELDS that failed and never their values.

    The structure used to live inside the message, on the reasoning that Lambda flattens an
    exception to `errorType` + `errorMessage` so nothing else survives the invoke boundary.
    That was true and it was the bug: the structure carried `yaml_source`, the offending
    snippet of the user's résumé, and "survives the invoke boundary" is the same sentence as
    "is written to the log group". `handler` returns this now instead of raising it, so the
    detail reaches the caller by the channel that was always available — the return value.
    """

    def __init__(self, errors: list[dict]):
        self.errors = errors
        # REDACTED, because a field path is caller-supplied text whenever the caller chooses
        # the key — and in rendercv it does. `cv.sections.<name>` is the author's own section
        # title, so the readable version published `… at cv.MY_SECRET_EMPLOYER_Acme_Stealth_Labs`
        # into the log group: at a stealth employer that name IS the private fact, and a résumé
        # pasted into a key name was the whole résumé. The real paths are in `detail`.
        paths = ", ".join(_redacted_path(e.get("schema_location") or []) for e in errors)
        super().__init__(
            f"rendercv rejected the document: {len(errors)} validation error(s) at {paths}",
            {"errors": errors},
        )


# --- YAML -------------------------------------------------------------------------------------
# ruamel, not PyYAML: it is what rendercv itself pins, so it is already in the lockfile and the
# render image gains no dependency. `typ="safe"` because the input is untrusted — the safe
# loader has no `!!python/*` constructors to abuse.
_YAML = YAML(typ="safe", pure=True)
_YAML.default_flow_style = False


def _load_yaml(text: str, what: str) -> dict:
    try:
        data = _YAML.load(text)
    except Exception as e:
        # NOT `{e}`. ruamel renders a parse error with the offending SOURCE LINE embedded in
        # it, so interpolating `str(e)` published a slice of the user's document into a message
        # Lambda writes to CloudWatch. The class and the mark say the same thing to whoever is
        # debugging it: what kind of syntax error, and where.
        mark = getattr(e, "problem_mark", None)
        where = (f"line {mark.line + 1}, column {mark.column + 1}"
                 if mark is not None else f"offset unknown, {len(text)} bytes")
        raise RenderError(
            f"{what} is not valid YAML: {type(e).__name__} at {where}",
            {"error": type(e).__name__,
             "line": None if mark is None else mark.line + 1,
             "column": None if mark is None else mark.column + 1,
             "problem": getattr(e, "problem", None)},
        ) from None      # `from None`: the CAUSE carries the source line too, and a chained
                         # traceback prints it
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise RenderError(f"{what} must be a mapping, got {type(data).__name__}")
    return dict(data)


def _dump_yaml(data: dict) -> str:
    buf = io.StringIO()
    _YAML.dump(data, buf)
    return buf.getvalue()


def _checked_depth(value, what: str) -> None:
    """Refuse a document nested past `MAX_DOCUMENT_DEPTH`, iteratively.

    Iteratively on purpose: a recursive depth check on a document deep enough to matter
    raises the very `RecursionError` it exists to prevent.
    """
    stack = [(value, 1)]
    while stack:
        node, depth = stack.pop()
        if depth > MAX_DOCUMENT_DEPTH:
            raise RenderError(
                f"{what} nests deeper than {MAX_DOCUMENT_DEPTH} levels",
                {"kind": "too_deep", "limit": MAX_DOCUMENT_DEPTH},
            )
        if isinstance(node, dict):
            stack.extend((v, depth + 1) for v in node.values())
        elif isinstance(node, (list, tuple)):
            stack.extend((v, depth + 1) for v in node)


def _as_block(value, key: str, what: str) -> dict:
    """Accept either the whole rendercv document (`{key: {...}}`) or the bare block.

    Not a guess: rendercv has no `cv.cv` or `design.design` field, so the presence of the
    top-level key is unambiguous. A YAML string is parsed the same way, which is what lets the
    same call take a DB row (a dict, per D1) or a pasted file.
    """
    if value is None:
        return {}
    if isinstance(value, str):
        value = _load_yaml(value, what)
    if not isinstance(value, dict):
        raise RenderError(f"{what} must be a mapping or a YAML string, got {type(value).__name__}")
    inner = value.get(key, value) if key in value else value
    if not isinstance(inner, dict):
        raise RenderError(f"{what}.{key} must be a mapping, got {type(inner).__name__}")
    return dict(inner)


# --- HARDENING 2: SSRF — the photo strip ------------------------------------------------------

def _strip_photo(cv: dict, warnings: list[str]) -> dict:
    """Delete `cv.photo` unconditionally, before anything serializes or validates.

    `cv.photo` is typed `ExistingPathRelativeToInput | pydantic.HttpUrl | None`, and pydantic's
    HttpUrl happily accepts `http://169.254.169.254/latest/meta-data/...`. `render_full_template`
    then calls `download_photo_from_url()` -> `urllib.request.urlretrieve(url, dest)` with no
    allowlist, no timeout and no size cap. Proven: a local stand-in server received the GET.

    Deletion, not a host allowlist. The product has no photo feature, so there is no legitimate
    value to preserve, and every allowlist for a fetch-by-URL feature is a DNS rebind away from
    being wrong. A warning is appended so the strip is OBSERVABLE — a silent fix is one nobody
    notices has been reverted.
    """
    if "photo" in cv:
        cv.pop("photo")
        warnings.append("cv.photo was removed: this renderer never fetches remote images.")
    # Defense in depth. photo lives at cv.photo today; if a future rendercv moves or nests it,
    # the strip above would quietly stop covering it and the fetch would come back. Loud beats
    # a silently reopened SSRF, and a stray `photo:` key is dropped by rendercv's entry models
    # anyway, so nothing legitimate is lost by refusing it.
    stray = _find_key(cv, "photo")
    if stray:
        # Same redaction, same reason: the path runs through the author's own section names.
        # `photo` is re-stated as a literal because it is OUR search term, not the caller's —
        # `_find_key` was asked for it, so naming it publishes nothing.
        raise PhotoFieldMoved(
            f"a 'photo' key survived the strip at {_redacted_path(stray)} (the last segment is "
            "'photo') — the schema moved; re-check _strip_photo against rendercv before shipping",
            {"path": list(stray)},
        )
    return cv


def _find_key(node, key: str, path: tuple[str, ...] = ()) -> tuple[str, ...] | None:
    if isinstance(node, dict):
        for k, v in node.items():
            if k == key:
                return (*path, str(k))
            found = _find_key(v, key, (*path, str(k)))
            if found:
                return found
    elif isinstance(node, list):
        for i, v in enumerate(node):
            found = _find_key(v, key, (*path, f"[{i}]"))
            if found:
                return found
    return None


# --- theme ------------------------------------------------------------------------------------

def _checked_theme(design: dict) -> str:
    theme = design.get("theme") or DEFAULT_THEME
    if not isinstance(theme, str) or theme not in ALLOWED_THEMES:
        # The REJECTED VALUE IS NOT IN THE MESSAGE, and this is the one that mattered most:
        # `theme` is a free-text field the caller controls, so `theme {theme!r} is not allowed`
        # was a write-anything-to-CloudWatch primitive — put the résumé in `theme`, read it out
        # of the log group. It goes to the caller in `detail`, where it belongs.
        raise ThemeNotAllowed(
            f"theme is not one of the built-in themes {sorted(ALLOWED_THEMES)} "
            f"(got {type(theme).__name__}, {len(theme) if isinstance(theme, str) else 0} chars). "
            "Custom theme folders are never loaded here: rendercv executes their __init__.py "
            "during validation.",
            {"theme": theme if isinstance(theme, str) else None,
             "allowed": sorted(ALLOWED_THEMES)},
        )
    return theme


# --- work dir ---------------------------------------------------------------------------------

def _make_workdir() -> pathlib.Path:
    """A fresh absolute directory under WORK_ROOT. A seam: the tests substitute this to plant a
    hostile theme folder where rendercv would look for one."""
    workdir = WORK_ROOT / uuid.uuid4().hex
    workdir.mkdir(parents=True)
    return workdir


# --- ATS text ---------------------------------------------------------------------------------

_WS = re.compile(r"\s+")
_NON_ALNUM = re.compile(r"[^0-9a-z]+")


def _tight(s: str) -> str:
    return _WS.sub(" ", s.casefold()).strip()


def _loose(s: str) -> str:
    return _NON_ALNUM.sub("", s.casefold())


def _ats(pdf: bytes, tokens: list[str]) -> dict:
    """Extracted text plus a per-token found/not-found. No score — a number invented here would
    be read as a judgement nobody measured.

    Two passes because THE RENDERED FORM DIFFERS FROM THE SOURCE: `+1-512-555-0123` in the YAML
    extracts as `(512) 555-0123`. `found` is whitespace-normalized casefolded substring;
    `found_loose` strips every non-alphanumeric from both sides first. Note the honest limit of
    the loose pass — it is a substring test, so a source token carrying an E.164 country code
    the renderer drops (`+1-512-...` -> `15125550123` vs `5125550123`) still reports not-found.
    Pass the tokens you actually want checked.
    """
    reader = pypdf.PdfReader(io.BytesIO(pdf))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    tight, loose = _tight(text), _loose(text)
    return {
        "text": text,
        "tokens": [
            {"token": t, "found": _tight(t) in tight, "found_loose": bool(_loose(t)) and _loose(t) in loose}
            for t in tokens
        ],
    }


# --- one render -------------------------------------------------------------------------------

def _build_model(cv_yaml: str, design: dict, workdir: pathlib.Path):
    settings = {"settings": {"render_command": {"output_folder": str(workdir / "out")}}}
    try:
        _, model = build_rendercv_dictionary_and_model(
            cv_yaml,
            design_yaml_file=_dump_yaml({"design": design}),
            settings_yaml_file=_dump_yaml(settings),
            # Absolute, and inside the per-render work dir: rendercv resolves relative paths
            # (and, for an unknown theme, a THEME FOLDER) against this file's parent.
            input_file_path=workdir / "cv.yaml",
        )
    except Exception as e:
        raise _mapped(e) from e
    return model


def _mapped(exc: Exception) -> Exception:
    """RenderCV's structured validation errors -> the JSON shape the caller renders inline."""
    errors = getattr(exc, "validation_errors", None)
    if errors:
        return RenderValidationError([
            {
                "schema_location": list(e.schema_location or ()),
                # WHERE, not WHAT. `yaml_source` — rendercv's copy of the offending line of the
                # user's document — used to be here, and from here it reached the exception
                # message and the log group. The caller holds the document and the position, so
                # it can quote the line itself; nothing downstream needed our copy of it.
                "yaml_location": [list(pos) for pos in (e.yaml_location or ())] or None,
                "message": e.message,
            }
            for e in errors
        ])
    message = getattr(exc, "message", None)
    if message:                       # RenderCVUserError — one message, no location
        return RenderValidationError([
            {"schema_location": [], "yaml_location": None, "message": message}
        ])
    # Anything else is a bug — in this module or in the library — and "let it propagate
    # untouched" was the wrong answer to that. A bug on a caller-reachable path still
    # carries caller text: a numeric YAML key (`2024:` in a résumé) reaches rendercv's own
    # error REPORTER, which raises `KeyError(2024)`, and an unmapped raise puts the key and
    # a full traceback in the log group and spends an `Errors` datapoint. The invariant this
    # module states — nothing leaves except a RenderError — has to hold for the failures we
    # did not predict, because those are exactly the ones nobody redacted by hand. The class
    # name is safe (it is ours or the library's); the args are not, and are dropped.
    return RenderInternalError(
        f"the renderer failed unexpectedly: {type(exc).__name__}",
        {"kind": "internal", "exception": type(exc).__name__},
    )


class TypstCompileError(RenderError):
    """Typst refused the generated source.

    Wrapped rather than propagated because typst renders a compile error by QUOTING THE
    OFFENDING SOURCE LINE, and that source is the user's document run through rendercv's
    template — `#read("/etc/passwd")` in `cv.name` fails here with the injected text in the
    message. Contained by `root=` (proven in test_render_live.py) and therefore harmless as an
    exploit; it is a private-content leak all the same, because the raw message went to the log
    group. The text goes to the caller in `detail`.
    """


def _compile(typ: str, workdir: pathlib.Path, fmt: str, **kw):
    try:
        return COMPILER.compile(input=typ.encode("utf-8"), format=fmt, root=str(workdir), **kw)
    except Exception as e:
        raise TypstCompileError(
            f"typst could not compile the {fmt} for this document "
            f"({type(e).__name__}, {len(typ)} bytes of source)",
            {"error": type(e).__name__, "message": str(e), "format": fmt},
        ) from None


def _pages(pdf: bytes) -> int:
    return len(pypdf.PdfReader(io.BytesIO(pdf)).pages)


# --- the public function ----------------------------------------------------------------------

def render(
    cv,
    design=None,
    formats=None,
    png_dpi: int = DEFAULT_PNG_DPI,
    probe_themes=None,
    page_target: int = DEFAULT_PAGE_TARGET,
    ats_tokens=None,
) -> dict:
    """Render one document. Raises on anything it cannot do; never returns a partial result.

    Fail loud, never guess: a validation error is information the author needs, and a renderer
    that swallows it hands back a stale PDF that looks fine.
    """
    if cv is None:
        raise RenderError("no cv: the render service takes {'cv': <yaml or mapping>, ...}")
    # EVERY caller-supplied argument is validated HERE, before anything else touches it, and
    # every rejection is a `RenderError` — which is what makes `handler`'s `except RenderError`
    # a complete boundary rather than a mostly-complete one. `int(...)` and `list(...)` used to
    # sit at the bottom of this block; both raise their own exception types, so a malformed
    # request escaped `handler`, went into the log group with the caller's string inside it,
    # and incremented `AWS/Lambda Errors`.
    formats = _str_list_arg(formats, "formats") or ["pdf"]
    unknown = [f for f in formats if f not in FORMATS]
    if unknown:
        # Same rule as the theme: the names came from the caller, so they go in `detail`.
        raise RenderError(
            f"{len(unknown)} unknown format(s); valid formats: {sorted(FORMATS)}",
            {"unknown_formats": unknown, "valid_formats": sorted(FORMATS)},
        )
    probe_themes = _str_list_arg(probe_themes, "probe_themes")
    ats_tokens = _str_list_arg(ats_tokens, "ats_tokens")
    page_target = _int_arg(page_target, "page_target", minimum=0, maximum=MAX_PAGE_TARGET)
    png_dpi = _int_arg(png_dpi, "png_dpi", minimum=1, maximum=MAX_PNG_DPI)

    warnings: list[str] = []
    # Depth FIRST, before anything walks the document. `_strip_photo` recurses, so a check
    # placed after it never runs — the recursive walk raises first, which is the bug this
    # bound exists to prevent.
    cv_raw = _as_block(cv, "cv", "cv")
    _checked_depth(cv_raw, "cv")
    cv_block = _strip_photo(cv_raw, warnings)
    design_block = _as_block(design, "design", "design")
    _checked_depth(design_block, "design")
    design_block["theme"] = _checked_theme(design_block)
    for theme in probe_themes:
        # Probe themes are RENDERED, so they go through the same gate as the main one.
        _checked_theme({"theme": theme})

    cv_yaml = _dump_yaml({"cv": cv_block})

    workdir = _make_workdir()
    try:
        model = _build_model(cv_yaml, design_block, workdir)
        typ = render_full_template(model, "typst")
        # The PDF is always compiled, even when it was not requested: the page count, the gate
        # verdict and the ATS text all come out of it, and it costs single-digit milliseconds.
        pdf = _compile(typ, workdir, "pdf")
        pages = _pages(pdf)

        out: dict = {
            "pages": pages,
            "engine": dict(ENGINE),
            "warnings": warnings,
            # The gate REPORTS, it never refuses. A render that hides the 2-page result is
            # useless for fixing the 2-page result — blocking is the caller's decision.
            "gate": {
                "page_target": page_target,
                "pages": pages,
                "ok": page_target == 0 or pages <= page_target,
            },
            "ats": _ats(pdf, ats_tokens),
        }
        if "pdf" in formats:
            out["pdf_b64"] = base64.b64encode(pdf).decode("ascii")
        if "typst" in formats:
            out["typst"] = typ
        if "png" in formats:
            # typst returns bytes for a one-page document and list[bytes] for more.
            png = _compile(typ, workdir, "png", ppi=png_dpi)
            pages_png = png if isinstance(png, list) else [png]
            out["png_b64"] = [base64.b64encode(p).decode("ascii") for p in pages_png]
        if probe_themes:
            # Page counts only, no artifacts — this is what powers "show me the page delta
            # before I switch themes". Page count is a joint function of content AND theme and
            # cannot be predicted client-side, so it is measured, once, per theme.
            out["probe"] = {
                theme: _pages(_compile(
                    render_full_template(
                        _build_model(cv_yaml, {**design_block, "theme": theme}, workdir), "typst"),
                    workdir, "pdf"))
                for theme in probe_themes
            }
        return out
    finally:
        # HARDENING 3. /tmp survives a warm invocation; this is what stops document N from
        # being readable while document N+1 renders.
        shutil.rmtree(workdir, ignore_errors=True)


def gate_themes(
    cv,
    design=None,
    themes=None,
    page_target: int = DEFAULT_PAGE_TARGET,
    strict: bool = True,
) -> dict:
    """Render one document once per theme and assert every theme fits `page_target`.

    WHY THIS IS A GATE AND NOT A REPORT, when `render()`'s own gate deliberately only reports:
    they answer different questions. `render()` gates ONE user's document, where a second page
    is that person's editing problem and blocking their preview helps nobody. This gates the
    THEME SET — the product's promise that every theme it offers can hold a one-page resume.
    A theme that cannot is a shipping defect, so it raises: ThemeGateFailed names every theme
    that blew the target and its page count, not just the first.

    The reference document (infra/render/fixtures/) is the contract's counterexample-catcher:
    it is deliberately a FULL one — nine bullets across three roles — because a gate fed a
    three-line resume passes for every theme ever written and proves nothing.

    `themes=None` means every theme in ALLOWED_THEMES, i.e. everything the product will
    render. Themes are checked through `_checked_theme` first, so this can never be the path
    that loads a theme folder (HARDENING 1).
    """
    themes = sorted(ALLOWED_THEMES) if themes is None else _str_list_arg(themes, "themes")
    if not themes:
        raise RenderError("gate_themes needs at least one theme")
    # minimum=1, not 0: this is a GATE, and "no limit" is not a gate. Same validated path as
    # `render()` — `int(page_target)` here had the identical ValueError-escapes-handler hole.
    page_target = _int_arg(page_target, "page_target", minimum=1, maximum=MAX_PAGE_TARGET)
    for theme in themes:
        _checked_theme({"theme": theme})

    warnings: list[str] = []
    cv_block = _strip_photo(_as_block(cv, "cv", "cv"), warnings)
    design_block = _as_block(design, "design", "design")
    cv_yaml = _dump_yaml({"cv": cv_block})

    pages: dict[str, int] = {}
    for theme in themes:
        workdir = _make_workdir()
        try:
            model = _build_model(cv_yaml, {**design_block, "theme": theme}, workdir)
            pages[theme] = _pages(_compile(render_full_template(model, "typst"), workdir, "pdf"))
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    failures = {t: n for t, n in pages.items() if n > page_target}
    if failures and strict:
        raise ThemeGateFailed(failures, page_target)
    return {
        "page_target": page_target,
        "ok": not failures,
        "themes": {t: {"pages": n, "ok": n <= page_target} for t, n in pages.items()},
        "warnings": warnings,
    }


def handler(event, context):
    """Lambda entrypoint. Synchronous invoke only — there is no schedule behind this function.

    A USER ERROR IS A RESULT, NOT AN EXCEPTION, and both halves of that matter:

    PRIVACY. A raised exception is serialised by the Lambda runtime into the function's log
    group — `errorType`, `errorMessage`, `stackTrace`. `logs:PutLogEvents` is the only thing
    this role can do, so raising is the one way this process can publish anything, and the
    thing it was publishing was the document. Returning hands the same information to the
    synchronous caller that is waiting for it, over a channel that is not written down.

    THE ALARM. `alerts.tf`'s `render_errors` claims "a user-visible validation error is NOT
    this — those return to the caller". It was not true: an unhandled exception increments
    `AWS/Lambda Errors` for a sync invoke exactly as a timeout does, so with
    `threshold = 0, evaluation_periods = 1` a single malformed résumé paged ntfy — and an alarm
    that fires on typos gets muted, taking the OOM detection it exists for with it. Now the
    alarm means what its description says.

    WHAT STILL RAISES: everything that is not a `RenderError`. An OOM, a broken image, a bug in
    this module — those are faults, nobody is served by a 200 that hides them, and they are
    what the alarm is for. Catching `Exception` here would silence the alarm permanently.
    """
    event = event or {}
    try:
        stray = sorted(set(event) - EVENT_KEYS)
        if stray:
            raise RenderError(
                f"{len(stray)} unknown input key(s); valid keys: {sorted(EVENT_KEYS)}",
                {"unknown_keys": stray, "valid_keys": sorted(EVENT_KEYS)},
            )
        out = render(
            cv=event.get("cv"),
            design=event.get("design"),
            formats=event.get("formats"),
            png_dpi=event.get("png_dpi", DEFAULT_PNG_DPI),
            probe_themes=event.get("probe_themes"),
            page_target=event.get("page_target", DEFAULT_PAGE_TARGET),
            ats_tokens=event.get("ats_tokens"),
        )
        return {"ok": True, **out}
    except RenderError as e:
        # `type(e).__name__` and not a code table: the class names ARE the contract
        # (ThemeNotAllowed, PhotoFieldMoved, RenderValidationError, TypstCompileError,
        # ThemeGateFailed), the caller matches on them, and a parallel table of strings is one
        # more thing to leave stale.
        return {"ok": False, "error": {"type": type(e).__name__,
                                       "message": str(e),
                                       "detail": e.detail}}
