#!/usr/bin/env bash
# Bring the image's services up, then exec the command.
#
# Three things happen here and nothing else: Postgres starts and DATABASE_URL is
# exported, the prebuilt linux node_modules is synced into its volume, and the
# command runs. Everything expensive already happened at build time.
set -euo pipefail

log() { printf '[test-image] %s\n' "$*" >&2; }
die() { printf '[test-image] FATAL: %s\n' "$*" >&2; exit 1; }

# ── the repo must be mounted, not baked ───────────────────────────────────────
[[ -f /repo/hq.config.yaml && -d /repo/webapp ]] \
  || die "/repo is not a Job HQ checkout. Run through scripts/test-shell.sh, which mounts it."

# ── node_modules ──────────────────────────────────────────────────────────────
# The mounted repo carries a macOS node_modules (native oxide/esbuild binaries
# that cannot run here). It must be shadowed by a volume, and we refuse to
# proceed if it is not — writing linux modules into the host checkout would break
# the developer's own `npm run dev` and is not ours to do.
NM=/repo/webapp/node_modules
if [[ "${HQ_SKIP_NODE_MODULES:-0}" != "1" ]]; then
  mountpoint -q "$NM" \
    || die "$NM is not a mount point. scripts/test-shell.sh mounts a volume there so the host's macOS node_modules is never touched."
  want=$(cat /opt/webapp-deps/.lock-sha)
  have=$(cat "$NM/.hq-lock-sha" 2>/dev/null || echo none)
  if [[ "$want" != "$have" ]]; then
    log "syncing node_modules (lockfile $want, volume had $have) — once per lockfile change"
    rm -rf "${NM:?}/"* "${NM:?}/".[!.]* 2>/dev/null || true
    cp -a /opt/webapp-deps/node_modules/. "$NM/"
    printf '%s\n' "$want" > "$NM/.hq-lock-sha"
    log "node_modules ready"
  fi
fi

# ── Postgres ──────────────────────────────────────────────────────────────────
# initdb already ran at build time. `trust` auth on loopback only, inside a
# container with no published ports: the password in DATABASE_URL is ignored and
# is there because the connection string format wants one.
if [[ "${HQ_SKIP_POSTGRES:-0}" != "1" ]]; then
  chown -R postgres:postgres "$PGDATA" /var/run/postgresql
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA -l /tmp/pg.log -o '-c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off -c synchronous_commit=off' -w start" >/dev/null \
    || { cat /tmp/pg.log >&2; die "postgres failed to start"; }
  for _ in $(seq 1 40); do
    "$PGBIN/pg_isready" -h 127.0.0.1 -q && break
    sleep 0.25
  done
  "$PGBIN/pg_isready" -h 127.0.0.1 -q || { cat /tmp/pg.log >&2; die "postgres never became ready"; }
  export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/postgres"
  log "postgres 16 up; DATABASE_URL exported"
fi

cd /repo
exec "$@"
