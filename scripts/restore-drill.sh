#!/usr/bin/env bash
#
# Restore drill for the pg backup lane — the whole procedure, against a database
# nobody cares about.
#
#   scripts/restore-drill.sh
#
# WHY THIS IS A SCRIPT AND NOT A PARAGRAPH. A restore procedure that has never been
# executed is a hypothesis. The one this replaces was never run at all: the old lane
# committed dumps into git and the "restore" was `git checkout` plus hope. So this
# rehearses the real thing end to end — the same `tracker.pgdump` module the Lambda
# runs, the same flags, the same gzip, the same `psql` restore a human would perform
# from an S3 version — on a throwaway Postgres 17 in Docker.
#
# IT NEVER TOUCHES PRODUCTION, AND IT DOES NOT STUB S3. Nothing here reads the real
# SUPABASE_DB_URL (the drill exports its own). The object store is a real S3 API —
# MinIO in a container, with versioning enabled — reached by the real boto3 client
# through AWS_ENDPOINT_URL_S3, so the upload path in `tracker.pgdump` is exercised as
# written. The dump the drill restores is DOWNLOADED BACK OUT of that store: the
# module's local copy lives in a temporary directory that is gone before the restore
# starts, so nothing here can accidentally restore from a file that never landed.
#
# WHAT IT PROVES, and each of these has failed somewhere in this system before:
#   1. the module's own gates (size, gzip integrity, completion marker, no managed
#      schema rows) pass on a real pg_dump 17 artifact, not a fixture;
#   2. the object actually lands in an S3 bucket, under the key the runbook tells you
#      to fetch, and comes back byte-identical (checksum compared across the round trip);
#   3. the dump restores into an EMPTY database with ON_ERROR_STOP=1 — no ignored
#      errors, which is how a "successful" restore hides a missing table;
#   4. the restored CONTENTS match the source's fingerprint, not merely its row count,
#      and a trigger comes back ENABLED (tgenabled='O') and still refuses a forbidden
#      write. `pg_restore --disable-triggers` is not used here and must not be: a run
#      that dies midway leaves the trigger present with tgenabled='D', which every
#      "is the guard attached" sweep reports as healthy (PR #149);
#   5. `auth` — identities, sessions, refresh tokens — is NOT in the artifact and does
#      NOT appear in the restored database. That is the security boundary, and it is
#      checked against the bytes rather than against the flag meant to produce them.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_IMAGE="${HQ_DRILL_PG_IMAGE:-postgres:17}"
S3_IMAGE="${HQ_DRILL_S3_IMAGE:-minio/minio:latest}"
NET="hq-restore-drill-net"
SRV="hq-restore-drill-db"
OBJ="hq-restore-drill-s3"
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "${SRV}" "${OBJ}" >/dev/null 2>&1 || true
  docker network rm "${NET}" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT
docker rm -f "${SRV}" "${OBJ}" >/dev/null 2>&1 || true
docker network rm "${NET}" >/dev/null 2>&1 || true

# The drill body is written out rather than inlined into `docker run bash -c`: the SQL
# needs single-quoted literals, and a shell string that nests three quoting levels is
# how a drill starts silently creating identifiers instead of inserting rows.
cat > "${WORK}/drill.sh" <<'DRILL'
set -euo pipefail
SRV="$1"
OBJ="$2"
export PGPASSWORD=drill
PSQL="psql -h ${SRV} -U postgres -q -v ON_ERROR_STOP=1"

for _ in $(seq 1 60); do pg_isready -h "${SRV}" -U postgres -q && break; sleep 1; done

echo "== drill: seed a source database (public rows + an auth schema that must NOT travel)"
${PSQL} -c 'CREATE DATABASE hq_src'
${PSQL} -d hq_src <<'SQL'
CREATE TABLE public.applications (id serial primary key, company text, status text,
                                  owner_id uuid NOT NULL DEFAULT gen_random_uuid());
INSERT INTO public.applications (company, status)
  SELECT 'co-' || g, 'applied' FROM generate_series(1, 500) g;

-- A GUARD, not decoration. The restore rehearsal has to answer "did the thing that stops a
-- cross-tenant write come back ON", and PR #149's reviewer showed why: a disabled trigger
-- keeps its pg_trigger row with tgenabled = 'D', so every structural sweep that asks "is the
-- trigger attached" answers yes while the guard is off. This drill therefore restores a
-- database that HAS one and asks pg_trigger for its state, not its existence.
CREATE FUNCTION public.deny_owner_change() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'owner_id is not reassignable';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER applications_owner_locked BEFORE UPDATE ON public.applications
  FOR EACH ROW EXECUTE FUNCTION public.deny_owner_change();

CREATE SCHEMA auth;
CREATE TABLE auth.refresh_tokens (id serial primary key, token text);
INSERT INTO auth.refresh_tokens (token) VALUES ('SECRET-MUST-NOT-LEAVE-THE-DATABASE');
SQL

# The fingerprint of the real data, taken BEFORE the dump. "500 rows came back" is also what
# a restore of 500 wrong rows says; this is a value only the source database can produce.
SRC_SUM=$(psql -h "${SRV}" -U postgres -tAc \
  "SELECT md5(string_agg(company || ':' || status, ',' ORDER BY id)) FROM public.applications" \
  -d hq_src)
echo "  source fingerprint: ${SRC_SUM}"
[ -n "${SRC_SUM}" ] || { echo "FAIL: could not fingerprint the source"; exit 1; }

echo "== drill: a real S3 API (MinIO), versioned, with the real boto3 client"
apt-get -qq update >/dev/null
apt-get -qq install -y python3 python3-pip >/dev/null
# boto3 is deliberately absent from requirements.txt (it ships in the Lambda image), so
# the drill installs the real one rather than standing in a fake. The whole point of this
# rewrite is that the upload is not stubbed.
pip3 -q install --break-system-packages boto3 >/dev/null

export AWS_ACCESS_KEY_ID=drillkey
export AWS_SECRET_ACCESS_KEY=drillsecret
export AWS_DEFAULT_REGION=us-east-1
# botocore reads this; `tracker.pgdump` calls plain boto3.client("s3") with no endpoint
# argument, exactly as it does on Lambda. Nothing about the module is drill-aware.
export AWS_ENDPOINT_URL_S3="http://${OBJ}:9000"

python3 - <<'PY'
import os, time, boto3, botocore
s3 = boto3.client("s3")
for _ in range(60):                       # MinIO needs a moment to come up
    try:
        s3.list_buckets(); break
    except botocore.exceptions.EndpointConnectionError:
        time.sleep(1)
s3.create_bucket(Bucket="drill-bucket")
# Versioning IS the history in production (infra/terraform/backups.tf), so the drill's
# store is versioned too — a restore is "give me a version", and that has to be a thing
# the rehearsal can actually do.
s3.put_bucket_versioning(Bucket="drill-bucket",
                         VersioningConfiguration={"Status": "Enabled"})
print("  bucket drill-bucket created, versioning enabled")
PY

echo "== drill: run the real tracker.pgdump"
export PYTHONPATH=/repo
export SUPABASE_DB_URL="postgresql://postgres:drill@${SRV}:5432/hq_src"
export HQ_BACKUP_S3_BUCKET=drill-bucket
export HQ_PGDUMP_BIN=/usr/lib/postgresql/17/bin/pg_dump
# The floor exists to catch a dump of the wrong (or emptied) database. A 500-row toy is
# legitimately below the production floor, so the drill lowers it — and ONLY the drill:
# the deployed lane runs on the default.
export HQ_PGDUMP_MIN_BYTES=500
export PGSSLMODE=disable            # the throwaway server has no TLS; production requires it
cd /repo && python3 -m tracker.pgdump
# The module staged its dump in a TemporaryDirectory that no longer exists. Anything
# restored below therefore came out of the object store or came from nowhere.
#
# The glob is the point. This line used to read `test ! -e /tmp/dump.sql.gz`, a path
# `tracker.pgdump` never writes — true for the wrong reason, and it would have stayed true
# if the module started leaving its staging file behind. `TemporaryDirectory(prefix=
# "hq-pgdump-")` is what it actually creates, so that is what gets checked.
if ls -d /tmp/hq-pgdump-* >/dev/null 2>&1; then
  echo "FAIL: the module left its staging directory behind:"; ls -d /tmp/hq-pgdump-*
  echo "      The restore below would no longer prove the object came out of S3."; exit 1
fi
test ! -e /tmp/dump.sql.gz          # and the file the S3 fetch is about to create is not there yet

echo "== drill: fetch the object back out of S3, by version, the way the runbook says"
python3 - <<'PY'
import hashlib, boto3
s3 = boto3.client("s3")
key = "pgdump/public.sql.gz"
versions = s3.list_object_versions(Bucket="drill-bucket", Prefix=key).get("Versions", [])
assert versions, "nothing landed in the bucket"
vid = versions[0]["VersionId"]
body = s3.get_object(Bucket="drill-bucket", Key=key, VersionId=vid)["Body"].read()
open("/tmp/dump.sql.gz", "wb").write(body)
print("  s3://drill-bucket/%s version %s: %d bytes, sha256 %s"
      % (key, vid[:12], len(body), hashlib.sha256(body).hexdigest()[:16]))
# The upload is not the proof; the round trip is. ETag is the MD5 of a single-part
# upload, so a corrupted transfer in either direction fails right here.
etag = versions[0]["ETag"].strip('"')
assert etag == hashlib.md5(body).hexdigest(), "round trip changed the bytes"
print("  ETag matches the downloaded bytes")
PY
gunzip -t /tmp/dump.sql.gz            # integrity, before anything is trusted

echo "== drill: restore into an EMPTY database, ON_ERROR_STOP=1"
${PSQL} -c 'CREATE DATABASE hq_restored'
# DROP the target schema first. A single-schema dump carries `CREATE SCHEMA public`, and
# every freshly created database already has one — so a restore into a "clean" database
# fails on its second statement. The drill found that on its first run, which is the
# entire argument for having a drill. Dropping it here, explicitly, beats teaching the
# dump to carry DROP statements: the destructive step stays visible to the human running
# the restore instead of hiding inside the artifact.
${PSQL} -d hq_restored -c 'DROP SCHEMA IF EXISTS public CASCADE'
gunzip -c /tmp/dump.sql.gz | ${PSQL} -d hq_restored

echo "== drill: verify"
rows=$(psql -h "${SRV}" -U postgres -tAc 'SELECT count(*) FROM public.applications' -d hq_restored)
[ "${rows}" = "500" ] || { echo "FAIL: restored ${rows} rows, expected 500"; exit 1; }
echo "  public.applications: ${rows} rows restored"

# The positive that a lane doing NOTHING cannot fake. A row count is satisfied by 500 rows of
# anything; this is satisfied only by the source database's actual contents.
GOT_SUM=$(psql -h "${SRV}" -U postgres -tAc \
  "SELECT md5(string_agg(company || ':' || status, ',' ORDER BY id)) FROM public.applications" \
  -d hq_restored)
[ "${GOT_SUM}" = "${SRC_SUM}" ] || {
  echo "FAIL: restored contents differ (${GOT_SUM} != ${SRC_SUM})"; exit 1; }
echo "  contents fingerprint matches the source: ${GOT_SUM}"

# tgenabled, not existence. 'O' = fires normally; 'D' = present in the catalogue and OFF,
# which is what a half-finished `pg_restore --disable-triggers` leaves behind and what every
# "is the trigger attached" check reports as healthy (PR #149).
state=$(psql -h "${SRV}" -U postgres -tAc \
  "SELECT tgenabled FROM pg_trigger WHERE tgname = 'applications_owner_locked' AND NOT tgisinternal" \
  -d hq_restored)
[ "${state}" = "O" ] || {
  echo "FAIL: trigger applications_owner_locked is tgenabled='${state:-missing}', not 'O'"
  echo "      A restored database whose guards are present but disabled is the worst case:"
  echo "      it passes every structural check and enforces nothing."; exit 1; }
echo "  trigger applications_owner_locked: tgenabled='O' (enabled, not merely present)"

# And prove the guard actually bites, because tgenabled is a catalogue answer too.
if psql -h "${SRV}" -U postgres -q -d hq_restored \
     -c "UPDATE public.applications SET owner_id = gen_random_uuid() WHERE id = 1" 2>/dev/null; then
  echo "FAIL: the restored trigger did not block a forbidden update"; exit 1
fi
echo "  the restored trigger refused a forbidden update"

if gunzip -c /tmp/dump.sql.gz | grep -q 'SECRET-MUST-NOT-LEAVE-THE-DATABASE'; then
  echo "FAIL: auth data is in the artifact"; exit 1
fi
echo "  auth token: absent from the artifact"

leaked=$(psql -h "${SRV}" -U postgres -tAc \
  "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'auth'" -d hq_restored)
[ "${leaked}" = "0" ] || { echo "FAIL: auth schema present in the restored database"; exit 1; }
echo "  auth schema: absent from the restored database"
DRILL

echo "== drill: throwaway Postgres 17 (${PG_IMAGE}) and object store (${S3_IMAGE})"
# Idempotent: a drill killed mid-run (a stalled agent, a ^C) leaves the network behind
# attached to containers that are still shutting down, and `network rm` on a busy network
# is a no-op. A hard `network create` then fails on the NEXT run — which is a rehearsal
# refusing to rehearse because the last rehearsal was interrupted.
docker network inspect "${NET}" >/dev/null 2>&1 || docker network create "${NET}" >/dev/null
docker run -d --name "${SRV}" --network "${NET}" \
  -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=postgres "${PG_IMAGE}" >/dev/null
docker run -d --name "${OBJ}" --network "${NET}" \
  -e MINIO_ROOT_USER=drillkey -e MINIO_ROOT_PASSWORD=drillsecret \
  "${S3_IMAGE}" server /data >/dev/null

docker run --rm --network "${NET}" \
  -v "${REPO_ROOT}:/repo:ro" -v "${WORK}:/drill:ro" \
  "${PG_IMAGE}" bash /drill/drill.sh "${SRV}" "${OBJ}"

echo "== drill: PASSED"
