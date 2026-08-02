# The verification image

Every gate this repo has, already installed. Build it once; run gates in it forever.

```sh
infra/test-image/build.sh          # ~6 min cold, ~1 min when only npm deps moved
scripts/test-shell.sh              # interactive shell, Postgres already up
scripts/test-shell.sh pytest tests/core -q
scripts/verify.sh --image          # the change-scoped lane, inside the image
scripts/verify.sh --full --image   # the real full gate
```

## Why

Verification used to cost more than implementation. Each agent working a
three-line fix started its own `postgres:16` container, re-resolved
`uv --with-requirements requirements.txt` from scratch, re-resolved a *second*
Python 3.12 set for the render suite (rendercv + typst + pypdf + rendercv-fonts),
and pulled Playwright browsers. None of that is a property of the change under
test. The image pays it once.

## What it pins, and why that exact thing

| | pinned to | because |
|---|---|---|
| base | `mcr.microsoft.com/playwright:v1.61.1-noble` | the exact image the `visual` job in `.github/workflows/ci.yml` runs in, and therefore the one the committed `-linux` screenshot baselines were recorded in |
| Node | 22.x (asserted at build) | both webapp CI jobs pin 22 via `actions/setup-node`. The base ships **24**, so a plain `apt-get install nodejs` is a silent no-op — the first build of this image kept 24 until the assertion caught it |
| Python | 3.11 **and** 3.12, both pre-resolved | 3.11 is the bots' runtime (`public.ecr.aws/lambda/python:3.11`) and what CI's `tests` and `db` jobs use. rendercv 2.8 requires ≥ 3.12, which is why `infra/render/` cannot share the venv |
| Postgres | 16 | what CI's `db` job services |
| npm deps | `webapp/package-lock.json`, installed with `npm install` | not `npm ci`, for the reason `ci.yml` documents: Tailwind v4's oxide binary pulls a different optional-package set per platform and `npm ci` fails on a lockfile that is otherwise correct. Versions stay pinned by the lockfile |
| browsers | whatever the base ships (`chromium-1228`, …) | changing them changes rendering |

## Fonts are frozen. This is not a detail.

Font metrics decide line breaks. Line breaks decide **page counts** — the
per-theme one-page résumé gate in `tests/infra/test_render_live.py` — and
**pixel baselines** — `webapp/tests/e2e/visual.spec.ts`. An agent that installed
extra system fonts into an ad-hoc container spent the rest of its run chasing
snapshot failures it had caused itself.

So the image contains **exactly the fonts the base ships (50 faces), plus
`rendercv_fonts`** — and `rendercv_fonts` is a Python wheel inside
`/opt/py312`, not a system font: `fc-list` never sees it, which is precisely
what makes it safe.

The build enforces this. It snapshots `fc-list` before installing anything and
diffs it at the end; if any package (postgres, node, curl, …) drags a font in,
**the build fails** rather than producing an image that quietly disagrees with
CI. If you ever need to change this, you are re-recording every visual baseline
and re-checking every one-page gate, deliberately, as its own change.

## What invalidates it

Six files, and nothing else:

```
infra/test-image/Dockerfile
infra/test-image/entrypoint.sh
requirements.txt
infra/render/requirements.txt
webapp/package.json
webapp/package-lock.json
```

The build context is *assembled* from those six — the repo is never copied in,
it is **mounted** at run time. So editing source code never invalidates the
image, and a dependency change always does.

`build.sh` tags the image `hq-test:<sha256-of-those-six>` as well as
`hq-test:latest`, and `scripts/test-shell.sh` recomputes that hash on every run.
A stale image is therefore a printed warning, not something you find out about
from a confusing test failure.

## How a run is wired

`scripts/test-shell.sh` mounts the checkout at `/repo` read-write, so results
land where you can see them. Two paths are deliberately **shadowed** by
container-local volumes:

- `webapp/node_modules` — the host's is a macOS build whose native binaries
  cannot run here, and writing linux ones over it would break the host's own
  `npm run dev`. The entrypoint syncs the image's prebuilt copy into the volume
  once per lockfile change (a few seconds), then never again.
- `webapp/.next` — a build produced in here is not the build the host dev server
  should pick up.

The entrypoint then starts the build-time-initialised Postgres cluster
(`fsync=off`, loopback only, `trust` auth inside a container with no published
ports) and exports `DATABASE_URL`. Nothing else happens; everything expensive
already happened at build time.

Git is *not* usable inside the container when the checkout is a worktree — a
worktree's `.git` is a file pointing into the parent repo, which is not mounted.
Nothing needs it: `scripts/verify.sh --image` resolves the changed paths on the
host and hands them in through `HQ_VERIFY_PATHS`.

## Refreshing

```sh
infra/test-image/build.sh              # rebuild; layer cache does the thinking
infra/test-image/build.sh --no-cache   # when you suspect the cache, not the code
docker volume rm $(docker volume ls -q --filter name=hq-test-)   # drop the node_modules/.next volumes
```

The image is ~4.3 GB. That is Playwright's five browsers (~1.5 GB), two Python
environments, and 500 MB of node_modules — all of it stuff that was previously
being fetched or resolved per agent, per run.
