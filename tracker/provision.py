"""Provision a new HQ user (entry: python -m tracker.provision).

    python -m tracker.provision --user dad --sheet-id ID --owner EMAIL \
        [--ntfy-jobs TOPIC] [--ntfy-ops TOPIC] [--seed-companies] [--dry-run]

One command, because "add a person" must not be an 8-step ritual only the
author can perform. It:
  1. validates that users/<name>/profile.yaml exists (the search IS the config)
  2. runs the normal bootstrap against that person's spreadsheet
  3. writes their instance into hq.config.yaml under users:<name>, MIGRATING a
     flat single-user file into the multi-user shape on first use
  4. seeds their Config tab from the committed defaults + their profile

What it deliberately does NOT do: create the spreadsheet (Salman creates it
and shares it with the service account — one manual click that keeps Drive
ownership with the human), or deploy the Gmail capture Apps Script (a
per-account OAuth consent that cannot be automated; appsscript/README.md).

Re-runnable: bootstrap is idempotent and the registry write is a merge.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

from core import config
from core.profile import Profile
from tracker import bootstrap


def load_doc(path: Path) -> dict:
    if not path.exists():
        return {}
    with open(path) as f:
        return yaml.safe_load(f) or {}


def to_multi_user(doc: dict, default_user: str) -> dict:
    """Flat single-user registry -> {users: {<default_user>: <flat>}}.

    The existing instance keeps working untouched: it simply becomes the
    default_user, so any run without HQ_USER resolves exactly as before.
    """
    if doc.get("users"):
        return doc
    flat = {k: v for k, v in doc.items() if k not in ("users", "default_user")}
    if not flat:
        return {"users": {}, "default_user": default_user}
    # service_account_email is shared infrastructure, not per-user: hoist it so
    # it is stated once and every instance inherits it.
    shared = {}
    for k in ("service_account_email",):
        if k in flat:
            shared[k] = flat.pop(k)
    return {**shared, "users": {default_user: flat}, "default_user": default_user}


def instance_block(*, sheet_id: str, owner: str, ntfy_jobs: str, ntfy_ops: str,
                   existing: dict | None = None) -> dict:
    inst = dict(existing or {})
    inst["sheet_id"] = sheet_id
    inst["owner_email"] = owner
    ntfy = dict(inst.get("ntfy") or {})
    if ntfy_jobs:
        ntfy["jobs"] = ntfy_jobs
    if ntfy_ops:
        ntfy["ops"] = ntfy_ops
    if ntfy:
        inst["ntfy"] = ntfy
    return inst


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Provision an HQ user")
    ap.add_argument("--user", required=True, help="short name, e.g. dad")
    ap.add_argument("--sheet-id", required=True,
                    help="their spreadsheet id (create it, share it with the SA)")
    ap.add_argument("--owner", required=True, help="their Google account email")
    ap.add_argument("--ntfy-jobs", default="", help="their job-alert ntfy topic")
    ap.add_argument("--ntfy-ops", default="",
                    help="ops topic — point at the OPERATOR, not the user")
    ap.add_argument("--existing-user", default="salman",
                    help="name to give the current flat instance when migrating")
    ap.add_argument("--seed-companies", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(sys.argv[1:] if argv is None else argv)

    prof_path = config.REPO_ROOT / "users" / a.user / "profile.yaml"
    if not prof_path.exists():
        print(f"[provision] no profile at {prof_path} — write the Search Profile "
              f"first (see users/dad/profile.yaml for the shape)", file=sys.stderr)
        return 1
    prof = Profile.load(a.user)
    print(f"[provision] {a.user}: {prof.role_family} · tag_domain={prof.tag_domain} "
          f"· metros={prof.metros or ['(any in ' + ', '.join(prof.countries) + ')']} "
          f"· {len(prof.titles_include)} title patterns", file=sys.stderr)

    reg_path = bootstrap.registry_path()
    doc = to_multi_user(load_doc(reg_path), a.existing_user)
    users = dict(doc.get("users") or {})
    users[a.user] = instance_block(sheet_id=a.sheet_id, owner=a.owner,
                                   ntfy_jobs=a.ntfy_jobs, ntfy_ops=a.ntfy_ops,
                                   existing=users.get(a.user))
    doc["users"] = users
    doc.setdefault("default_user", a.existing_user)

    if a.dry_run:
        print("[provision] --dry-run; registry WOULD become:\n"
              + yaml.safe_dump(doc, sort_keys=False), file=sys.stderr)
        return 0

    # bootstrap writes tab gids into the instance block, so hand it the same
    # sheet and merge its result back under this user.
    import os
    os.environ["HQ_USER"] = a.user
    bootstrap.write_registry(doc, reg_path)     # instance visible to bootstrap
    rc = bootstrap.main(["--sheet-id", a.sheet_id, "--owner", a.owner,
                         "--sa-email", doc.get("service_account_email", "")]
                        + (["--seed-companies"] if a.seed_companies else []))
    if rc != 0:
        print("[provision] bootstrap failed — registry left as written; re-run "
              "after fixing the sheet", file=sys.stderr)
        return rc

    print(f"[provision] {a.user} provisioned.\n"
          f"  next, by hand (they cannot be automated):\n"
          f"   1. share the sheet with {doc.get('service_account_email','the service account')} as Editor\n"
          f"   2. deploy the Gmail capture Apps Script in THEIR account "
          f"(appsscript/README.md) so statuses auto-advance\n"
          f"   3. add their user name to the Actions matrix in "
          f".github/workflows/*.yml (or set HQ_USERS repo variable)",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
