"""`core.domains.normalize_domain` — the canonicalizer, and everything it refuses.

The claim is one sentence — a WRONG domain is worse than a missing one — so most of
these prove a refusal, not an acceptance. The corpus below (`DOMAIN_CASES`) is shared
with `tests/db/test_company_domain.py`, which runs the SAME strings through the SQL
mirror `hq_normalize_domain` inside real Postgres: a divergence in either direction
fails there, the `core.linkedinids.is_blank` parity pattern.
"""
from __future__ import annotations

import re

import pytest

from core.domains import normalize_domain

#: (raw, expected) — the canonicalizer's contract, and the db parity corpus. Every
#: entry is a shape a provider payload or a paste actually delivers a host in, or a
#: near-miss that MUST be refused ("" ) because storing it would render a wrong logo.
DOMAIN_CASES: list[tuple[str, str]] = [
    # bare hosts, untouched
    ("ramp.com", "ramp.com"),
    ("jobs.ashbyhq.com", "jobs.ashbyhq.com"),
    ("northern-trust.co.uk", "northern-trust.co.uk"),
    # case + edge whitespace + a zero-width prefix all fold to one value
    ("Ramp.COM", "ramp.com"),
    ("  ramp.com  ", "ramp.com"),
    ("﻿ramp.com", "ramp.com"),
    ("ramp.com\n", "ramp.com"),
    # a scheme, a protocol-relative prefix
    ("https://ramp.com", "ramp.com"),
    ("http://ramp.com", "ramp.com"),
    ("//ramp.com", "ramp.com"),
    # a path / query / fragment is cut
    ("https://ramp.com/careers/123", "ramp.com"),
    ("ramp.com/careers", "ramp.com"),
    ("ramp.com?utm_source=x", "ramp.com"),
    ("ramp.com#top", "ramp.com"),
    ("https://ramp.com/../evil.com", "ramp.com"),
    # a port
    ("ramp.com:8080", "ramp.com"),
    # userinfo (with and without a scheme), before the path
    ("user@ramp.com", "ramp.com"),
    ("https://user:pass@ramp.com/x", "ramp.com"),
    # a leading www. — noise that would split one company's logo into two
    ("www.ramp.com", "ramp.com"),
    ("https://www.ramp.com/jobs", "ramp.com"),
    # ---- refused: not a plausible host, so "" and the caller stores nothing ----
    ("", ""),
    ("   ", ""),
    ("ramp", ""),                       # no dot
    ("localhost", ""),                  # no dot
    ("ramp.c", ""),                     # 1-char TLD
    ("-ramp.com", ""),                  # label may not start with a hyphen
    ("ramp-.com", ""),                  # label may not end with a hyphen
    ("ram p.com", ""),                  # embedded space
    ("ramp..com", ""),                  # empty label
    ("javascript:alert(1)", ""),        # not a scheme we strip; not a host
    ("http://", ""),                    # scheme and nothing else

    # ---- IPs and numeric TLDs: refused by the ALPHABETIC TLD rule, not by length --
    #
    # These four exist because the alphabetic-TLD rule was previously pinned by
    # NOTHING. The only IP in the corpus was `1.2.3.4`, whose final label is one
    # character — so it is refused by the `{2,63}` LENGTH bound, and widening the TLD
    # to `[a-z0-9]{2,63}` (killing the rule that actually refuses IPs) passed the
    # entire suite on both sides while `normalize_domain` began accepting the cloud
    # metadata address. Every row below has a 2+ character final label, so ONLY
    # `[a-z]` can refuse it.
    ("1.2.3.4", ""),                    # refused by the length bound
    ("169.254.169.254", ""),            # refused ONLY by [a-z] — cloud metadata
    ("192.168.1.10", ""),               # refused ONLY by [a-z] — RFC1918
    ("1.2.3.44", ""),                   # refused ONLY by [a-z]
    ("ramp.c0m", ""),                   # a numeric-bearing TLD is not a TLD
    ("10.0.0.1:8080", ""),              # …and a port does not make it one

    # ---- the REST of the network-address space ----------------------------------
    #
    # `169.254.169.254` above is only ONE spelling of the cloud metadata address.
    # A resolver accepts at least four: dotted-decimal, flat decimal (2852039166),
    # flat hex (0xa9fea9fe) and dotted hex/octal — and IPv6 is a fifth shape that
    # looks nothing like any of them. A network address is never a company, has no
    # logo, and in this column is an upstream bug; the ones that also name a
    # loopback or a link-local address are the SSRF-shaped half, because this string
    # is what a URL gets built from downstream.
    #
    # Each row names WHICH rule refuses it. A rule nothing names is a rule the next
    # mutation deletes for free — which is exactly how the alphabetic-TLD rule came
    # to be pinned by nothing (see test_an_ip_literal_is_refused).
    ("::1", ""),                        # the label class: no ':' in a label
    ("[::1]", ""),                      # …nor brackets
    ("[fd00::1]", ""),                  # RFC4193 unique-local
    ("[fe80::1%25eth0]", ""),           # link-local with a percent-encoded zone id
    ("[::ffff:169.254.169.254]", ""),   # IPv4-mapped IPv6 — the metadata address again
    ("[2001:db8::1]:8080", ""),         # …with a port
    ("http://[::1]/latest", ""),        # …behind a scheme and a path
    ("127.0.0.1", ""),                  # the LENGTH bound (final label is 1 char)
    ("0.0.0.0", ""),                    # the length bound
    ("2130706433", ""),                 # flat decimal loopback — the DOT rule
    ("2852039166", ""),                 # flat decimal metadata address — the dot rule
    ("0xa9fea9fe", ""),                 # flat hex metadata address — the dot rule
    ("017700000001", ""),               # flat octal loopback — the dot rule
    ("0xa9.0xfe.0xa9.0xfe", ""),        # <<< dotted HEX: ONLY [a-z] refuses this
    ("0251.0376.0251.0376", ""),        # <<< dotted OCTAL: ONLY [a-z] refuses this
    ("192.168.001.010", ""),            # <<< zero-padded RFC1918: ONLY [a-z]

    # ---- ASCII control characters: the `$`-vs-`\Z` class -------------------------
    #
    # Python's `$` matches BEFORE a trailing newline and Postgres' does not, and
    # Python's `.` does NOT match a newline while Postgres' does. Both were live:
    # `ramp.com\n/evil` came out of the Python mirror as `'ramp.com\n'` (a "host"
    # with a newline in it) while SQL answered ''; `ramp.com/path\nevil.com` lost its
    # path strip in Python and kept it in SQL. Executed against PG16 here.
    #
    # These are ASCII, so the ASCII gate above deliberately does NOT catch them —
    # they reach the anchors, which is what keeps the `$` mutation killable.
    ("\nramp.com", "ramp.com"),         # leading: hq_blank_trim removes it
    ("ramp.com\n", "ramp.com"),         # trailing: same
    ("\r\nramp.com\r\n", "ramp.com"),
    ("\tramp.com\t", "ramp.com"),
    ("\x0bramp.com\x0c", "ramp.com"),   # vertical tab / form feed, both [[:space:]]
    ("ramp\n.com", ""),                 # MIDDLE: not trimmed, not a host
    ("ramp\t.com", ""),
    ("ramp.com\n/evil", ""),            # <<< the shipped defect: py gave 'ramp.com\n'
    ("ramp.com\n:8080", ""),
    ("ramp.com\n?q=1", ""),
    ("ramp.com\n#f", ""),
    ("www.ramp.com\n/x", ""),
    ("ramp.com\r/evil", ""),
    ("ramp.com\t/evil", ""),
    ("ramp.com/path\nevil.com", "ramp.com"),   # the other direction: py lost this
    ("https://ramp.com/a\nb", "ramp.com"),
    ("ramp.com?a\nb", "ramp.com"),
    ("ramp.com#a\nb", "ramp.com"),

    # ---- non-ASCII: the locale-dependent `lower()` class ------------------------
    #
    # `lower()` is the one step whose behaviour differs between the two languages.
    # Executed: PG lower('RAMP.CO'||chr(304)) is 'ramp.coi' (the combining dot
    # DROPPED, and the host gate accepts it) while Python yields 'i' + U+0307 and
    # refuses. Both sides now refuse non-ASCII outright, before folding anything.
    ("café.com", ""),                   # non-ASCII host (punycode is not our job)
    ("RAMP.COİ", ""),              # <<< dotted capital I: sql said 'ramp.coi'
    ("ramp.coİ", ""),
    ("İ.com", ""),
    ("ramp.comı", ""),             # Turkish dotless i
    ("Σramp.com", ""),             # Greek capital sigma (two lowercase forms)
    ("рамп.com", ""),                   # Cyrillic
    ("ramp．com", ""),              # fullwidth full stop, not a dot
    # …while a punycoded IDN is pure ASCII and rides straight through.
    ("xn--caf-dma.com", "xn--caf-dma.com"),
]


@pytest.mark.parametrize("raw,expected", DOMAIN_CASES, ids=lambda v: repr(v))
def test_normalize_domain(raw, expected):
    assert normalize_domain(raw) == expected


def test_none_is_empty_not_a_crash():
    """The provider's JSON serves a missing field as null; the harvest passes it
    straight through, so None must answer '' rather than raise."""
    assert normalize_domain(None) == ""


def test_a_leading_www_is_stripped():
    """MUTATION REASON: drop the `^www\\.` step and `www.ramp.com` stays
    `www.ramp.com`, so the same company harvested as `ramp.com` from one row and
    `www.ramp.com` from another renders two different logos."""
    assert normalize_domain("www.ramp.com") == "ramp.com"
    # but `www` is only stripped as a leading LABEL, never mid-host
    assert normalize_domain("wwwramp.com") == "wwwramp.com"


def test_an_ip_literal_is_refused():
    """MUTATION REASON: loosen the TLD to `[a-z0-9]{2,63}` — on EITHER side — and
    `169.254.169.254`, `192.168.1.10`, `1.2.3.44` and `ramp.c0m` all start passing.

    The previous version of this docstring claimed that mutation made `1.2.3.4` pass.
    It does not: `1.2.3.4`'s final label is ONE character, so the `{2,63}` length
    bound refuses it no matter what the character class says. `1.2.3.4` was the only
    IP in the corpus, so the alphabetic-TLD rule — the thing that actually refuses an
    IP — was pinned by nothing on either side, and an adversarial review applied
    exactly the mutation this docstring named and watched 123 python + 33 db tests
    pass while the function accepted the cloud metadata address.

    Every address below has a 2+ character final label. Only `[a-z]` can refuse them.
    """
    assert normalize_domain("1.2.3.4") == ""            # the length bound
    assert normalize_domain("169.254.169.254") == ""    # only [a-z] — cloud metadata
    assert normalize_domain("192.168.1.10") == ""       # only [a-z] — RFC1918
    assert normalize_domain("1.2.3.44") == ""           # only [a-z]
    assert normalize_domain("ramp.c0m") == ""           # only [a-z]
    assert normalize_domain("10.0.0.1:8080") == ""


#: Every spelling of a NETWORK ADDRESS this canonicalizer must refuse, grouped by
#: the rule that does the refusing. Split out of the corpus so the two facts a
#: mutation needs — "it is refused" and "BY THIS RULE" — are asserted separately;
#: the corpus alone can only say the first, which is how a rule that refuses
#: nothing survives a green suite.
_ONLY_THE_ALPHABETIC_TLD_REFUSES = [
    "169.254.169.254",          # dotted decimal, cloud metadata
    "192.168.1.10",             # dotted decimal, RFC1918
    "192.168.001.010",          # …zero-padded, which a resolver still accepts
    "0xa9.0xfe.0xa9.0xfe",      # dotted hex, the same metadata address
    "0251.0376.0251.0376",      # dotted octal, the same metadata address
    "1.2.3.44",
]

_OTHER_RULES_REFUSE = [
    ("127.0.0.1", "the {2,63} length bound — final label is one character"),
    ("0.0.0.0", "the length bound"),
    ("1.2.3.4", "the length bound"),
    ("localhost", "the dot rule — a bare label is not a host"),
    ("2130706433", "the dot rule — flat decimal loopback"),
    ("2852039166", "the dot rule — flat decimal metadata address"),
    ("0xa9fea9fe", "the dot rule — flat hex metadata address"),
    ("017700000001", "the dot rule — flat octal loopback"),
    ("::1", "the label class — ':' is not in [a-z0-9-]"),
    ("[::1]", "the label class — brackets are not either"),
    ("[fd00::1]", "the label class"),
    ("[fe80::1%25eth0]", "the label class"),
    ("[::ffff:169.254.169.254]", "the label class"),
    ("[2001:db8::1]:8080", "the label class, after the port strip"),
    ("http://[::1]/latest", "the label class, after the scheme and path strips"),
]


def test_a_network_address_is_never_a_company_domain():
    """No spelling of a network address may reach this column.

    MUTATION REASON, and the reason this test is separate from the corpus: widen the
    TLD to `[a-z0-9]{2,63}` — the mutation the docstring below names — and every
    entry in `_ONLY_THE_ALPHABETIC_TLD_REFUSES` starts being ACCEPTED, including the
    cloud metadata address in three different spellings. Nothing else in either
    suite notices, because every other network address here is refused by the length
    bound, the dot rule or the label class, and those three rules are untouched by
    that mutation.

    The dotted hex and dotted octal rows are the ones the earlier corpus could not
    have caught even in principle: `0xa9.0xfe.0xa9.0xfe` and `0251.0376.0251.0376`
    both resolve to 169.254.169.254 and both have 4-character final labels, so the
    length bound never sees them.
    """
    for raw in _ONLY_THE_ALPHABETIC_TLD_REFUSES:
        assert normalize_domain(raw) == "", f"{raw} — only [a-z] can refuse this"
    for raw, why in _OTHER_RULES_REFUSE:
        assert normalize_domain(raw) == "", f"{raw} — expected refusal by {why}"


def test_the_alphabetic_tld_rule_is_the_only_thing_refusing_those_addresses():
    """Non-vacuity for the list above, asserted rather than claimed.

    Applies the named mutation to a LOCAL copy of the host pattern and proves each
    `_ONLY_THE_ALPHABETIC_TLD_REFUSES` entry passes it — so if somebody ever widens
    the real `_HOST` and the corpus happens to stay green, this test still names the
    rows that changed meaning. The counterexample the review executed by hand, kept
    in the suite instead.
    """
    import core.domains as domains

    widened = re.compile(r"([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]{2,63}")
    for raw in _ONLY_THE_ALPHABETIC_TLD_REFUSES:
        assert widened.fullmatch(raw), (
            f"{raw} is refused by some OTHER rule too, so it does not pin [a-z]"
        )
    # …and the shipped pattern is the one that refuses them.
    for raw in _ONLY_THE_ALPHABETIC_TLD_REFUSES:
        assert not domains._HOST.fullmatch(raw)


def test_a_control_character_can_never_survive_into_a_host():
    """MUTATION REASON: revert `_PATH`/`_PORT` to `$` (or `_HOST.fullmatch` to
    `.match`) and `normalize_domain("ramp.com\\n/evil")` returns `'ramp.com\\n'` — a
    value carrying a newline out of a function whose docstring swears it emits only a
    bare host, and one the SQL door refuses, so the two implementations disagree.

    Python's `$` matches before a trailing newline; Postgres' does not. This is the
    defect an adversarial review executed on the shipped code, and it reached
    `p_domain` on the wire through `harvest_all_domains`.
    """
    for raw in ("ramp.com\n/evil", "ramp.com\n:8080", "ramp.com\n?q=1",
                "ramp.com\n#f", "www.ramp.com\n/x", "ramp.com\r/evil"):
        assert normalize_domain(raw) == "", raw
    # Nothing this function returns may contain a character outside the host class.
    for raw, expected in DOMAIN_CASES:
        assert expected == "" or "\n" not in expected
        assert normalize_domain(raw) == expected


def test_the_path_strip_consumes_newlines_the_way_postgres_does():
    """MUTATION REASON: revert `_PATH` to `[/?#].*$` and this returns `''` where the
    SQL returns `'ramp.com'` — Python's `.` does not match a newline and Postgres'
    does, so the path strip silently stopped at the newline and the leftover failed
    the host gate. The same divergence as above, from the opposite direction: there
    we emitted a bad host, here we threw a good one away.
    """
    assert normalize_domain("ramp.com/path\nevil.com") == "ramp.com"
    assert normalize_domain("https://ramp.com/a\nb") == "ramp.com"


def test_non_ascii_is_refused_before_the_locale_dependent_fold():
    """MUTATION REASON: delete the `_NON_ASCII` gate and `RAMP.COİ` returns `''` here
    while `hq_normalize_domain` returns `'ramp.coi'` — executed against PG16,
    `lower('RAMP.CO'||chr(304))` DROPS the combining dot and the host gate accepts the
    result, where Python's `str.lower()` keeps it as `i` + U+0307 and refuses. One
    input, two stored answers, decided by which side ran.

    The gate is deliberately non-ASCII and NOT non-printable: `\\n` is ASCII, so it
    still reaches the anchors, which is what keeps the `$` mutation above killable.
    """
    for raw in ("RAMP.COİ", "ramp.coİ", "İ.com", "ramp.comı", "Σramp.com", "café.com"):
        assert normalize_domain(raw) == "", raw
    # A punycoded IDN is pure ASCII and is the supported way to spell one.
    assert normalize_domain("xn--caf-dma.com") == "xn--caf-dma.com"


def test_the_path_is_cut_before_it_can_masquerade_as_a_host():
    """A URL with a path reduces to its host; the path never leaks into the stored
    value. MUTATION REASON: drop the `[/?#].*$` cut and `ramp.com/evil` is stored
    whole and fails the host gate, losing a domain we could have had."""
    assert normalize_domain("https://ramp.com/a/b/c?q=1#f") == "ramp.com"


def test_it_never_invents_a_host_from_garbage():
    """The whole point: anything it is not sure is a host answers '', and the caller
    counts that as 'no domain', never a guess."""
    for junk in ("not a domain", "ramp", "@@@", "://", "..", "http://"):
        assert normalize_domain(junk) == ""
