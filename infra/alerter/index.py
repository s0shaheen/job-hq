"""CloudWatch alarm -> ntfy bridge (SNS-subscribed).

This is the Lambda-side replacement for the "Ops alert on failure" step every GitHub Actions
workflow carried. Deliberately stdlib-only and dependency-free: it has to work on the days the
bots' container image does NOT (a bad build, an import error, an OOM kill). Terraform passes the
ops topic in OPS_NTFY_TOPIC, read from hq.config.yaml at apply time, so there is no SSM, IAM or
network dependency at alert time beyond ntfy.sh itself.

Fail loud: a failed push raises, so SNS retries the delivery and this function's own Errors
metric records it — a swallowed alert is indistinguishable from a healthy system.
"""
from __future__ import annotations

import json
import os
import urllib.request

NTFY = "https://ntfy.sh"
TIMEOUT = 10


def _format(message: str) -> tuple[str, str, bool]:
    """(title, body, is_alarm) for one SNS message.

    Handles the CloudWatch alarm JSON envelope, and falls back to the raw string for anything
    else — a hand-published `aws sns publish` test must still reach the phone, not blow up.
    """
    try:
        a = json.loads(message)
        name = a["AlarmName"]
    except Exception:
        return "HQ bots: ops alert", str(message)[:900], True
    ok = a.get("NewStateValue") == "OK"
    title = f"HQ bots {'recovered' if ok else 'ALARM'}: {name}"
    body = "\n".join(p for p in (a.get("AlarmDescription"), a.get("NewStateReason")) if p)
    return title, body[:900], not ok


def _push(title: str, body: str, alarm: bool) -> None:
    topic = os.environ["OPS_NTFY_TOPIC"]          # unset = misconfigured; fail loud, don't guess
    headers = {
        # http.client headers must be latin-1; emoji belong in Tags (same rule as core/notify.py)
        "Title": title.encode("latin-1", "replace").decode("latin-1"),
        "Priority": "high" if alarm else "default",
        "Tags": "warning" if alarm else "white_check_mark",
    }
    click = os.environ.get("LOG_GROUP_URL", "")
    if click:
        headers["Click"] = click
    req = urllib.request.Request(f"{NTFY}/{topic}", data=(body or title).encode("utf-8"),
                                headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        print(f"[alerter] ntfy {r.status} title={title!r}")


def handler(event, context):
    records = (event or {}).get("Records") or []
    if not records:                    # direct invoke (smoke test): alert on the raw event
        records = [{"Sns": {"Message": json.dumps(event or {})}}]
    for rec in records:
        print(f"[alerter] sns: {json.dumps(rec.get('Sns', {}).get('Message', ''))[:500]}")
        _push(*_format(rec.get("Sns", {}).get("Message", "")))
    return {"pushed": len(records)}
