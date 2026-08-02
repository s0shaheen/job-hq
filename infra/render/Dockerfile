# Container image for the HQ résumé render service on AWS Lambda.
# Base = AWS's official Python 3.12 Lambda runtime. Build from the REPO ROOT:
#   docker build -f infra/render/Dockerfile -t job-hq-render .
#
# WHY A SECOND IMAGE, not another JOBS entry in infra/Dockerfile:
#
#   * 3.12 vs 3.11. rendercv 2.8 requires Python >= 3.12; the bots run 3.11.
#   * BLAST RADIUS, which is the real reason. The bots' Lambda can read every /job-hq/*
#     SecureString and write the backup bucket. This function renders USER-SUPPLIED documents
#     — the one input in the whole system authored by someone who may be hostile — so it gets
#     its own role (CloudWatch Logs only, infra/terraform/render.tf) and its own image with
#     none of the bots' code in it. Nothing here imports core/, monitor/ or tracker/, and
#     nothing here can reach a secret, a sheet, a mailbox or the database.
#
# What is deliberately NOT copied: hq.config.yaml, users/, resume/, db/, webapp/, and the
# repo's requirements.txt. The renderer is a pure function of its event.
FROM public.ecr.aws/lambda/python:3.12

# rendercv[full] is pure-pip (bundled Typst compiler + fonts), so no system packages and no
# build toolchain — the layer is deps-only and caches across every code change.
COPY infra/render/requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

# The whole service: one module. The fixtures ride along because gate_themes()'s reference
# document is part of the contract — the same bytes CI gated are the ones a live invocation
# would gate, which is what makes "it passed in CI" mean anything about the deployed image.
COPY infra/render/render.py   ${LAMBDA_TASK_ROOT}/
COPY infra/render/fixtures/   ${LAMBDA_TASK_ROOT}/fixtures/

RUN find ${LAMBDA_TASK_ROOT} -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true

# Fail the BUILD, not the first request, if the theme allowlist has drifted from the installed
# rendercv (render.py raises at import) or the Typst compiler is missing from the image. A
# cold-start crash in production would otherwise be the first anyone hears of a bad pin.
RUN cd ${LAMBDA_TASK_ROOT} && python -c "import render; print('engine:', render.ENGINE)"

CMD ["render.handler"]
