# The digest mail lane: SES identities + the one send grant the bots need.
#
# WHY THE ENGINE SENDS AT ALL: the daily briefing used to be composed here and mailed by a
# MailApp.sendEmail call inside the Gmail Apps Script, so a second codebase — its own quota, its
# own auth, no test — owned delivery of a message this repo wrote. The `digest` job now sends it
# itself with boto3 SES v2 (sesv2.send_email) under the Lambda's own execution role: no API key
# to rotate, no second runtime to be down.
#
# WHY EMAIL-ADDRESS IDENTITIES AND NOT A DOMAIN: there is no domain. Nobody owns a sending domain
# for HQ, and a domain identity whose DKIM/SPF records you cannot publish never verifies and
# fails every send after a plan that looked fine. An address identity verifies with one click in
# the inbox that owns it, which is the entire ceremony a two-person system needs. The day a
# domain exists this file gains an identity for it plus DKIM records; nothing here gets rewritten.
#
# WHY SANDBOX IS THE RIGHT MODE, NOT A LIMITATION: every SES account starts in sandbox, where the
# From address AND every To address must be a verified identity, capped at 200 messages/day and
# 1/second. One digest to two humans is two messages a day, so the caps are not the constraint.
# Sandbox also fails in the direction we want — an address nobody verified is rejected at send
# time instead of being delivered to a stranger. Promotion is an AWS support request, i.e. an ops
# step for the day a recipient appears who cannot click a verification link.
#
# OFF BY DEFAULT: var.ses_sender_email = "" creates nothing, so this whole file is a plan no-op
# until an operator names a sender. Setup and the verification click: infra/README.md § The mail lane.

locals {
  mail_enabled = var.ses_sender_email != ""

  # Sender and recipients in ONE set, because sandbox verifies a From address by exactly the same
  # mechanism as a To address. A sender left out of this union is the misconfiguration that plans
  # clean, applies clean, and then rejects every digest with MessageRejected at send time.
  ses_identities = local.mail_enabled ? toset(concat([var.ses_sender_email], var.ses_verified_emails)) : toset([])
}

# Terraform creates the identity; AWS emails each address a confirmation link. Applying is not
# verifying — until a human taps that link the identity is Pending and SES will not send to or
# from it. outputs.tf prints the list so nobody has to guess which inboxes are waiting.
resource "aws_sesv2_email_identity" "mail" {
  for_each = local.ses_identities

  email_identity = each.value # an address, never a domain (see the header)
}

# Send rights scoped to the identities above, never "*". SES v2's SendEmail authorizes against
# the identity/<address> ARN of the FROM address, so naming those ARNs here is what pins the bots
# to addresses Terraform itself verified: a buggy or compromised job cannot invent a different
# From, and the ses:FromAddress condition key is redundant once the resource IS the identity.
# Resource = "*" would instead hand this role send-as on every identity the account ever verifies,
# including a future domain. The recipients' ARNs ride along in the list and are the same two
# humans the digest is for; tightening to the sender alone is a one-line change if that stops
# being true.
resource "aws_iam_role_policy" "send_email" {
  count = local.mail_enabled ? 1 : 0

  name = "send-digest-email"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ses:SendEmail"],
      Resource = [for identity in aws_sesv2_email_identity.mail : identity.arn] },
    ]
  })
}
