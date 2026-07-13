#!/usr/bin/env python3
"""Publish rendered resume artifacts to Drive via the Apps Script uploader.

Why Apps Script and not the Sheets service account: Google gives service
accounts zero storage quota in consumer My Drive, so their uploads hard-fail;
the web app runs as Salman and he owns every file it writes. Contract per file
(one POST each, JSON body): {token, target, label, filename, content_b64, mime}
where target is "current" | "current-alt" | "archive". current/current-alt hold
the latest send-ready pair (uploader replaces in place); archive accumulates
stamped snapshots so any previously-sent resume stays reconstructable — the
stamp lives in the filename so uniqueness never depends on the uploader.

stdlib + requests only, so it runs identically in CI and on the Mac.

Usage: python scripts/publish_to_drive.py [--label "..."] [--dry-run]
Env:   APPSSCRIPT_UPLOAD_URL, APPSSCRIPT_UPLOAD_SECRET
"""
from __future__ import annotations

import argparse
import base64
import datetime
import os
import sys
import time
from pathlib import Path

import requests

BASENAME = "Salman_Shaheen_Resume"
RETRIES = 3
BACKOFF_S = 2.0    # 2s then 4s between the three attempts
TIMEOUT_S = 120    # Apps Script cold starts are slow; payloads are ~0.5MB b64
MIME = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".yaml": "application/x-yaml",
}


class PublishError(RuntimeError):
    """Anything that must stop the publish: missing artifact, exhausted retries."""


def default_stamp(now: datetime.datetime | None = None) -> str:
    """UTC date + short commit sha (when run in Actions) for archive filenames."""
    d = (now or datetime.datetime.now(datetime.timezone.utc)).strftime("%Y-%m-%d")
    sha = os.environ.get("GITHUB_SHA", "")[:7]
    return f"{d}_{sha}" if sha else d


def build_manifest(repo_root: Path, stamp: str) -> list[dict]:
    """Every file one publish sends. Fails loud, naming ALL missing artifacts at
    once — a partial upload set must never reach Drive."""
    base = repo_root / "resume" / "out"
    alt = repo_root / "resume" / "out-alt"
    plan = [
        ("current",     f"{BASENAME}.pdf",             base / f"{BASENAME}.pdf"),
        ("current",     f"{BASENAME}.docx",            base / f"{BASENAME}.docx"),
        ("current-alt", f"{BASENAME}.pdf",             alt / f"{BASENAME}.pdf"),
        ("current-alt", f"{BASENAME}.docx",            alt / f"{BASENAME}.docx"),
        ("archive",     f"{stamp}_{BASENAME}.pdf",     base / f"{BASENAME}.pdf"),
        ("archive",     f"{stamp}_{BASENAME}_alt.pdf", alt / f"{BASENAME}.pdf"),
        ("archive",     f"{stamp}_base.yaml",          repo_root / "resume" / "base.yaml"),
    ]
    missing = [str(p) for _, _, p in plan if not p.is_file()]
    if missing:
        raise PublishError(
            "missing artifacts (run the render steps first):\n  " + "\n  ".join(missing))
    return [{"target": t, "filename": f, "path": p, "mime": MIME[p.suffix]}
            for t, f, p in plan]


def payload_for(item: dict, token: str, label: str) -> dict:
    return {
        "token": token,
        "target": item["target"],
        "label": label,
        "filename": item["filename"],
        "content_b64": base64.b64encode(item["path"].read_bytes()).decode("ascii"),
        "mime": item["mime"],
    }


def _outcome(resp) -> tuple[bool, str]:
    """Success means HTTP 200 AND a JSON body with ok=true — Apps Script returns
    200 HTML pages for auth/deployment problems, which must count as failure."""
    if resp.status_code != 200:
        return False, f"HTTP {resp.status_code}: {resp.text[:200]}"
    try:
        body = resp.json()
    except ValueError:
        return False, f"non-JSON response: {resp.text[:200]}"
    if isinstance(body, dict) and body.get("ok"):
        return True, ""
    return False, f"uploader rejected: {str(body)[:200]}"


def post_with_retry(url: str, payload: dict, *, retries: int = RETRIES,
                    backoff_s: float = BACKOFF_S, sleep=time.sleep) -> None:
    """Retries network errors, non-200s, and ok!=true bodies alike — Apps Script
    hiccups often present as transient HTML, not clean 5xx."""
    last = ""
    for attempt in range(1, retries + 1):
        try:
            resp = requests.post(url, json=payload, timeout=TIMEOUT_S)
            ok, last = _outcome(resp)
            if ok:
                return
        except requests.RequestException as e:
            last = f"request failed: {e}"
        if attempt < retries:
            sleep(backoff_s * (2 ** (attempt - 1)))
    raise PublishError(f"{payload['target']}/{payload['filename']}: "
                       f"gave up after {retries} attempts — {last}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--label", default="",
                    help="human label for this publish (text after 'resume:' in the commit)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the manifest and upload nothing")
    ap.add_argument("--repo-root", type=Path,
                    default=Path(__file__).resolve().parents[1])
    args = ap.parse_args(argv)

    try:
        manifest = build_manifest(args.repo_root, default_stamp())
    except PublishError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    if args.dry_run:
        for item in manifest:
            print(f"{item['target']:12s} {item['filename']:50s} "
                  f"{item['path'].stat().st_size:>8d}B  {item['mime']}")
        print(f"label: {args.label!r} — dry run, nothing uploaded")
        return 0

    url = os.environ.get("APPSSCRIPT_UPLOAD_URL", "")
    token = os.environ.get("APPSSCRIPT_UPLOAD_SECRET", "")
    if not url or not token:
        print("ERROR: APPSSCRIPT_UPLOAD_URL and APPSSCRIPT_UPLOAD_SECRET must be set "
              "(or use --dry-run)", file=sys.stderr)
        return 2

    try:
        for item in manifest:
            post_with_retry(url, payload_for(item, token, args.label))
            print(f"uploaded {item['target']}/{item['filename']}")
    except PublishError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    print(f"published {len(manifest)} files"
          + (f" (label: {args.label})" if args.label else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
