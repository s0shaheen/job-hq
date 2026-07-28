"""The composed digest email — HTML and text, as a pure function.

The failure modes here are all *rendering* failures, and every one of them is a
matrix row in docs/plans/PHASE-DIGEST.md §7. They are cheap to test and
expensive to discover: nobody notices a broken digest email until the person who
was supposed to read it stops mentioning it.

MUTATION TARGETS (each run red before green):
  * emit one action link per row instead of two   -> the two-links test;
  * drop the href check on the posting url        -> the hostile-url test;
  * emit a relative `/d/…` when the origin is unset -> row 29's test;
  * drop the byte cap                             -> the Gmail-clip test;
  * add a `<style>` block or `display:flex`       -> the Outlook test;
  * leave one container without an explicit color -> the dark-mode test;
  * shrink the action buttons                     -> the tap-target test;
  * sign every user's links with one user id      -> the isolation test.
"""
from __future__ import annotations

import datetime as dt
import re

import pytest

from core import digest_email as de
from core import digest_links as dl

KEYS = [("k1", "a" * 48)]
BASE = "https://hq.example.com"
NOW = dt.datetime(2026, 7, 27, 11, 40, tzinfo=dt.timezone.utc)
USER = "7c9e6679-7425-40de-944b-e07fc1f90ae7"


def _role(n: int = 1, **over) -> de.Role:
    base = {"key": f"greenhouse-{n}", "company": f"Acme {n}", "title": "Product Manager",
            "url": f"https://boards.greenhouse.io/acme/jobs/{n}", "location": "Chicago, IL"}
    base.update(over)
    return de.Role(**base)


def _data(roles=None, total=None, **over) -> de.DigestData:
    roles = [_role()] if roles is None else roles
    base = {"date": "2026-07-27", "roles": roles,
            "roles_total": len(roles) if total is None else total,
            "changes": ["join advanced_status `greenhouse-2`: Applied -> Screen"],
            "review": ["Thanks for applying"], "review_total": 1,
            "followups": ["OldCo — PM (applied 2026-06-01; 31d silent)"], "followups_total": 1,
            "scout": [], "health": ["✅ all systems ran on schedule"]}
    base.update(over)
    return de.DigestData(**base)


def _compose(data=None, **over):
    kwargs = {"user_id": USER, "base_url": BASE, "keys": KEYS, "now": NOW}
    kwargs.update(over)
    return de.compose(data or _data(), **kwargs)


# ------------------------------------------------------------------- links

def test_every_role_carries_exactly_two_action_links():
    email = _compose(_data([_role(1), _role(2), _role(3)]))
    hrefs = re.findall(r'href="(https://hq\.example\.com/d/[^"]+)"', email.html)
    assert len(hrefs) == 6
    actions = [dl.verify(h.rsplit("/d/", 1)[1], keys=KEYS, now=NOW).action for h in hrefs]
    assert actions == ["interested", "dismissed"] * 3


def test_each_link_is_signed_for_its_own_posting():
    email = _compose(_data([_role(1), _role(2)]))
    keys_seen = {dl.verify(h.rsplit("/d/", 1)[1], keys=KEYS, now=NOW).posting_key
                 for h in re.findall(r'href="(https://hq\.example\.com/d/[^"]+)"', email.html)}
    assert keys_seen == {"greenhouse-1", "greenhouse-2"}


def test_two_users_composed_in_one_run_do_not_share_a_token():
    """The multi-user leak class (matrix row 38). Two people, one process, one
    loop: the user id has to come from the row being composed, not from a
    module-level default that the second iteration inherits."""
    other = "11111111-2222-3333-4444-555555555555"
    a = _compose(_data([_role(1)]))
    b = _compose(_data([_role(1)]), user_id=other)
    seen = [dl.verify(re.search(r"/d/([^\"]+)", e.html).group(1),
                      keys=KEYS, now=NOW).user_id for e in (a, b)]
    assert seen == [USER, other]


@pytest.mark.parametrize("missing,kwargs", [
    ("HQ_WEBAPP_URL", {"base_url": ""}),
    ("HQ_DIGEST_KEYS", {"keys": []}),
    ("a pg user id", {"user_id": ""}),
])
def test_a_missing_piece_omits_every_link_and_says_which(missing, kwargs):
    """Matrix row 29. The alternative — a relative `/d/…`, or a link signed with
    no key — is a live button in a real inbox that does nothing."""
    email = _compose(**kwargs)
    assert "/d/" not in email.html and "/d/" not in email.text
    assert missing in email.html and missing in email.text
    assert "One-click links are off" in email.html


def test_a_hostile_posting_url_renders_as_text_with_no_link():
    """`postings.url` reaches here from an ATS adapter and, on the capture path,
    from an LLM reading an untrusted email body — the C2 review's P-2."""
    email = _compose(_data([_role(1, url="javascript:alert(1)"),
                            _role(2, url="https://www.google.com@evil.example")]))
    assert "javascript:" not in email.html
    assert "evil.example" not in email.html
    assert "Acme 1" in email.html and "Acme 2" in email.html   # the row survives
    assert len(re.findall(r'href="https://hq\.example\.com/d/', email.html)) == 4


def test_the_posting_url_is_linked_when_it_is_clean():
    email = _compose()
    assert 'href="https://boards.greenhouse.io/acme/jobs/1"' in email.html


# ------------------------------------------------------- the Outlook rules

def test_no_stylesheet_no_flex_no_grid():
    """Outlook renders with Word's engine: no flex, no grid, and a `<style>`
    block it may drop entirely (matrix row 31)."""
    html = _compose(_data([_role(i) for i in range(1, 6)])).html
    for banned in ("<style", "display:flex", "display: flex", "display:grid",
                   "display: grid", "<link", 'rel="stylesheet"', "class="):
        assert banned not in html, banned


def test_layout_is_tables_only():
    html = _compose().html
    assert html.count('role="presentation"') >= 3
    assert "<div" not in html


def test_every_container_states_both_a_background_and_a_colour():
    """Matrix row 33: a dark-mode client that finds one unset inverts the
    container and leaves the text, and the digest becomes white-on-white."""
    html = _compose().html
    for block in re.findall(r'style="([^"]*background:[^"]*)"', html):
        assert "color:" in block, block
    assert 'content="light dark"' in html


def test_the_action_buttons_are_tappable_and_separated():
    html = _compose().html
    buttons = re.findall(r'<a href="https://hq\.example\.com/d/[^"]+" style="([^"]+)"', html)
    assert len(buttons) == 2
    for style in buttons:
        assert "min-height:44px" in style
        assert "display:block" in style
    assert "padding:0 6px 0 0" in html and "padding:0 0 0 6px" in html   # 12px gutter


def test_the_body_stays_under_the_gmail_clip_and_says_what_it_dropped():
    """Gmail clips near 102 KB and clips from the BOTTOM, so the first casualties
    are the footer and the last roles — silently (matrix row 30)."""
    many = [_role(i, title="Senior Product Manager, Payments Platform") for i in range(1, 400)]
    email = _compose(_data(many))
    assert len(email.html.encode()) <= de.MAX_HTML_BYTES
    assert "more in the app" in email.html
    assert "trimmed to fit" in email.html


def test_the_row_cap_is_stated_when_the_caller_already_capped():
    email = _compose(_data([_role(1), _role(2)], total=27))
    assert "+25 more in the app" in email.html
    assert "trimmed to fit" not in email.html      # the composer dropped nothing


def test_without_an_origin_the_overflow_points_at_the_sheet():
    email = _compose(_data([_role(1)], total=9), base_url="")
    assert "+8 more in the Feed tab" in email.html


# ------------------------------------------------------------------- text

def test_the_text_part_carries_the_same_links_and_the_same_sections():
    email = _compose()
    assert email.text.count("https://hq.example.com/d/") == 2
    assert "Interested: https://hq.example.com/d/" in email.text
    assert "NEW ROLES (last 24h)" in email.text
    assert "AUTOMATION HEALTH" in email.text
    assert "<" not in email.text


def test_html_is_escaped_not_injected():
    email = _compose(_data([_role(1, company='Acme <script>alert("x")</script>')]))
    assert "<script>" not in email.html
    assert "&lt;script&gt;" in email.html


# ---------------------------------------------------------------- subject

@pytest.mark.parametrize("data,expected", [
    (_data(), "Job Search HQ — Mon 27 Jul: 1 new role, 1 update, 1 to review"),
    (_data([], total=0, changes=[], review=[], review_total=0),
     "Job Search HQ — Mon 27 Jul: nothing new"),
    (_data([_role(1), _role(2)], changes=[], review=[], review_total=0),
     "Job Search HQ — Mon 27 Jul: 2 new roles"),
])
def test_the_subject_leads_with_the_date_then_the_two_numbers(data, expected):
    """The date is not decoration: identical subjects thread a week of digests
    into one Gmail row, which hides every day but the first."""
    assert de.subject_for(data) == expected


@pytest.mark.parametrize("kwargs", [{}, {"base_url": ""}])
def test_every_digest_says_how_to_stop_it(kwargs):
    """There is no `List-Unsubscribe` header yet (increment 6). Naming the
    Config cell is the honest substitute in a system whose settings are a
    phone-editable spreadsheet, and it must survive the link-status note rather
    than being replaced by it."""
    email = _compose(**kwargs)
    assert "set notify_digest to push or none in the Config tab" in email.html
    assert "set notify_digest to push or none in the Config tab" in email.text


def test_sections_with_nothing_to_say_are_absent_from_both_parts():
    email = _compose(_data([], total=0, changes=[], review=[], review_total=0,
                           followups=[], followups_total=0))
    assert "Status changes" not in email.html and "STATUS CHANGES" not in email.text
    assert "Automation health" in email.html
