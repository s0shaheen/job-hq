"""The digest job's mail lane — the gates, the interlock, and the failure envelope.

`tests/tracker/test_digest.py` covers the briefing itself and is unchanged by
Phase C3, which is the point: the markdown body the Digest tab receives is
byte-for-byte what it always was, and the email is composed from the same data
beside it.

MUTATION TARGETS (each run red before green):
  * send with the flag unset                    -> the default-off test;
  * ignore `notify_digest`                      -> the channel matrix tests;
  * mail a row that already carries `sent_at`   -> the cron-retry test (row 39);
  * default the recipient to the owner literal  -> the no-recipient test;
  * swallow a send failure                      -> the exit-code + ops tests;
  * fold the sandbox refusal into the generic alert -> the two-titles test;
  * stop stamping `sent_at` after a send        -> the interlock test, which is
    what stops the Apps Script mailing a second copy during the handover.
"""
from __future__ import annotations

import datetime as dt

import pytest

from core import mailer
from core.fakes import fake_hq
from tracker import digest

NOW = dt.datetime(2026, 7, 13, 12, 0, tzinfo=dt.timezone.utc)
TODAY = "2026-07-13"


@pytest.fixture
def spies(monkeypatch):
    alerts = []
    monkeypatch.setattr("core.notify.push", lambda title, body, **kw: True)
    monkeypatch.setattr("core.notify.ops_alert",
                        lambda title, body, **kw: alerts.append((title, body)) or True)
    return alerts


@pytest.fixture
def hq():
    h = fake_hq()
    h.registry["sheet_id"] = "TESTID"
    h.tab("feed").append_records([
        {"key": "greenhouse-1", "company": "Acme", "title": "PM",
         "url": "https://boards.greenhouse.io/acme/jobs/1", "first_seen": TODAY,
         "min_yoe": "2", "location": "Chicago, IL"}])
    return h


@pytest.fixture(autouse=True)
def _recipient(monkeypatch):
    """Every test states the recipient explicitly. Without this the fallback
    would reach the committed registry and the suite would be asserting against
    the operator's real address."""
    monkeypatch.setattr("core.config.registry",
                        lambda user=None: {"owner_email": "owner@example.com"})


def _run(hq, monkeypatch, *, flag="engine", cap=None, **env):
    if flag is None:
        monkeypatch.delenv(digest.MAIL_FLAG_ENV, raising=False)
    else:
        monkeypatch.setenv(digest.MAIL_FLAG_ENV, flag)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    cap = cap if cap is not None else mailer.CaptureMailer()
    return digest.run(hq, now=NOW, mailer_impl=cap), cap


def _sent_cell(hq):
    return next(r["sent_at"] for r in hq.tab("digest").records() if r["date"] == TODAY)


# --------------------------------------------------------------- the gates

def test_the_engine_does_not_mail_until_the_flag_says_so(hq, monkeypatch, spies):
    """The merge default. A branch that starts mailing on merge is a branch that
    double-sends alongside an Apps Script nobody has turned off yet."""
    summary, cap = _run(hq, monkeypatch, flag=None)
    assert summary["mail"]["status"] == "off"
    assert cap.sent == []
    assert summary["body"].startswith("# Job Search HQ — 2026-07-13")   # the row still writes
    assert _sent_cell(hq) == ""


@pytest.mark.parametrize("value", ["off", "", "Engine ", "resend", "true"])
def test_only_the_exact_word_engine_turns_the_lane_on(hq, monkeypatch, spies, value):
    summary, cap = _run(hq, monkeypatch, flag=value)
    assert (summary["mail"]["status"] == "sent") is (value.strip().lower() == "engine")


@pytest.mark.parametrize("channel,mails", [
    ("both", True), ("email", True), ("push", False), ("none", False)])
def test_the_event_matrix_decides_whether_an_email_goes_out(
        hq, monkeypatch, spies, channel, mails):
    """AC24 applies to the email as much as to the push. The Apps Script mailed
    unconditionally to a hardcoded address; this is the first time a person can
    say no to the digest email at all."""
    hq.tab("config").append_records([{"key": "notify_digest", "value": channel}])
    summary, cap = _run(hq, monkeypatch)
    assert bool(cap.sent) is mails
    if not mails:
        assert summary["mail"]["status"] == f"channel:{channel}"


@pytest.mark.parametrize("channel", ["push", "none"])
def test_a_by_policy_skip_stamps_a_sentinel_so_the_watchdog_stays_quiet(
        hq, monkeypatch, spies, channel):
    """C3 review M4. Under DIGEST_EMAIL_SOURCE=engine the Apps Script pages once a
    day for a Digest row with a body and a blank sent_at. A push/none user gets no
    email BY POLICY and must not trip that: the engine stamps a sentinel so the
    row reads as handled, and no ops alert fires from either side."""
    hq.tab("config").append_records([{"key": "notify_digest", "value": channel}])
    summary, cap = _run(hq, monkeypatch)
    assert cap.sent == []
    sentinel = _sent_cell(hq)
    assert sentinel == f"skipped: notify_digest={channel}"
    assert not sentinel.endswith("Z")               # a sentinel, not a fake timestamp
    # No DIGEST alert fired (the fake HQ's missing backup beats page separately
    # and are not this lane's concern).
    assert not [t for t, _ in spies if "digest" in t.lower()]
    # and a same-day re-run reads the sentinel as already-handled, no second stamp
    summary2, cap2 = _run(hq, monkeypatch)
    assert cap2.sent == [] and summary2["mail"]["status"] == "already-sent"


def test_an_email_only_user_still_gets_the_email(hq, monkeypatch, spies):
    """The mirror image of AC24: `notify_channel: email` silences the phone and
    must NOT silence the mailbox."""
    monkeypatch.setattr("core.profile.Profile.load", _profile_loader(
        notify_channel="email", notify_email="dad@example.com"))
    summary, cap = _run(hq, monkeypatch)
    assert [m.to for m in cap.sent] == ["dad@example.com"]


def _profile_loader(**over):
    from core.profile import Profile

    def load(user="", cfg=None):
        prof = Profile(name=user)
        for k, v in over.items():
            setattr(prof, k, v)
        return prof
    return load


# ----------------------------------------------------------- the recipient

def test_notify_email_wins_over_the_registry(hq, monkeypatch, spies):
    monkeypatch.setattr("core.profile.Profile.load",
                        _profile_loader(notify_digest="both", notify_email="dad@example.com"))
    _, cap = _run(hq, monkeypatch)
    assert cap.sent[0].to == "dad@example.com"


def test_a_blank_notify_email_falls_back_to_the_registry_owner(hq, monkeypatch, spies):
    _, cap = _run(hq, monkeypatch)
    assert cap.sent[0].to == "owner@example.com"


def test_no_recipient_anywhere_is_a_loud_refusal_not_a_guess(hq, monkeypatch, spies):
    monkeypatch.setattr("core.config.registry", lambda user=None: {})
    summary, cap = _run(hq, monkeypatch)
    assert cap.sent == []
    assert summary["mail"]["status"] == "no-recipient"
    titles = [t for t, _ in spies]
    assert "HQ digest has no recipient" in titles
    assert "Nobody received today's briefing" in dict(spies)["HQ digest has no recipient"]


# ------------------------------------------------------------ the interlock

def test_a_successful_send_stamps_sent_at(hq, monkeypatch, spies):
    _, cap = _run(hq, monkeypatch)
    assert len(cap.sent) == 1
    assert _sent_cell(hq).endswith("Z")


def test_a_cron_retry_the_same_day_does_not_send_twice(hq, monkeypatch, spies):
    """Matrix row 39, on state the sheet has had since the Apps Script era —
    no `digest_sends` table required."""
    _, cap = _run(hq, monkeypatch)
    summary, cap2 = _run(hq, monkeypatch)
    assert cap2.sent == []
    assert summary["mail"]["status"] == "already-sent"
    assert summary["body"], "the body is still refreshed on a re-run"


def test_a_row_the_apps_script_already_mailed_is_left_alone(hq, monkeypatch, spies):
    """The other direction of the handover: the script is still the mailer and
    got there first. Neither side mails a stamped row."""
    hq.tab("digest").append_records(
        [{"date": TODAY, "body": "yesterday's compose", "sent_at": "2026-07-13 12:01:00Z"}])
    summary, cap = _run(hq, monkeypatch)
    assert cap.sent == [] and summary["mail"]["status"] == "already-sent"


def test_a_send_that_cannot_be_stamped_pages_rather_than_passing_quietly(
        hq, monkeypatch, spies):
    real = hq.tab("digest").set_by_key

    def boom(key, values, **kw):
        if "sent_at" in values:
            raise RuntimeError("grid limit")
        return real(key, values, **kw)

    monkeypatch.setattr(hq.tab("digest"), "set_by_key", boom)
    summary, cap = _run(hq, monkeypatch)
    assert len(cap.sent) == 1
    assert summary["mail"]["status"] == "sent"
    assert spies[0][0] == "HQ digest sent but unstamped"


# -------------------------------------------------------- failure envelope

def test_a_sandbox_refusal_gets_its_own_alert_title(hq, monkeypatch, spies):
    cap = mailer.CaptureMailer(fail_with=mailer.AddressNotVerified("dad@example.com"))
    summary, _ = _run(hq, monkeypatch, cap=cap)
    assert summary["mail"]["status"] == "failed"
    assert spies[0][0] == "HQ digest email refused (unverified address)"
    assert "verify the identity in SES" in spies[0][1]


def test_any_other_send_failure_is_the_generic_alert(hq, monkeypatch, spies):
    cap = mailer.CaptureMailer(fail_with=mailer.MailSendFailed("SES Throttling: slow down"))
    summary, _ = _run(hq, monkeypatch, cap=cap)
    assert spies[0][0] == "HQ digest email failed"
    assert "Throttling" in spies[0][1]


def test_a_failed_send_never_costs_the_briefing_or_the_watchdogs(hq, monkeypatch, spies):
    """The digest job carries the Gmail-capture and backups watchdogs. Letting a
    mail failure abort the run would blind both, which is the same mistake the
    pg-beats read made and had to be walked back."""
    hq.tab("config").append_records([{"key": "heartbeat_capture", "value": "2026-07-13 05:00:00Z"}])
    cap = mailer.CaptureMailer(fail_with=mailer.MailSendFailed("nope"))
    summary, _ = _run(hq, monkeypatch, cap=cap)
    assert summary["body"].startswith("# Job Search HQ")
    assert summary["capture_silent"] is True
    assert "Gmail capture silent" in [t for t, _ in spies]
    assert _sent_cell(hq) == "", "an unsent digest must stay unstamped"


def test_a_blank_key_feed_row_fails_the_email_loudly_but_not_the_briefing(hq, monkeypatch, spies):
    """C3 review M3, the CRITICAL one. A Feed row with a blank `key` reaches the
    digest (a partial write, a hand-edit); with links armed, minting its token
    would raise. That raise must NOT escape `_mail`: the digest-tab row and BOTH
    watchdog beats run after the email in `run()`, and blinding them over an
    email is the pg-beats mistake walked back once already.

    The role still renders (minus its two buttons), so this specific row does not
    even fail the email — the guard skips it. The louder half of the contract is
    proven by the sibling test: if compose DID raise, it is a named ops push and
    a nonzero exit, and the beats still beat."""
    hq.tab("feed").append_records([
        {"key": "", "company": "Blankey", "title": "PM", "url": "",
         "first_seen": TODAY, "min_yoe": "1"}])
    monkeypatch.setattr(digest, "_pg_user_id", lambda user="": "7c9e6679-7425-40de-944b-e07fc1f90ae7")
    summary, cap = _run(hq, monkeypatch, HQ_WEBAPP_URL="https://hq.example.com",
                        HQ_DIGEST_KEYS="k1:" + "a" * 48)
    assert summary["mail"]["status"] == "sent"      # the keyless row did not raise
    html = cap.sent[0].html
    assert "Blankey" in html                         # it still renders
    assert html.count('href="https://hq.example.com/d/') == 2  # only Acme's two links
    assert _sent_cell(hq).endswith("Z")              # heartbeat interlock ran
    assert summary["body"].startswith("# Job Search HQ")


def test_a_compose_crash_is_named_and_nonfatal(hq, monkeypatch, spies):
    """The general half of M3: whatever reaches compose and raises — not just a
    MailError — is a named ops push and a nonzero exit, and the row plus both
    watchdogs still run. Proven by forcing compose to raise."""
    hq.tab("config").append_records([{"key": "heartbeat_capture", "value": "2026-07-13 05:00:00Z"}])

    def boom(*a, **k):
        raise RuntimeError("renderer blew up")
    monkeypatch.setattr(digest.digest_email, "compose", boom)
    summary, cap = _run(hq, monkeypatch)
    assert cap.sent == []
    assert summary["mail"]["status"] == "failed"
    assert summary["mail"]["error"].startswith("composing the digest email raised RuntimeError")
    assert "HQ digest email failed" in [t for t, _ in spies]
    # the briefing and its watchdogs survived the crash
    assert summary["body"].startswith("# Job Search HQ")
    assert summary["capture_silent"] is True
    assert "Gmail capture silent" in [t for t, _ in spies]
    assert _sent_cell(hq) == ""                       # unsent stays unstamped
    # and the digest's own heartbeat still beat: run() reaches hq.heartbeat("digest")
    # only if _mail did not raise past it.
    beats = {r["key"]: r["value"] for r in hq.tab("config").records()}
    assert beats.get("heartbeat_digest", "").endswith("Z")


def test_a_compose_crash_still_exits_nonzero(hq, monkeypatch, spies, capsys):
    monkeypatch.setattr("core.sheets.HQ.open", classmethod(lambda cls, user=None: hq))
    monkeypatch.setenv(digest.MAIL_FLAG_ENV, "engine")
    monkeypatch.setattr(mailer, "SesMailer", lambda **kw: mailer.CaptureMailer())

    def boom(*a, **k):
        raise RuntimeError("kaboom")
    monkeypatch.setattr(digest.digest_email, "compose", boom)
    assert digest.main() == 1
    assert "mail=failed" in capsys.readouterr().out


def test_the_exit_code_reports_the_send(hq, monkeypatch, spies, capsys):
    monkeypatch.setattr("core.sheets.HQ.open", classmethod(lambda cls, user=None: hq))
    monkeypatch.setenv(digest.MAIL_FLAG_ENV, "engine")
    monkeypatch.setattr(mailer, "SesMailer", lambda **kw: mailer.CaptureMailer())
    assert digest.main() == 0
    assert "mail=sent" in capsys.readouterr().out

    hq2 = fake_hq()
    monkeypatch.setattr("core.sheets.HQ.open", classmethod(lambda cls, user=None: hq2))
    monkeypatch.setattr(mailer, "SesMailer",
                        lambda **kw: mailer.CaptureMailer(fail_with=mailer.MailSendFailed("x")))
    assert digest.main() == 1


def test_the_token_user_comes_from_hq_user_not_the_ambient_env(monkeypatch):
    """C3 review m2. The link's user must resolve from the same `hq.user` the
    recipient and the sheet do, never from the ambient `HQ_USER` — or
    `digest.run(HQ.open("dad"))` in a process pointed at someone else mints dad's
    links against another user's `user_postings`."""
    seen = []
    monkeypatch.setattr("core.pgwrites.user_id", lambda user=None: seen.append(user) or "uid")
    assert digest._pg_user_id("dad") == "uid"
    assert seen == ["dad"]


# ------------------------------------------------------------- the content

def test_the_email_carries_the_same_picture_as_the_row(hq, monkeypatch, spies):
    summary, cap = _run(hq, monkeypatch)
    (msg,) = cap.sent
    assert msg.subject == "Job Search HQ — Mon 13 Jul: 1 new role"
    assert "Acme" in msg.html and "Acme" in msg.text
    assert "Acme" in summary["body"]


def test_links_are_absent_until_the_store_and_the_origin_exist(hq, monkeypatch, spies):
    _, cap = _run(hq, monkeypatch)
    assert "/d/" not in cap.sent[0].html
    assert "One-click links are off" in cap.sent[0].html


def test_links_appear_once_the_origin_key_and_user_are_all_present(hq, monkeypatch, spies):
    monkeypatch.setattr(digest, "_pg_user_id",
                        lambda user="": "7c9e6679-7425-40de-944b-e07fc1f90ae7")
    _, cap = _run(hq, monkeypatch, HQ_WEBAPP_URL="https://hq.example.com",
                  HQ_DIGEST_KEYS="k1:" + "a" * 48)
    html = cap.sent[0].html
    assert html.count('href="https://hq.example.com/d/') == 2
    assert "One-click links are off" not in html
