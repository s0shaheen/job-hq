"""The digest email's action tokens, and the href guard that renders them.

`core/digest_links.py` mints; `webapp/lib/digest/token.ts` verifies. The two are
pinned to each other by `tests/fixtures/digest-token.golden.json`, and the
Python half of that pin is here: this file reads the golden as DATA and never
re-derives it from the code under test, which is the whole point of a golden.

MUTATION TARGETS this file exists to kill (each run red before green):
  * drop `"t": PURPOSE` from the payload      -> the golden token test;
  * sign the payload only, not `v1.kid.…`     -> the golden token test;
  * accept a token whose `kid` is unknown     -> the rotation test;
  * compare signatures with `==`              -> not observable, so the golden
    plus the tamper test carry it: `hmac.compare_digest` is asserted by import;
  * let `safe_href` keep userinfo (P-2)       -> the credentials test;
  * let `safe_href` accept `javascript:`      -> the scheme test;
  * let `webapp_base` accept plain http       -> the origin test (matrix row 29).
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pytest

from core import digest_links as dl

ROOT = Path(__file__).resolve().parents[2]
GOLDEN = json.loads((ROOT / "tests" / "fixtures" / "digest-token.golden.json").read_text())
KEYS = [(GOLDEN["kid"], GOLDEN["secret"])]
BEFORE_EXPIRY = dt.datetime(2026, 7, 28, tzinfo=dt.timezone.utc)
AFTER_EXPIRY = dt.datetime(2026, 8, 10, tzinfo=dt.timezone.utc)


def test_the_golden_token_is_what_this_module_mints():
    """The cross-language constant, from its author. If this fails, every link
    already sitting in an inbox stopped verifying."""
    minted = dl.mint(GOLDEN["user_id"], GOLDEN["posting_key"], GOLDEN["action"],
                     now=dt.datetime(2026, 7, 27, 11, 40, tzinfo=dt.timezone.utc),
                     keys=KEYS, jti=GOLDEN["jti"])
    assert minted == GOLDEN["token"]


def test_the_golden_payload_decodes_to_the_documented_json():
    body = GOLDEN["token"].split(".")[2]
    assert dl.unb64u(body).decode() == GOLDEN["payload_json"]


def test_round_trip():
    payload = dl.verify(GOLDEN["token"], keys=KEYS, now=BEFORE_EXPIRY)
    assert payload.user_id == GOLDEN["user_id"]
    assert payload.posting_key == GOLDEN["posting_key"]
    assert payload.action == "interested"
    assert payload.jti == GOLDEN["jti"]


def test_the_action_is_inside_the_signature():
    """Matrix row 27. The fixture's tampered token is the golden with
    `interested` swapped for `dismissed` and the ORIGINAL signature left on.
    A design that put the action in a query parameter would accept it."""
    with pytest.raises(dl.TokenError):
        dl.verify(GOLDEN["tampered_action_token"], keys=KEYS, now=BEFORE_EXPIRY)


@pytest.mark.parametrize("part", [2, 3])
def test_one_flipped_byte_anywhere_is_rejected(part):
    bits = GOLDEN["token"].split(".")
    bits[part] = ("A" if bits[part][0] != "A" else "B") + bits[part][1:]
    with pytest.raises(dl.TokenError):
        dl.verify(".".join(bits), keys=KEYS, now=BEFORE_EXPIRY)


def test_an_unknown_key_id_is_rejected_and_both_keys_work_mid_rotation():
    """Matrix row 28. Retiring a kid kills every token signed with it at once,
    which is this unit's ONLY revocation lever — see the module docstring's
    deviation note. So both halves have to hold."""
    with pytest.raises(dl.TokenError):
        dl.verify(GOLDEN["token"], keys=[("k9", GOLDEN["secret"])], now=BEFORE_EXPIRY)
    rotating = [("k2", "f" * 64), (GOLDEN["kid"], GOLDEN["secret"])]
    assert dl.verify(GOLDEN["token"], keys=rotating, now=BEFORE_EXPIRY).jti == GOLDEN["jti"]
    # and the NEWEST key is the one that signs
    assert dl.mint("u", "p", "interested", keys=rotating).startswith("v1.k2.")


def test_expiry_is_enforced_on_the_clock_it_is_given():
    with pytest.raises(dl.TokenError, match="expired"):
        dl.verify(GOLDEN["token"], keys=KEYS, now=AFTER_EXPIRY)


def test_the_secret_is_compared_in_constant_time():
    """Structural, because timing is not assertable in a unit test. The point is
    that a future edit to `==` has to delete this line to pass."""
    import inspect
    assert "hmac.compare_digest" in inspect.getsource(dl.verify)


def test_minting_refuses_an_action_nobody_registered():
    with pytest.raises(ValueError):
        dl.mint("u", "p", "snoozed", keys=KEYS)


# ------------------------------------------------------------------- keys

@pytest.mark.parametrize("raw", [
    "", "   ", "nocolon", "K1:" + "a" * 40, "k1:short", "k1:" + "a" * 40 + ",k1:" + "b" * 40])
def test_a_malformed_key_env_raises_rather_than_signing_with_a_guess(raw):
    with pytest.raises(dl.KeyConfigError):
        dl.load_keys(raw)
    assert dl.has_keys(raw) is False


def test_keys_parse_newest_first():
    pairs = dl.load_keys(f"new:{'a' * 40}, old:{'b' * 40}")
    assert [k for k, _ in pairs] == ["new", "old"]


# --------------------------------------------------------------- safe_href

@pytest.mark.parametrize("bad", [
    "javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<b>", "vbscript:x",
    "mailto:jobs@ramp.com", "file:///etc/passwd", "//evil.example", "/jobs/1234",
    "N/A", "not specified", "www.ramp.com/careers", "", "   ",
    "https://good.example\\@evil.example", "https://good.example/a b",
    "https://\nevil.example",
])
def test_safe_href_refuses_everything_that_is_not_an_absolute_http_url(bad):
    assert dl.safe_href(bad) == ""


@pytest.mark.parametrize("bad", [
    "https://www.google.com@evil.example",
    "https://www.google.com:80@evil.example",
    "http://user:pass@evil.example/login",
])
def test_safe_href_refuses_credentials_in_the_url(bad):
    """P-2 from the C2 review, carried forward to the renderer it named. The
    host a browser resolves is not the host a reader sees, and `job_url` reaches
    this function from an LLM reading an attacker-writable email body."""
    assert dl.safe_href(bad) == ""


@pytest.mark.parametrize("good", [
    "https://boards.greenhouse.io/acme/jobs/1",
    "http://localhost:3000/queue",
    "https://www.ramp.com/careers?src=hq",
    "https://www.ramp.com/@handle",          # an @ in the PATH is not userinfo
])
def test_safe_href_passes_a_real_url_unchanged(good):
    assert dl.safe_href(good) == good


def test_safe_href_never_repairs():
    """Repair belongs at the store's door where a note can ride with the row.
    Here the honest answer to a bad URL is a line with no link."""
    assert dl.safe_href(" https://x.co/j ") == "https://x.co/j"   # trim only
    assert dl.safe_href("www.ramp.com") == ""


# -------------------------------------------------------------- the origin

@pytest.mark.parametrize("raw,expected", [
    ("https://hq.example.com", "https://hq.example.com"),
    ("https://hq.example.com/", "https://hq.example.com"),
    ("http://localhost:3000", "http://localhost:3000"),
    ("http://127.0.0.1:3000", "http://127.0.0.1:3000"),
    ("http://preview.vercel.app", ""),        # matrix row 29
    ("/queue", ""),
    ("", ""),
    ("https://user@hq.example.com", ""),
])
def test_webapp_base_demands_an_absolute_https_origin(raw, expected):
    assert dl.webapp_base(raw) == expected


def test_action_url_shape():
    assert dl.action_url("https://hq.example.com", "v1.k1.a.b") == \
        "https://hq.example.com/d/v1.k1.a.b"
    assert dl.action_url("", "v1.k1.a.b") == ""
