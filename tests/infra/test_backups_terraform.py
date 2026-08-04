"""The backup bucket's blast radius, read as TEXT (no terraform binary in CI).

Same approach as `test_render_terraform.py`, and it borrows that file's brace-matching
reader rather than growing a second copy of it.

This became a security boundary rather than a housekeeping detail when `tracker.pgdump`
started writing a dump of the PRODUCT DATABASE next to the sheet's CSVs. What used to be
"the operator's own spreadsheet, in a private bucket" is now every user's rows, sitting in
an object store that is a far softer target than the database. So the properties below are
the ones the backup argument actually rests on:

  * the writer can PUT and nothing else — no GetObject (that is the exfiltration path),
    no Delete (that is what makes versioning a defense rather than a decoration), no
    ListBucket (which is reconnaissance for both);
  * it can only write the two prefixes the two lanes use, so it cannot bury the real
    backups under objects it named;
  * versioning is on, public access is blocked, and objects are encrypted at rest;
  * the lifecycle keeps a floor of versions by COUNT and not only by age — a lane that
    dies for 90 days must not have its last good copies expire out from under it.

MUTATION TARGETS: add `"s3:GetObject"` to the policy, widen the Resource back to
`/*`, drop `newer_noncurrent_versions`, or flip the SSE rule to `"aws:kms"` without a
key — each fails exactly one test here.
"""
import re

from tests.infra.test_render_terraform import ALL_TF, EVERY_TF, _blocks

BACKUPS = ALL_TF["backups.tf"]


def _writer_policies() -> list[str]:
    """Every IAM policy resource in the WHOLE directory that mentions the backups bucket.

    Directory-wide, for the reason `test_render_terraform` learned the hard way: IAM does
    not care which file a policy is declared in, and a file-scoped read passes while a
    grant sits one file over."""
    found, at = [], 0
    kind = 'resource "aws_iam_role_policy" '
    while (start := EVERY_TF.find(kind, at)) != -1:
        body = _blocks(EVERY_TF[start:], kind)[0]
        at = start + len(body)
        if "aws_s3_bucket.backups" in body:
            found.append(body)
    return found


def test_the_backup_writer_can_only_put_and_only_where_the_lanes_write():
    policies = _writer_policies()
    assert len(policies) == 1, (
        f"{len(policies)} IAM policies reference the backups bucket; expected one. "
        f"Whatever the extras grant, the bots' role now has it over a database dump")
    body = policies[0]

    actions = set(re.findall(r'"(s3:[A-Za-z*]+)"', body))
    assert actions == {"s3:PutObject"}, (
        f"the backup writer grants {sorted(actions)}. GetObject exfiltrates every user's "
        f"rows out of an object store; Delete* removes the versions that make yesterday's "
        f"good dump survive today's bad one")

    # Prefix scoping, asserted on the resource ARNs rather than on the comment above them.
    resources = re.findall(r'"\$\{aws_s3_bucket\.backups\.arn\}([^"]*)"', body)
    assert sorted(resources) == ["/pgdump/*", "/snapshots/*"], (
        f"writer resources are {resources}; one prefix per lane, never the whole bucket")


def test_nothing_else_in_the_directory_can_read_or_delete_a_backup():
    """The counting guard under the one above: a grant that names the bucket by its
    literal name, or by `"*"`, would never appear in `_writer_policies`.

    The corpus is asserted FIRST, and that is not ceremony. An absence check over a
    string that turned out to be empty — a renamed directory, a glob that matched
    nothing, comments stripped a little too eagerly — passes for every forbidden action
    at once and reports a locked-down account that was never read."""
    assert '"s3:PutObject"' in EVERY_TF, \
        "the terraform corpus does not even contain the grant that IS supposed to be here"
    assert len(ALL_TF) >= 5, f"only {sorted(ALL_TF)} were read; the directory glob is wrong"

    for forbidden in ("s3:GetObject", "s3:DeleteObject", "s3:DeleteObjectVersion",
                      "s3:ListBucket", "s3:*"):
        assert f'"{forbidden}"' not in EVERY_TF, \
            f"{forbidden} is granted somewhere in the terraform — read what it reaches"


def test_the_bucket_is_versioned_private_and_encrypted_at_rest():
    versioning = _blocks(BACKUPS, 'resource "aws_s3_bucket_versioning" "backups"')[0]
    assert 'status = "Enabled"' in versioning, "versioning IS the backup history"

    block = _blocks(BACKUPS, 'resource "aws_s3_bucket_public_access_block" "backups"')[0]
    for knob in ("block_public_acls", "block_public_policy",
                 "ignore_public_acls", "restrict_public_buckets"):
        assert re.search(rf"{knob}\s*=\s*true", block), f"{knob} is not true"

    sse = _blocks(BACKUPS,
                  'resource "aws_s3_bucket_server_side_encryption_configuration" "backups"')[0]
    assert 'sse_algorithm = "AES256"' in sse, "objects are not encrypted at rest by default"


def test_the_lifecycle_keeps_a_floor_of_versions_by_count_not_only_by_age():
    """Age alone reads "keep 90 days of history", which is the same sentence as "if this
    lane dies for 90 days, delete every good copy and keep the last bad one" — the exact
    failure a backup exists to survive."""
    lc = _blocks(BACKUPS, 'resource "aws_s3_bucket_lifecycle_configuration" "backups"')[0]
    expiry = _blocks(lc, "noncurrent_version_expiration")[0]
    assert re.search(r"noncurrent_days\s*=\s*90", expiry)
    floor = re.search(r"newer_noncurrent_versions\s*=\s*(\d+)", expiry)
    assert floor and int(floor.group(1)) >= 7, \
        "no version-count floor: a dead lane's history expires on schedule"
    assert re.search(r"days_after_initiation\s*=\s*\d+", lc), "incomplete uploads never abort"
    assert lc.count("rule {") == 1, (
        "a second lifecycle rule makes the effective retention a question about S3's "
        "conflict resolution; a backup's retention must not be a trivia question")


def test_the_grant_covers_the_key_the_module_actually_writes():
    """The policy and the module have to agree, and nothing else compares them. A key
    outside the granted prefixes is an AccessDenied every night at 09:13 UTC."""
    from tracker import pgdump
    key = pgdump.KEY
    granted = re.findall(r'"\$\{aws_s3_bucket\.backups\.arn\}/([^/"]+)/\*"',
                         _writer_policies()[0])
    assert key.split("/", 1)[0] in granted, \
        f"the module writes {key!r}, which no granted prefix ({granted}) covers"
