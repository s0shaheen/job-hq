# The verification image: every gate this repo has, already installed.
#
# WHY THIS EXISTS. A three-line fix used to cost a full-gate run in which most of
# the wall clock was not testing. Each agent started its own `postgres:16`
# container, re-resolved `uv --with-requirements requirements.txt` from scratch,
# re-resolved a SECOND 3.12 set for the render suite (rendercv + typst + pypdf +
# rendercv-fonts, ~200 MB of wheels), and re-downloaded Playwright browsers.
# None of that is a property of the change under test, so none of it belongs in
# the loop. This image pays it once.
#
# BASE. `mcr.microsoft.com/playwright:v1.61.1-noble` — the SAME image the `visual`
# job in .github/workflows/ci.yml runs in, and therefore the one the committed
# `-linux` screenshot baselines were recorded in. Any other base makes the visual
# suite meaningless here.
#
# FONTS ARE FROZEN. Font metrics decide line breaks; line breaks decide page
# counts (the per-theme one-page résumé gate) and pixel baselines (visual.spec.ts).
# One agent installed extra system fonts into an ad-hoc container and then spent
# its remaining time chasing snapshot failures it had caused itself. So:
#
#   * the ONLY fonts in this image are the ones the base ships, plus the
#     `rendercv_fonts` wheel, which is a Python package inside a venv and not a
#     system font at all;
#   * the build SNAPSHOTS `fc-list` before installing anything and diffs it at the
#     end. If any apt package (postgres, node, curl, …) drags in a font, the build
#     FAILS rather than producing an image that quietly disagrees with CI.
#
# Rebuild/refresh: infra/test-image/build.sh. What invalidates it: this file,
# entrypoint.sh, requirements.txt, infra/render/requirements.txt,
# webapp/package.json, webapp/package-lock.json. Nothing else — the repo is
# MOUNTED at run time, never copied in.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive

# The font baseline, taken before a single package is installed.
RUN fc-list | sort > /opt/fonts.base && wc -l < /opt/fonts.base

# ── Postgres 16 ───────────────────────────────────────────────────────────────
# Ubuntu 24.04 (noble) ships postgresql-16 in its own archive, so no PGDG repo and
# no extra keyring. 16 is the version .github/workflows/ci.yml's `db` job uses.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16 postgresql-client-16 ca-certificates curl gnupg \
 && rm -rf /var/lib/apt/lists/*

# ── Node 22 ───────────────────────────────────────────────────────────────────
# The base ships Node 24; CI pins 22 (actions/setup-node in BOTH webapp jobs).
# The image follows CI, not the base, because a native module resolved against a
# different major is exactly the kind of difference that makes a local pass and a
# CI failure disagree.
# The base ALREADY has an apt-installed nodejs 24, so a plain `apt-get install
# nodejs` is a no-op ("already the newest version") — the first build of this
# image silently kept 24. Pinning the version and asserting it afterwards is the
# difference between following CI and believing you do.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --allow-downgrades --no-install-recommends "nodejs=22.*" \
 && rm -rf /var/lib/apt/lists/* \
 && { node -v | grep -q '^v22\.' || { echo "FATAL: CI pins Node 22; this image has $(node -v)" >&2; exit 1; }; } \
 && node -v && npm -v

# ── Python 3.11 and 3.12, both pre-resolved ───────────────────────────────────
# uv installs both interpreters; each venv is baked with its dependency set so
# that `pytest` at run time resolves nothing.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY requirements.txt /opt/build/requirements.txt
COPY render-requirements.txt /opt/build/render-requirements.txt

# 3.11 == the bots' runtime (public.ecr.aws/lambda/python:3.11) and what the
# `tests` and `db` CI jobs use. psycopg is added here for the same reason the db
# job adds it: tests/db needs a driver, and requirements.txt does not carry one.
RUN uv venv --python 3.11 /opt/py311 \
 && VIRTUAL_ENV=/opt/py311 uv pip install --python /opt/py311/bin/python \
      -r /opt/build/requirements.txt "psycopg[binary]==3.2.3"

# 3.12 == the render service. rendercv 2.8 REQUIRES >= 3.12, which is why it
# cannot share the venv above. requirements.txt goes in too, and only because
# tests/conftest.py imports core.notify — without `requests` the render job
# cannot collect a single test under tests/.
RUN uv venv --python 3.12 /opt/py312 \
 && VIRTUAL_ENV=/opt/py312 uv pip install --python /opt/py312/bin/python \
      -r /opt/build/requirements.txt -r /opt/build/render-requirements.txt

# ── webapp node_modules ───────────────────────────────────────────────────────
# `npm install`, not `npm ci`, for the reason ci.yml documents at length: Tailwind
# v4's oxide binary pulls a different optional-package set on linux-x64/arm64 than
# on darwin-arm64 and `npm ci` fails on a lockfile that is otherwise correct.
# Versions stay pinned by the lockfile either way.
#
# Baked at /opt/webapp-deps/node_modules and SYNCED into a volume at run time —
# never written into the mounted repo, whose node_modules is a macOS build.
COPY package.json package-lock.json /opt/webapp-deps/
RUN cd /opt/webapp-deps && npm install --no-audit --no-fund \
 && sha256sum /opt/webapp-deps/package-lock.json | cut -d' ' -f1 > /opt/webapp-deps/.lock-sha

# ── A Postgres cluster, initialised at build time ─────────────────────────────
# initdb is ~1.5s and does not vary by change; doing it here means a run-time
# start is a `pg_ctl start` and a readiness poll.
ENV PGDATA=/var/lib/hqpg PGBIN=/usr/lib/postgresql/16/bin
RUN mkdir -p "$PGDATA" /var/run/postgresql \
 && chown -R postgres:postgres "$PGDATA" /var/run/postgresql \
 && su postgres -c "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust --no-sync -E UTF8"

# ── The font assertion ────────────────────────────────────────────────────────
# Nothing above may have changed the system font set. rendercv's fonts arrive as
# a wheel inside /opt/py312 and are deliberately NOT registered system-wide.
RUN fc-list | sort > /opt/fonts.after \
 && if ! diff -u /opt/fonts.base /opt/fonts.after; then \
      echo "FATAL: the build changed the system font set. Fonts decide line breaks," >&2; \
      echo "which decide page counts and visual baselines. Remove the package that" >&2; \
      echo "pulled a font in, or re-record every baseline deliberately." >&2; \
      exit 1; \
    fi \
 && echo "fonts unchanged: $(wc -l < /opt/fonts.after) faces"

# What is actually in here, as a file, so a run can print its own provenance.
RUN { echo "base: mcr.microsoft.com/playwright:v1.61.1-noble"; \
      echo "built: $(date -u +%Y-%m-%dT%H:%M:%SZ)"; \
      echo "node: $(node -v)  npm: $(npm -v)"; \
      echo "uv: $(uv --version)"; \
      echo "py311: $(/opt/py311/bin/python -V 2>&1)"; \
      echo "py312: $(/opt/py312/bin/python -V 2>&1)"; \
      echo "postgres: $($PGBIN/postgres --version)"; \
      echo "rendercv: $(/opt/py312/bin/python -c "import importlib.metadata as m; print(m.version('rendercv'))")"; \
      echo "playwright browsers: $(ls /ms-playwright | tr '\n' ' ')"; \
      echo "system font faces: $(wc -l < /opt/fonts.after)"; \
    } > /opt/hq-test-image.manifest && cat /opt/hq-test-image.manifest

COPY entrypoint.sh /usr/local/bin/hq-test-entrypoint
RUN chmod +x /usr/local/bin/hq-test-entrypoint

# Read by scripts/verify.sh: inside the image the interpreters and node_modules
# are already there, so it must not fall back to `uv run --with-requirements`.
ENV HQ_TEST_IMAGE=1 \
    HQ_PY311=/opt/py311/bin/python \
    HQ_PY312=/opt/py312/bin/python \
    PYTHONDONTWRITEBYTECODE=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /repo
ENTRYPOINT ["/usr/local/bin/hq-test-entrypoint"]
CMD ["bash"]
