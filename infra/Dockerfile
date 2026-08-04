# Container image for the HQ scheduled bots on AWS Lambda.
# Base = AWS's official Python 3.11 Lambda runtime (boto3 + the Lambda RIC are preinstalled).
# Build from the REPO ROOT:  docker build -f infra/Dockerfile -t job-hq-bots .

# --- stage 1: pg_dump 17, built from source, because no packaged 17 exists here ----------
#
# `tracker.pgdump` needs a pg_dump whose major is >= the server's (Supabase 17.x); pg_dump
# ABORTS otherwise. Nothing packaged supplies one on this base: the runtime is Amazon Linux
# 2, whose repos top out well below 17, and PGDG publishes no EL7-compatible 17 either. The
# alternatives were worse — Debian/Ubuntu binaries want a newer glibc than AL2 has, and
# swapping the bots' base image to chase a package would re-resolve every pinned dependency
# the sweep depends on for the sake of one 4 MB binary.
#
# THE VERSIONED PATH IS THE POINT. /opt/pg17/bin/pg_dump is an actual binary, not
# postgresql-common's perl wrapper. That wrapper is what shipped a live failure in PR #89:
# postgresql-client-17 was installed, /usr/bin/pg_dump still ran 16.14 (it resolves by
# cluster, not by newest client), and the dump against the 17.6 server aborted.
# `tracker.pgdump` re-checks the major at runtime anyway; this stage is what makes the
# check pass.
#
# --with-openssl is not optional: the connection to Supabase is TLS, and PGSSLMODE=require
# on a pg_dump built without SSL is a refusal, not a fallback.
FROM public.ecr.aws/lambda/python:3.11 AS pgdump-build
ARG PG_VERSION=17.6
# The sha256 postgresql.org publishes beside the tarball
# (https://ftp.postgresql.org/pub/source/v17.6/postgresql-17.6.tar.bz2.sha256). PINNED, and
# the two must be bumped together: without it, TLS to one host is the only thing standing
# between a compromised mirror and a binary that is handed the production connection string
# every night. `--check` FAILS THE BUILD, which is the only acceptable outcome — a backup
# binary of unknown provenance is worse than no backup lane.
ARG PG_SHA256=e0630a3600aea27511715563259ec2111cd5f4353a4b040e0be827f94cd7a8b0
RUN yum install -y gcc make tar bzip2 bison flex perl zlib-devel openssl11-devel \
    && yum clean all
RUN curl -fsSL -o /tmp/pg.tar.bz2 \
      "https://ftp.postgresql.org/pub/source/v${PG_VERSION}/postgresql-${PG_VERSION}.tar.bz2" \
 && echo "${PG_SHA256}  /tmp/pg.tar.bz2" | sha256sum --check --strict - \
 && mkdir -p /tmp/src && tar -xjf /tmp/pg.tar.bz2 -C /tmp/src --strip-components=1
# Only libpq and pg_dump get built — not a server, not psql, not the test suite.
RUN cd /tmp/src \
 && ./configure --prefix=/opt/pg17 --with-openssl \
      --without-icu --without-readline --without-libxml --without-lz4 --without-zstd \
      CPPFLAGS="-I/usr/include/openssl11" \
      LDFLAGS="-L/usr/lib64/openssl11 -Wl,-rpath,/opt/pg17/lib" \
 && make -s -j"$(nproc)" -C src/interfaces/libpq install \
 && make -s -j"$(nproc)" -C src/bin/pg_dump install \
 && /opt/pg17/bin/pg_dump --version

# --- stage 2: the bots ---------------------------------------------------------------------
FROM public.ecr.aws/lambda/python:3.11

# openssl11-libs is the runtime half of what stage 1 linked against (libssl/libcrypto 1.1);
# without it the copied binary fails to load, at 08:23 UTC, in a backup lane.
RUN yum install -y openssl11-libs && yum clean all
COPY --from=pgdump-build /opt/pg17/bin/pg_dump /opt/pg17/bin/pg_dump
COPY --from=pgdump-build /opt/pg17/lib/libpq.so.5* /opt/pg17/lib/
# The binary carries -Wl,-rpath,/opt/pg17/lib, so libpq resolves without touching
# LD_LIBRARY_PATH — which on this base names the paths the Python runtime itself loads
# from, and overwriting it to fix a backup would break every other bot in the image.
# Fail the BUILD, not the 3 a.m. backup, if the binary or its libraries did not make it
# across — the same posture infra/render/Dockerfile takes with its theme allowlist.
RUN /opt/pg17/bin/pg_dump --version | grep -q " 17\."

# Python deps first (own layer, cached across code changes). Pins come from requirements.txt.
COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

# Only what the bots import — no webapp/, resume/, secrets, or migrations.
COPY core/          ${LAMBDA_TASK_ROOT}/core/
COPY monitor/       ${LAMBDA_TASK_ROOT}/monitor/
COPY tracker/       ${LAMBDA_TASK_ROOT}/tracker/
# users/<name>/profile.yaml IS runtime input, not documentation: core/profile.py
# reads it for the search AND for the notification channel. Left out of the
# image, every user's lane silently falls back to the committed defaults — i.e.
# Salman's PM search and a phone push for someone who asked for email only.
COPY users/         ${LAMBDA_TASK_ROOT}/users/
COPY hq.config.yaml ${LAMBDA_TASK_ROOT}/
COPY infra/app/handler.py ${LAMBDA_TASK_ROOT}/

# Drop test files + caches that ride along inside the packages (smaller image, no test deps).
RUN find ${LAMBDA_TASK_ROOT} -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true

# handler.py:handler — EventBridge Scheduler passes {"job": "<name>"}.
CMD ["handler.handler"]
