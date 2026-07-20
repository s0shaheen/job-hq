"""ntfy pushes for the whole system.

Two topics, resolved from env first (Actions secrets) then hq.config.yaml:
  HQ_NTFY_TOPIC     — Salman's phone: new matching jobs, status events, digest ping
  HQ_OPS_NTFY_TOPIC — ops/failures only

Header values must be latin-1 (http.client); anything else is replaced so a
stray emoji can never crash a send. Emoji belong in the Tags header.
"""
from __future__ import annotations

import os

import requests

TIMEOUT = 15


def _header_safe(value: str) -> str:
    return (value or "").encode("latin-1", "replace").decode("latin-1")


def _topic(kind: str, user: str | None = None) -> str:
    """Per-user topic from the registry; env override only in single-user mode
    (a matrix leg exporting one HQ_NTFY_TOPIC would page the wrong person)."""
    from core.config import registry, users as _users
    multi = bool(_users())
    if not multi:
        env = "HQ_OPS_NTFY_TOPIC" if kind == "ops" else "HQ_NTFY_TOPIC"
        t = os.environ.get(env, "")
        if t:
            return t
    try:
        return registry(user)["ntfy"]["ops" if kind == "ops" else "jobs"]
    except Exception:
        return ""


def push(title: str, body: str, *, kind: str = "jobs", tags: list[str] | None = None,
         priority: str = "default", click: str = "", attach: str = "",
         session: requests.Session | None = None, user: str | None = None) -> bool:
    """Send a push. Returns False (never raises) when the topic is unset or the
    send fails — notification failure must never fail a pipeline. `user`
    selects whose topic in a multi-user registry (default: HQ_USER)."""
    topic = _topic(kind, user)
    if not topic:
        return False
    headers = {"Title": _header_safe(title), "Priority": priority, "Markdown": "yes"}
    if tags:
        headers["Tags"] = _header_safe(",".join(tags))
    if click:
        headers["Click"] = _header_safe(click)
    if attach:
        headers["Attach"] = _header_safe(attach)
    try:
        s = session or requests
        s.post(f"https://ntfy.sh/{topic}", data=(body or "").encode("utf-8"),
               headers=headers, timeout=TIMEOUT)
        return True
    except Exception:
        return False


def ops_alert(title: str, body: str, session: requests.Session | None = None,
              user: str | None = None) -> bool:
    """Ops alerts go to the OPERATOR's topic. In a multi-user registry that is
    still each instance's `ntfy.ops` — point every user's ops topic at the
    operator so a dad-instance failure pages the person who can fix it."""
    return push(title, body, kind="ops", tags=["warning"], priority="high",
                session=session, user=user)
