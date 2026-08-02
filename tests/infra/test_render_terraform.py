"""The render Lambda's blast radius, read as TEXT — there is no terraform binary in CI, so these
pin the edits that would be wrong in a way `terraform plan` would happily accept: a secret-reading
policy on the one function that executes user-authored documents, a public function URL, a shared
role, or an env var for an injected payload to go looking for. Same approach as
test_mail_terraform.py and test_lambda_handler.py's schedule-name pin.

The claim under test is the one infra/terraform/render.tf is written to make: a full compromise
of the renderer reaches an empty account. That claim is false the moment any of these fail.
"""
from pathlib import Path


def _code(text: str) -> str:
    """The file with its `#` comments removed.

    These files are heavily commented, and the comments NAME the things being forbidden ("no
    ssm:GetParameter", "there is no aws_scheduler_schedule here on purpose"). Scanning the raw
    text would therefore fail on the documentation of the very property under test — and, worse,
    would pass the day someone deleted the comment and added the grant.
    """
    return "\n".join(line.split("#", 1)[0] for line in text.splitlines())


TF = Path(__file__).resolve().parents[2] / "infra" / "terraform"
RENDER = _code((TF / "render.tf").read_text())
ALERTS = (TF / "alerts.tf").read_text()   # comments kept: the alarm bodies are matched whole
MAIN = (TF / "main.tf").read_text()
DEPLOY = (Path(__file__).resolve().parents[2] / "infra" / "deploy.sh").read_text()
DOCKERFILE = _code((Path(__file__).resolve().parents[2] / "infra" / "render" / "Dockerfile").read_text())
REQS = _code((Path(__file__).resolve().parents[2] / "infra" / "render" / "requirements.txt").read_text())


#: EVERY `.tf` in the directory, concatenated, comments stripped.
#:
#: The blast-radius assertions below read THIS and not `render.tf`, because IAM
#: does not care which file a policy is declared in. A file-scoped test passed
#: `14 passed in 0.03s` with this appended to `backups.tf`:
#:
#:     resource "aws_iam_role_policy" "render_needs_a_font_bucket" {
#:       role   = aws_iam_role.render.id
#:       policy = jsonencode({ Statement = [{ Effect = "Allow",
#:         Action = ["ssm:GetParameter", "s3:GetObject"], Resource = "*" }] })
#:     }
#:
#: A hostile résumé read every /job-hq/* SecureString and the guard test was
#: green. Test the ROLE, not the file.
ALL_TF = {p.name: _code(p.read_text()) for p in sorted(TF.glob("*.tf"))}
EVERY_TF = "\n".join(ALL_TF.values())


def _block(text: str, header: str) -> str:
    """The `header { ... }` block, brace-matched (HCL nests, and jsonencode nests further)."""
    return _blocks(text, header)[0]


def _blocks(text: str, header: str) -> list[str]:
    """EVERY `header { ... }` block, brace-matched. `_block` takes the first.

    Plural because the single-block form cannot see a SECOND declaration, and a
    second declaration is exactly what an added policy is.
    """
    out, at = [], 0
    while (start := text.find(header, at)) != -1:
        depth = 0
        for i in range(text.index("{", start), len(text)):
            depth += {"{": 1, "}": -1}.get(text[i], 0)
            if depth == 0:
                out.append(text[start:i + 1])
                at = i + 1
                break
        else:
            raise AssertionError(f"unbalanced braces after {header!r}")
    if not out:
        raise AssertionError(f"no {header!r} block found")
    return out


def _attached_to_the_render_role() -> list[str]:
    """Every IAM policy resource in the WHOLE directory that names the render role."""
    found = []
    for kind in ('resource "aws_iam_role_policy" ',
                 'resource "aws_iam_role_policy_attachment" ',
                 'resource "aws_iam_policy_attachment" '):
        at = 0
        while (start := EVERY_TF.find(kind, at)) != -1:
            body = _blocks(EVERY_TF[start:], kind)[0]
            at = start + len(body)
            if "aws_iam_role.render" in body:
                found.append(body)
    return found


def test_the_render_role_can_write_logs_and_nothing_else():
    """The whole security argument for a second function, asserted over the ROLE.

    One policy resource attached to `aws_iam_role.render` anywhere in the directory, it is the
    managed basic-execution policy (= logs), and it grants none of the bots' actions. An inline
    policy in `backups.tf`, or one named `fonts` rather than `render_*`, fails here.
    """
    attached = _attached_to_the_render_role()
    assert len(attached) == 1, (
        f"{len(attached)} IAM policy resources attach to aws_iam_role.render across "
        f"{sorted(ALL_TF)}; expected exactly one (logs). Whatever the extras grant, a hostile "
        "résumé now has it"
    )
    assert "policy = jsonencode" not in attached[0], \
        "the one attachment grew an inline document — read what it grants before allowing it"

    # An ATTACHMENT grants by ARN, so the actions never appear in the file: matching action
    # names alone would pass `AmazonS3FullAccess`. The ARN is therefore pinned WHOLE, and it is
    # the only managed policy in the block.
    arn = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
    assert f'"{arn}"' in attached[0], "the render role's one managed policy is not basic execution"
    assert attached[0].count("arn:aws:iam::aws:policy") == 1, "a second managed policy"

    # Action names, for the day the attachment becomes an inline document. `sts:`/`lambda:`/
    # `sqs:` were missing from the old list, so a policy letting the renderer ASSUME the bots'
    # role — the whole boundary, in one action — was not forbidden by name. Quoted, because
    # bare `iam:` matches the managed-policy ARN above and bare `s3:` matches a bucket comment.
    for forbidden in ("ssm:", "kms:", "s3:", "ses:", "secretsmanager:", "dynamodb:", "bedrock:",
                      "sts:", "lambda:", "sqs:", "sns:", "iam:", "ec2:", "events:", "scheduler:"):
        assert f'"{forbidden}' not in attached[0], f"{forbidden} reachable from the renderer"


def test_only_the_log_attachment_and_the_function_reference_the_render_role():
    """The counting guard under the one above.

    Any resource that reaches the render role must NAME it, so the number of references is the
    number of things that can change what it may do. Exactly two: the log attachment's
    `role =` and the function's `role =`. A third is a policy, a trust-policy edit, or an
    `aws_iam_role_policy_attachments_exclusive` — all of which move the boundary.
    """
    refs = EVERY_TF.count("aws_iam_role.render")
    assert refs == 2, (
        f"aws_iam_role.render is referenced {refs} times across {sorted(ALL_TF)}; expected 2 "
        "(the log attachment and the function). Something else now reaches the render role"
    )
    # And the bypass that references nothing: an IAM resource naming the role by its literal
    # name. Terraform builds it from `${local.name}-render`, so the literal never appears.
    assert '"job-hq-render"' not in EVERY_TF, \
        "the render role/function named as a string literal — it dodges the reference count"


def test_the_render_role_trusts_only_the_lambda_service():
    """The other half of the role's reach: who may assume it. A second principal here — an
    account root, a `"*"`, a CI role — is a way into the role that no policy count would see."""
    role = _block(EVERY_TF, 'resource "aws_iam_role" "render"')
    assert role.count("Statement") == 1 and role.count("Principal") == 1, \
        "more than one trust statement on the render role"
    assert 'Service = "lambda.amazonaws.com"' in role
    assert 'Action    = "sts:AssumeRole"' in role or 'Action = "sts:AssumeRole"' in role
    assert '"*"' not in role and "AWS =" not in role, "a non-service principal may assume it"


def test_the_renderer_never_borrows_the_bots_role():
    """`role = aws_iam_role.lambda.arn` here would silently hand user-authored documents the
    SSM-reading, S3-writing, SES-sending role — and would plan and apply perfectly."""
    fn = _block(RENDER, 'resource "aws_lambda_function" "render"')
    assert "aws_iam_role.render.arn" in fn
    assert "aws_iam_role.lambda" not in RENDER


def test_the_renderer_has_no_environment_and_no_vpc():
    """No env var means nothing for an injected payload to read out of os.environ, and no VPC
    means no path to an internal address even if a fetch were somehow reintroduced."""
    fn = _block(RENDER, 'resource "aws_lambda_function" "render"')
    assert "environment {" not in fn
    assert "vpc_config" not in fn


def test_the_renderer_is_not_reachable_from_the_internet():
    """A function URL or an API Gateway route would make this an open renderer for anyone."""
    for public in ("aws_lambda_function_url", "aws_apigatewayv2", "aws_api_gateway",
                   "aws_lb_target_group"):
        assert public not in RENDER, f"{public} exposes the renderer publicly"


def test_nothing_has_been_granted_invoke_yet():
    """The webapp's identity gets invoke on this exact ARN when that lane is wired. A
    placeholder principal is how a wildcard invoker ships."""
    assert "aws_lambda_permission" not in RENDER
    assert '"*"' not in RENDER


def test_the_renderer_has_its_own_image_repository():
    """One image for both functions would put the bots' code — and its imports — inside the
    process that renders hostile documents."""
    assert 'resource "aws_ecr_repository" "render"' in RENDER
    fn = _block(RENDER, 'resource "aws_lambda_function" "render"')
    assert "aws_ecr_repository.render.repository_url" in fn
    assert "aws_ecr_repository.bots" not in RENDER


def test_the_image_is_pinned_out_of_band_like_the_bots():
    """Terraform owns the function, deploy.sh owns which build it runs. Without the lifecycle
    block an apply rolls the renderer back to whatever :latest points at today."""
    fn = _block(RENDER, 'resource "aws_lambda_function" "render"')
    assert "ignore_changes = [image_uri]" in fn


def test_the_synchronous_call_has_a_human_scale_timeout():
    fn = _block(RENDER, 'resource "aws_lambda_function" "render"')
    assert "var.render_timeout_seconds" in fn
    vars_tf = (TF / "variables.tf").read_text()
    default = _block(vars_tf, 'variable "render_timeout_seconds"')
    assert "default     = 60" in default or "default = 60" in default, \
        "a 900 s ceiling on a call a person is waiting on is a 15-minute spinner"


def test_the_renderer_has_an_errors_alarm_and_deliberately_no_silence_alarm():
    """It has no schedule, so "no invocations in 3 h" is a normal night — a silence alarm here
    would fire every evening and be muted by Friday."""
    assert 'resource "aws_cloudwatch_metric_alarm" "render_errors"' in ALERTS
    alarm = _block(ALERTS, 'resource "aws_cloudwatch_metric_alarm" "render_errors"')
    assert "aws_lambda_function.render.function_name" in alarm
    assert "aws_sns_topic.alerts.arn" in alarm          # the same ntfy path the bots use
    assert 'metric_name         = "Errors"' in alarm
    assert 'resource "aws_cloudwatch_metric_alarm" "render_silent"' not in ALERTS


def test_the_renderer_is_never_scheduled():
    """An EventBridge schedule pointed at this function would be a timer that renders nothing
    for nobody — and the first step toward it becoming a general-purpose job runner again."""
    assert "aws_scheduler_schedule" not in RENDER
    schedules = _block(MAIN, 'resource "aws_scheduler_schedule" "job"')
    assert "aws_lambda_function.render" not in schedules


def test_deploy_ships_the_render_image_from_the_render_dockerfile():
    """A copy-paste that leaves the bots' Dockerfile in the render lane pushes the wrong image
    into the right repo and reports success."""
    assert "infra/render/Dockerfile" in DEPLOY
    assert "job-hq-render" in DEPLOY
    assert '-f "${DOCKERFILE}"' in DEPLOY, "the build must use the per-target Dockerfile"


def test_the_deploy_target_cannot_be_overridden_by_the_environment():
    """`FN="${LAMBDA_FN:-job-hq-render}"` means an exported variable BEATS the target the
    `case` just chose. `LAMBDA_FN=job-hq-bots infra/deploy.sh render` built the render image
    and then ran `update-function-code --function-name job-hq-bots`: the renderer of untrusted
    documents running under the role with SSM read, S3 write and SES send — the precise
    inversion render.tf exists to prevent, reachable from a stale `export` in a shell.
    `ECR_REPO=job-hq-bots` likewise moves the bots repo's `:latest`, which is the tag
    main.tf uses at function-create time.

    Asserted as ABSENCE OF THE OVERRIDE rather than by running the script, because the failure
    is a value that resolves from the environment and the whole point is that no environment
    should reach it.
    """
    code = _code(DEPLOY)   # `_code`'s reason exactly: the comment NAMES the pattern it removed
    for var in ("LAMBDA_FN", "ECR_REPO", "DOCKERFILE", "FN"):
        assert f"${{{var}:-" not in code, (
            f"{var} is env-overridable in deploy.sh — the lane the `case` chose is not the lane "
            "that gets deployed"
        )
    # The assignments the case arms make must be plain, so the arm IS the decision.
    for lane, repo, fn in (("bots", "job-hq-bots", "job-hq-bots"),
                           ("render", "job-hq-render", "job-hq-render")):
        assert f'ECR_REPO="{repo}"' in DEPLOY, f"the {lane} arm no longer names its repo outright"
        assert f'FN="{fn}"' in DEPLOY, f"the {lane} arm no longer names its function outright"


def test_the_render_image_carries_none_of_the_bots_code():
    """core/, monitor/, tracker/, users/ and hq.config.yaml are the bots' world. None of it
    belongs in the process that executes user-authored documents."""
    for path in ("core/", "monitor/", "tracker/", "users/", "hq.config.yaml", "resume/",
                 "webapp/", "db/"):
        assert f"COPY {path}" not in DOCKERFILE
    assert "COPY infra/render/render.py" in DOCKERFILE
    assert "requirements.txt" in DOCKERFILE
    assert "python:3.12" in DOCKERFILE, "rendercv 2.8 requires Python >= 3.12"


def test_the_render_image_fails_the_build_on_a_bad_pin():
    """render.py raises at import if the theme allowlist has drifted from the installed
    rendercv. Importing it during the build turns that into a red build instead of a cold-start
    crash in production."""
    assert "import render" in DOCKERFILE


def test_rendercv_is_pinned_exactly():
    """`~=` or `>=` would let a minor bump land unreviewed — and both vulnerability tests in
    test_render_live.py are statements about 2.8's code specifically."""
    assert "rendercv[full]==2.8" in REQS
    assert ">=" not in REQS and "~=" not in REQS
