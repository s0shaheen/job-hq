"""The identity of a company domain — the Python mirror of
`public.hq_normalize_domain` (migration 0021).

A company domain is the LogoAvatar's key: `https://img.logo.dev/{domain}` first,
a favicon service second, a 2-letter monogram last. A WRONG domain renders another
company's logo behind an <img> that loads and looks right; a MISSING one renders a
monogram. So this refuses more than it accepts — anything that does not reduce to a
plausible bare host (`label(.label)*.tld`, alphabetic TLD) answers "", and the
harvest stores nothing rather than a guess. It is `core.linkedinids`'s posture, one
column over.

TWO IMPLEMENTATIONS, ONE RULE, pinned rather than promised: this function and
`public.hq_normalize_domain`. `tests/db/test_company_domain.py` runs the two over
one corpus inside real Postgres, so a change to either side fails rather than
drifting — the same guard `tests/db/test_linkedin_fill.py` puts on `is_blank`.

WHY THE HARVEST NORMALIZES HERE rather than sending the raw string and letting the
door do it: the harvest dedupes a page of jobs by company (one fill per employer,
not per posting) and must skip a domain-less or garbage payload BEFORE calling the
RPC, exactly as `linkedin_backfill.harvest` drops an id it cannot vouch for.

THE SQL DOOR IS LOAD-BEARING, NOT DECORATION. An earlier version of this paragraph
called it "defense in depth that never fires, because this side already refused it",
and an adversarial review executed the counter-example: `'ramp.com\\n/evil'` came out
of THIS function as `'ramp.com\\n'` — a value with a newline in it, which the
paragraph above swears cannot be emitted — and only `hq_normalize_domain`'s own
re-normalization stopped it reaching the column. Both defects behind that (the `$`
anchor, the locale-dependent `lower()`) are fixed below and pinned by the shared
corpus, so the two sides agree again. The door still normalizes independently and
still raises, and it is what would catch the NEXT divergence: a parity claim is only
as good as the corpus behind it, and a second gate does not depend on the corpus at
all.
"""
from __future__ import annotations

import re

# Reuse the ONE definition of Postgres' space/zero-width classes rather than
# re-spelling the codepoints: `core.linkedinids` already mirrors `hq_blank_trim`'s
# HQ_BLANK_ZERO_WIDTH and HQ_BLANK_SEPARATORS, and a second copy here is a second
# thing that can drift from the database about which characters are blank.
from core.linkedinids import (
    _SEPARATOR_CHARS,
    _SEPARATOR_RANGES,
    _ZERO_WIDTH,
    _char_class,
)

#: `hq_blank_trim` trims the separator class from BOTH ENDS (never the middle) after
#: dropping zero-width chars globally. `core.linkedinids.is_blank` strips separators
#: everywhere because it only asks "is this all blank"; a TRIM has to keep the edges
#: distinct, so the class is rebuilt here as an anchored `^…+|…+$`.
_SEP_CLASS = _char_class(_SEPARATOR_CHARS, _SEPARATOR_RANGES)
_EDGE_TRIM = re.compile(f"^{_SEP_CLASS}+|{_SEP_CLASS}+$")

#: NO `$` ANYWHERE IN THIS FILE, and no bare `.`. Both are Python-only divergences
#: from the Postgres mirror, and both were shipped:
#:
#:   * Python's `$` matches BEFORE a trailing newline; Postgres' does not. So
#:     `_PATH`/`_PORT` anchored with `$` would strip `/evil` off `ramp.com\n/evil`,
#:     leaving `ramp.com\n`, which `^…$` then ACCEPTED — this function returning a
#:     "host" containing a newline, which its own docstring swears cannot happen,
#:     while the SQL side answered ''.
#:   * Python's `.` does not match a newline and Postgres' does (PG regexes are
#:     newline-insensitive by default), so `ramp.com/path\nevil.com` lost its path
#:     strip here and kept it there — the same divergence from the other end.
#:
#: `\Z` (end of string, no exceptions), `[\s\S]` (every character, newline included)
#: and `fullmatch` are the three spellings that mean in Python what the SQL means.
_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*://")   # https://  ftp://  …
_PROTOCOL_RELATIVE = re.compile(r"^//")
_USERINFO = re.compile(r"^[^/?#@]*@")            # user:pass@ , before any path
_PATH = re.compile(r"[/?#][\s\S]*\Z")            # path / query / fragment
_PORT = re.compile(r":[0-9]+\Z")
_WWW = re.compile(r"^www\.")

#: Anything outside 7-bit ASCII, refused OUTRIGHT before the fold — the second half
#: of the SQL parity fix, and deliberately a SEPARATE guard from the anchors above.
#:
#: `lower()` is where the two languages stop agreeing about non-ASCII. Executed:
#: `'RAMP.COİ'` (U+0130, dotted capital I) lowercases to `i` + U+0307 in Python — two
#: codepoints, so the host gate refuses it — and to a bare `i` under Postgres'
#: en_US.utf8 collation, which the host gate ACCEPTS as `ramp.coi`. One input, two
#: stored answers, decided by which side ran. Turkish dotless ı, the Greek final
#: sigma and every other locale-dependent fold are the same bug wearing a different
#: character.
#:
#: Refusing non-ASCII outright is the fix both sides can spell identically, and it
#: costs nothing real: the host gate below already admits only `[a-z0-9.-]`, and an
#: internationalized domain reaches us punycoded (`xn--…`), which is ASCII. Applied
#: AFTER `_blank_trim`, so a zero-width or NBSP the trim already removes does not
#: reject an otherwise-good host.
#:
#: It deliberately does NOT cover the control characters `\n`/`\r`/`\t`/`\v`/`\f` —
#: those are ASCII, so they still ride down to the anchors above. Two defects, two
#: guards, two mutations that die independently: widen this class to cover control
#: characters and the `$`-vs-`\Z` mutation stops being caught by anything.
_NON_ASCII = re.compile(r"[^\x00-\x7F]")

#: A hostname: labels of alphanumerics-and-hyphens (never edge hyphens, ≤63 chars)
#: separated by dots, with an ALPHABETIC TLD of 2-63 chars. Matched with `fullmatch`,
#: which is the anchor — see the `$` note above.
#:
#: `[a-z]`, NOT `[a-z0-9]`, is the whole reason an IPv4 literal is refused, and the
#: bound is NOT what does it: `169.254.169.254` (the cloud metadata address) and
#: `192.168.1.10` both have final labels of 2+ characters and sail through an
#: alphanumeric TLD. An earlier version of this comment claimed the length bound
#: caught IPs, `1.2.3.4` was the only IP in the corpus, and its refusal came from the
#: bound rather than from `[a-z]` — so the guard that actually matters was pinned by
#: nothing. Byte-identical to the `~` pattern in `hq_normalize_domain`.
#:
#: THREE RULES REFUSE A NETWORK ADDRESS, and they refuse different ones, so all three
#: are pinned separately in `tests/core/test_domains.py`
#: (`test_a_network_address_is_never_a_company_domain` and its non-vacuity twin):
#:
#:   * `[a-z]` (the TLD): every DOTTED spelling of an address whose final label is
#:     2+ characters — `169.254.169.254`, `192.168.001.010`, and the same metadata
#:     address written `0xa9.0xfe.0xa9.0xfe` (hex) or `0251.0376.0251.0376` (octal),
#:     both of which a resolver accepts and neither of which the length bound sees.
#:   * `{2,63}` (the length bound): the dotted forms ending in a single digit —
#:     `127.0.0.1`, `0.0.0.0`, `1.2.3.4`.
#:   * `(…\.)+` (at least one dot): every FLAT spelling — `localhost`, `2130706433`,
#:     `2852039166`, `0xa9fea9fe`, `017700000001`.
#:
#: IPv6 in every shape (`::1`, `[fd00::1]`, `[::ffff:169.254.169.254]`,
#: `[2001:db8::1]:8080`, `http://[::1]/latest`) dies on the label CLASS instead:
#: neither `:` nor a bracket is in `[a-z0-9-]`.
_HOST = re.compile(r"([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")


def _blank_trim(text: str) -> str:
    """`hq_blank_trim`: drop zero-width chars everywhere, trim the space class off
    both ends. Not `str.strip()` — Python's whitespace set diverges from Postgres'
    `[[:space:]]` in both directions (`core.linkedinids`' note)."""
    return _EDGE_TRIM.sub("", _ZERO_WIDTH.sub("", text or ""))


def normalize_domain(raw: str | None) -> str:
    """A raw domain/URL -> a bare lowercase host, or "" when it is not one.

    `hq_blank_trim`, then the ASCII gate, then `lower()` — trim, refuse, THEN fold,
    which is the SQL's order — then the scheme/protocol-relative/userinfo/path/port/www
    strip chain, then the hostname gate. Returns "" for everything it is not certain is
    a host, and the caller counts that as "no domain to store", never a guess.

    The ASCII gate runs BEFORE `lower()` on purpose: `lower()` is the step whose
    behaviour is locale-dependent and where the two implementations diverge, so the
    only way to keep them identical is to refuse the inputs that make it diverge
    before either side folds anything.
    """
    host = _blank_trim("" if raw is None else str(raw))
    if _NON_ASCII.search(host):
        return ""
    host = host.lower()
    host = _SCHEME.sub("", host, count=1)
    host = _PROTOCOL_RELATIVE.sub("", host, count=1)
    host = _USERINFO.sub("", host, count=1)
    host = _PATH.sub("", host, count=1)
    host = _PORT.sub("", host, count=1)
    host = _WWW.sub("", host, count=1)
    return host if _HOST.fullmatch(host) else ""
