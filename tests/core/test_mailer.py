"""The SES transport, with a fake that is not kinder than SES.

`Rules that already cost a production incident` #3: a fake more forgiving than
the real API hides the bug it exists to catch. So `FakeSes` raises the SHAPE
botocore raises — an exception carrying `.response["Error"]["Code"]` — and
`_classify` reads that shape rather than `isinstance(e, ClientError)`. The last
test in this file proves the two agree by building a REAL `ClientError` when
botocore happens to be installed.

MUTATION TARGETS (each run red before green):
  * classify `MessageRejected` as a generic failure -> the sandbox test, which
    is the point of the whole class (the #1 support case for this lane);
  * drop the `Text` part from the SES payload       -> the multipart test;
  * accept a 200 with no MessageId                  -> the unverifiable test;
  * drop the connect/read timeout from the client   -> the bounds test;
  * let `Message` accept a blank recipient          -> the address tests.
"""
from __future__ import annotations

import pytest

from core import mailer


class SesError(Exception):
    """botocore's shape, and nothing else. Anything this fake accepts that the
    real client would refuse is a bug this suite cannot see."""

    def __init__(self, code: str, message: str):
        super().__init__(f"An error occurred ({code}): {message}")
        self.response = {"Error": {"Code": code, "Message": message},
                         "ResponseMetadata": {"HTTPStatusCode": 400}}


class FakeSes:
    def __init__(self, *, raises: Exception | None = None, message_id: str = "0100-abc"):
        self.calls: list[dict] = []
        self._raises = raises
        self._message_id = message_id

    def send_email(self, **kwargs):
        self.calls.append(kwargs)
        if self._raises:
            raise self._raises
        return {"MessageId": self._message_id,
                "ResponseMetadata": {"HTTPStatusCode": 200}}


def _msg(**over) -> mailer.Message:
    base = {"to": "dad@example.com", "subject": "Job Search HQ — Mon 27 Jul",
            "html": "<p>hi</p>", "text": "hi"}
    base.update(over)
    return mailer.Message(**base)


def test_a_send_carries_both_parts_and_returns_the_provider_id():
    ses = FakeSes()
    m = mailer.SesMailer(from_address="hq@example.com", client=ses)
    assert m.send(_msg()) == "0100-abc"
    (call,) = ses.calls
    assert call["FromEmailAddress"] == "hq@example.com"
    assert call["Destination"] == {"ToAddresses": ["dad@example.com"]}
    body = call["Content"]["Simple"]["Body"]
    assert body["Html"]["Data"] == "<p>hi</p>" and body["Html"]["Charset"] == "UTF-8"
    assert body["Text"]["Data"] == "hi", "an HTML-only message is a spam-folder message"


def test_the_sandbox_refusal_is_its_own_named_error():
    """SES sandbox refuses an unverified recipient at send time. It is what
    happens the first time a user is added, and it must not read as an outage."""
    ses = FakeSes(raises=SesError(
        "MessageRejected",
        "Email address is not verified. The following identities failed the "
        "check in region US-EAST-1: dad@example.com"))
    m = mailer.SesMailer(from_address="hq@example.com", client=ses)
    with pytest.raises(mailer.AddressNotVerified) as exc:
        m.send(_msg())
    assert "dad@example.com" in str(exc.value)
    assert "verified SES identity" in str(exc.value)


def test_any_other_ses_error_is_a_plain_send_failure_that_names_the_code():
    ses = FakeSes(raises=SesError("Throttling", "Maximum sending rate exceeded."))
    m = mailer.SesMailer(from_address="hq@example.com", client=ses)
    with pytest.raises(mailer.MailSendFailed, match="Throttling"):
        m.send(_msg())


def test_a_rejection_that_is_not_about_verification_is_not_the_verification_error():
    ses = FakeSes(raises=SesError("MessageRejected", "Message content rejected."))
    m = mailer.SesMailer(from_address="hq@example.com", client=ses)
    with pytest.raises(mailer.MailSendFailed):
        m.send(_msg())


def test_a_200_with_no_message_id_is_not_success():
    class Shapeless(FakeSes):
        def send_email(self, **kwargs):
            return {"ResponseMetadata": {"HTTPStatusCode": 200}}
    m = mailer.SesMailer(from_address="hq@example.com", client=Shapeless())
    with pytest.raises(mailer.MailSendFailed, match="unverifiable"):
        m.send(_msg())


def test_a_transport_exception_with_no_botocore_shape_still_classifies():
    ses = FakeSes(raises=TimeoutError("read timeout"))
    m = mailer.SesMailer(from_address="hq@example.com", client=ses)
    with pytest.raises(mailer.MailSendFailed, match="TimeoutError"):
        m.send(_msg())


# ------------------------------------------------------------ configuration

def test_no_sender_is_a_refusal_not_a_default(monkeypatch):
    monkeypatch.delenv(mailer.SENDER_ENV, raising=False)
    with pytest.raises(mailer.MailNotConfigured, match=mailer.SENDER_ENV):
        mailer.SesMailer(client=FakeSes())


def test_the_sender_comes_from_the_env_terraform_writes(monkeypatch):
    monkeypatch.setenv(mailer.SENDER_ENV, " hq@example.com ")
    assert mailer.sender() == "hq@example.com"
    monkeypatch.setenv(mailer.SENDER_ENV, "not an address")
    assert mailer.sender() == ""


@pytest.mark.parametrize("bad", ["", "  ", "nobody", "a@b", "a@b.c,d@e.f", "<a@b.co>"])
def test_a_message_refuses_an_undeliverable_recipient(bad):
    with pytest.raises(mailer.MailNotConfigured):
        _msg(to=bad)


def test_a_message_refuses_html_with_no_plain_alternative():
    with pytest.raises(mailer.MailNotConfigured, match="text/plain"):
        _msg(text="   ")


def test_a_message_refuses_an_empty_subject():
    with pytest.raises(mailer.MailNotConfigured, match="subject"):
        _msg(subject=" ")


@pytest.mark.parametrize("subject", [
    "Job Search HQ\r\nBcc: attacker@evil.example",
    "Job Search HQ\nBcc: attacker@evil.example",
    "Job Search HQ\rX-Injected: 1",
])
def test_a_message_refuses_a_newline_in_the_subject(subject):
    """C3 review m3 — header injection via the subject. Unreachable today, one
    field away."""
    with pytest.raises(mailer.MailNotConfigured, match="newline"):
        _msg(subject=subject)


def test_the_real_client_is_bounded():
    """Rule #1: every external call gets a timeout. Asserted on the Config the
    factory builds, because an unbounded SES call inside a Lambda with a hard
    deadline spends the deadline and reports nothing."""
    boto3 = pytest.importorskip("boto3", reason="boto3 ships with the Lambda image, not CI")
    captured = {}
    orig = boto3.client

    def spy(name, **kwargs):
        captured.update(service=name, **kwargs)
        raise RuntimeError("stop before the network")

    boto3.client = spy
    try:
        with pytest.raises(RuntimeError):
            mailer._ses_client()
    finally:
        boto3.client = orig
    assert captured["service"] == "sesv2"
    cfg = captured["config"]
    assert cfg.connect_timeout == mailer.CONNECT_TIMEOUT
    assert cfg.read_timeout == mailer.READ_TIMEOUT
    assert cfg.retries["max_attempts"] == mailer.MAX_ATTEMPTS


def test_a_real_botocore_clienterror_travels_the_same_path_as_the_fake():
    """The fake's fidelity, proven rather than asserted in a comment."""
    botocore = pytest.importorskip("botocore.exceptions")
    real = botocore.ClientError(
        {"Error": {"Code": "MessageRejected",
                   "Message": "Email address is not verified: dad@example.com"}},
        "SendEmail")
    m = mailer.SesMailer(from_address="hq@example.com", client=FakeSes(raises=real))
    with pytest.raises(mailer.AddressNotVerified):
        m.send(_msg())


# ---------------------------------------------------------------- the fake

def test_capture_mailer_records_and_can_be_told_to_fail():
    cap = mailer.CaptureMailer()
    assert cap.send(_msg()) == "capture-1"
    assert cap.sent[0].to == "dad@example.com"
    cap.fail_with = mailer.MailSendFailed("nope")
    with pytest.raises(mailer.MailSendFailed):
        cap.send(_msg())
