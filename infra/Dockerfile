# Container image for the HQ scheduled bots on AWS Lambda.
# Base = AWS's official Python 3.11 Lambda runtime (boto3 + the Lambda RIC are preinstalled).
# Build from the REPO ROOT:  docker build -f infra/Dockerfile -t job-hq-bots .
FROM public.ecr.aws/lambda/python:3.11

# Python deps first (own layer, cached across code changes). Pins come from requirements.txt.
COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

# Only what the bots import — no webapp/, resume/, secrets, or migrations.
COPY core/          ${LAMBDA_TASK_ROOT}/core/
COPY monitor/       ${LAMBDA_TASK_ROOT}/monitor/
COPY tracker/       ${LAMBDA_TASK_ROOT}/tracker/
COPY hq.config.yaml ${LAMBDA_TASK_ROOT}/
COPY infra/app/handler.py ${LAMBDA_TASK_ROOT}/

# Drop test files + caches that ride along inside the packages (smaller image, no test deps).
RUN find ${LAMBDA_TASK_ROOT} -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true

# handler.py:handler — EventBridge Scheduler passes {"job": "<name>"}.
CMD ["handler.handler"]
