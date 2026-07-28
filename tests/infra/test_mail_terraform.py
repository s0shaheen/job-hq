"""The SES mail lane, read as TEXT — there is no terraform binary in CI, so these pin the four
edits that would be wrong in a way `terraform plan` would happily accept: an unscoped send policy,
a From address nobody verified, a domain identity nobody can publish DKIM for, and a lane that
stops being off by default. Same approach as test_lambda_handler.py's schedule-name pin, which
parses variables.tf the same way."""
import re
from pathlib import Path

TF = Path(__file__).resolve().parents[2] / "infra" / "terraform"
MAIL = (TF / "mail.tf").read_text()
MAIN = (TF / "main.tf").read_text()
VARS = (TF / "variables.tf").read_text()
OUTPUTS = (TF / "outputs.tf").read_text()


def _block(text: str, header: str) -> str:
    """The `header { ... }` block, brace-matched (HCL nests, and jsonencode nests further)."""
    start = text.index(header)
    depth = 0
    for i in range(text.index("{", start), len(text)):
        depth += {"{": 1, "}": -1}.get(text[i], 0)
        if depth == 0:
            return text[start:i + 1]
    raise AssertionError(f"unbalanced braces after {header!r}")


def test_send_policy_is_scoped_to_the_verified_identities_and_never_a_wildcard():
    policy = _block(MAIL, 'resource "aws_iam_role_policy" "send_email"')
    assert "aws_iam_role.lambda.id" in policy          # attached to the bots' role, not a new one
    assert "ses:SendEmail" in policy
    resource = re.search(r"Resource\s*=\s*(.+)", policy).group(1)
    assert "aws_sesv2_email_identity" in resource and ".arn" in resource
    assert '"*"' not in policy, \
        'Resource = "*" grants send-as on every identity the account ever verifies, incl. a future domain'


def test_the_lambda_carries_the_sender_the_identities_were_built_from():
    """Without this env var the engine has no From address at runtime and every send is a guess."""
    env = _block(_block(MAIN, 'resource "aws_lambda_function" "bots"'), "environment {")
    assert re.search(r"HQ_MAIL_SENDER\s*=\s*var\.ses_sender_email", env)


def test_the_sender_is_itself_one_of_the_verified_identities():
    """Sandbox verifies a From address by the same mechanism as a To address, so a sender missing
    from this union plans clean, applies clean, and MessageRejects every digest."""
    identities = re.search(r"ses_identities\s*=\s*(.+)", MAIL).group(1)
    gate, union = identities.split("?", 1)
    assert "var.ses_sender_email" not in gate, \
        "the on/off gate must read local.mail_enabled, or the membership check below is vacuous"
    assert "var.ses_sender_email" in union and "var.ses_verified_emails" in union
    assert re.search(r"for_each\s*=\s*local\.ses_identities",
                     _block(MAIL, 'resource "aws_sesv2_email_identity" "mail"'))


def test_identities_are_email_addresses_and_never_a_bare_domain():
    """No domain exists to publish DKIM/SPF for; a domain identity would never verify and would
    fail every send after a plan that looked fine."""
    ses_resources = re.findall(r'resource\s+"(aws_sesv2_\w+)"', MAIL)
    assert ses_resources == ["aws_sesv2_email_identity"]
    assert re.search(r"email_identity\s*=\s*each\.value", MAIL)   # one per address in the set
    for literal in re.findall(r'email_identity\s*=\s*"([^"]+)"', MAIL):
        assert "@" in literal, f"{literal!r} is a domain identity, not an address"


def test_the_whole_lane_is_off_until_a_sender_is_set():
    """Default plan must create nothing: no identity, no policy, no verification email to a
    stranger's inbox."""
    headers = [m.group(0) for m in re.finditer(r'resource\s+"\w+"\s+"\w+"', MAIL)]
    assert headers, "parsed no resources out of mail.tf — did the file move?"
    for header in headers:
        gate = re.search(r"^\s*(?:count|for_each)\s*=\s*(.+)$", _block(MAIL, header), re.M)
        assert gate, f"{header} is created unconditionally"
        assert "local.mail_enabled" in gate.group(1) or "local.ses_identities" in gate.group(1), \
            f"{header} is gated on something other than the sender being set: {gate.group(1)}"


def test_both_variables_default_to_the_lane_being_off():
    sender = _block(VARS, 'variable "ses_sender_email"')
    assert re.search(r"type\s*=\s*string", sender) and re.search(r'default\s*=\s*""', sender)
    recipients = _block(VARS, 'variable "ses_verified_emails"')
    assert re.search(r"type\s*=\s*list\(string\)", recipients)
    assert re.search(r"default\s*=\s*\[\]", recipients)


def test_the_identities_are_output_with_the_click_the_email_reminder():
    """The addresses are the only thing an operator needs after apply, and 'created' is not
    'verified' — the output says so where they will read it."""
    out = _block(OUTPUTS, 'output "ses_verified_identities"')
    assert "aws_sesv2_email_identity" in out
    assert "verification email" in out
