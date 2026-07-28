"""Outbound email for the engine — AWS SES v2, and the only door to it.

Until Phase C3 the system could not send an email at all from Python: the daily
digest was mailed by an Apps Script `MailApp.sendEmail(OWNER_EMAIL, …)` with the
address literal in the source. That is the mailer this module replaces.

WHY SES, decided at build time (docs/plans/PHASE-DIGEST.md wrote "Resend or SES
— pick at build time"): the AWS account, the IAM role, the Terraform and the
CloudWatch/SNS/ntfy alerting all already exist for the bots Lambda, so SES adds
one resource and one policy statement instead of a vendor, a dashboard and a
second API key. **Sandbox mode is not a limitation here, it is the right shape:**
sandbox delivers only to verified addresses, and a two-person system has exactly
two. Promotion out of sandbox is a later ops step, not a prerequisite.

THE CONSEQUENCE THAT MATTERS, and the reason it has its own exception class:
in sandbox an unverified recipient is refused at send time with `MessageRejected`
and the sentence "Email address is not verified". That is the number one support
case for this lane — it is what happens the first time a new user is added, and
it looks identical to a generic send failure unless something names it. So it is
`AddressNotVerified`, the ops push says which address, and the runbook says to
click the AWS verification email.

BOUNDS. `Rules that already cost a production incident` #1: every external call
gets a timeout. The client is built with explicit connect/read timeouts and a
capped retry count; the digest job runs inside a Lambda with a hard deadline and
an unbounded SES call would spend it.

FAKES. `CaptureMailer` records instead of sending, and `SesMailer` is testable
because the boto3 client is injectable. Rule #3 says a fake more forgiving than
the real API hides the bug it exists to catch, so `tests/core/test_mailer.py`
raises the SAME SHAPE botocore does — an exception carrying
`.response["Error"]["Code"]` — and this module classifies on that shape rather
than on `isinstance(e, ClientError)`. A real `ClientError` therefore travels the
identical path, and the fake cannot drift into being kinder than SES.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

#: The verified identity every engine email is sent FROM. Terraform writes it
#: into the Lambda's environment from the SES identity it created
#: (infra/terraform/mail.tf), so the engine cannot send from an address nobody
#: verified — a misconfiguration SES would otherwise only reveal at 06:40.
SENDER_ENV = "HQ_MAIL_SENDER"
REGION_ENV = "AWS_REGION"

CONNECT_TIMEOUT = 5
READ_TIMEOUT = 15
MAX_ATTEMPTS = 2

_ADDRESS_RE = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$")


class MailError(RuntimeError):
    """Base for every failure of this lane. Callers catch this one."""


class MailNotConfigured(MailError):
    """No sender identity, or boto3 is not importable. Not a transient."""


class AddressNotVerified(MailError):
    """SES sandbox refused an address. The #1 support case; see the module doc."""


class MailSendFailed(MailError):
    """Everything else SES said no to, with its error code in the message."""


@dataclass(frozen=True)
class Message:
    to: str
    subject: str
    html: str
    text: str

    def __post_init__(self) -> None:
        if not valid_address(self.to):
            raise MailNotConfigured(f"{self.to!r} is not a deliverable address")
        if not self.subject.strip():
            raise MailNotConfigured("refusing to send a message with no subject")
        if "\r" in self.subject or "\n" in self.subject:
            # A CRLF in a header value is header injection — a second header
            # (`Bcc:`) smuggled into the subject. Unreachable today because
            # `subject_for` is built only from the date and integer counts, but it
            # is one field away from user data, and `valid_address` already fences
            # the same trick out of `to`. SES v2 takes the subject as data, not a
            # raw header, but the guard costs nothing and does not depend on
            # trusting the vendor's parser (C3 review m3).
            raise MailNotConfigured("a subject may not contain a newline")
        if not self.text.strip():
            # A text/plain part is not decoration: it is what a screen reader, a
            # plain-text client and every spam filter reads. An HTML-only
            # message is the single most reliable way to land in a spam folder.
            raise MailNotConfigured("refusing to send HTML with no text/plain alternative")


def valid_address(addr: str) -> bool:
    """Deliberately shallow. This is not an RFC 5322 parser; it exists to catch
    `""`, a name with no address, and a comma-joined list that would silently
    become one malformed recipient."""
    return bool(_ADDRESS_RE.match((addr or "").strip()))


def sender(raw: str | None = None) -> str:
    """The From address, or `""` when the lane is unconfigured."""
    value = (os.environ.get(SENDER_ENV, "") if raw is None else raw).strip()
    return value if valid_address(value) else ""


@dataclass
class CaptureMailer:
    """In-memory. Every test uses it, and so does any dry run.

    It is also the honest answer for a local run: composing the digest is worth
    doing without a verified identity, and this way the compose path is exercised
    identically instead of behind an `if not sending` branch.
    """
    sent: list[Message] = field(default_factory=list)
    fail_with: Exception | None = None

    def send(self, msg: Message) -> str:
        if self.fail_with is not None:
            raise self.fail_with
        self.sent.append(msg)
        return f"capture-{len(self.sent)}"


class SesMailer:
    """SES v2 (`sesv2`), one `send_email` per message.

    v2 rather than the v1 `ses` API because v1 is the legacy surface and the IAM
    action (`ses:SendEmail`) and the identity resource are the same either way,
    so there is nothing to gain by starting on the old one.
    """

    def __init__(self, *, from_address: str | None = None, client=None):
        self.from_address = from_address if from_address is not None else sender()
        if not self.from_address:
            raise MailNotConfigured(
                f"{SENDER_ENV} is unset or not an address — the engine has no verified "
                f"SES identity to send from (infra/terraform/mail.tf)")
        self._client = client or _ses_client()

    def send(self, msg: Message) -> str:
        try:
            resp = self._client.send_email(
                FromEmailAddress=self.from_address,
                Destination={"ToAddresses": [msg.to]},
                Content={"Simple": {
                    "Subject": {"Data": msg.subject, "Charset": "UTF-8"},
                    "Body": {"Html": {"Data": msg.html, "Charset": "UTF-8"},
                             "Text": {"Data": msg.text, "Charset": "UTF-8"}},
                }},
            )
        except Exception as exc:
            raise _classify(exc, self.from_address, msg.to) from exc
        message_id = (resp or {}).get("MessageId", "")
        if not message_id:
            # SES answers 200 with a MessageId or it does not answer 200. A 200
            # with no id means the response shape changed under us, and treating
            # that as success would report a delivery nobody can trace.
            raise MailSendFailed("SES returned no MessageId — the send is unverifiable")
        return message_id


def _classify(exc: Exception, from_address: str, to: str) -> MailError:
    """botocore's error shape -> ours. Reads `.response`, never `isinstance`."""
    err = (getattr(exc, "response", None) or {}).get("Error") or {}
    code = str(err.get("Code") or type(exc).__name__)
    detail = str(err.get("Message") or exc)
    if code in ("MessageRejected", "MailFromDomainNotVerifiedException") and \
            re.search(r"not verified", detail, re.I):
        return AddressNotVerified(
            f"SES refused the message: {detail} "
            f"(from={from_address} to={to}). In sandbox BOTH addresses must be a "
            f"verified SES identity — see infra/README.md, the mail lane.")
    return MailSendFailed(f"SES {code}: {detail[:300]} (from={from_address} to={to})")


def _ses_client():
    """The bounded client. boto3 ships with the Lambda base image
    (`public.ecr.aws/lambda/python:3.11`) and is therefore NOT in
    requirements.txt — the same reason `infra/app/handler.py` imports it inside
    a function. A local run without it gets a sentence, not an ImportError
    traceback out of a mail send."""
    try:
        import boto3
        from botocore.config import Config
    except ImportError as exc:
        raise MailNotConfigured(
            "boto3/botocore are not installed. They ship with the Lambda runtime "
            "image; for a local send install them, or use CaptureMailer.") from exc
    return boto3.client(
        "sesv2",
        region_name=os.environ.get(REGION_ENV) or None,
        config=Config(connect_timeout=CONNECT_TIMEOUT, read_timeout=READ_TIMEOUT,
                      retries={"max_attempts": MAX_ATTEMPTS, "mode": "standard"}),
    )
