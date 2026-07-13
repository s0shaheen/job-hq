"""Thin Anthropic helper for structured extraction (Haiku by default).

Failure posture: callers treat None as "couldn't classify this run" and retry
next cycle — an LLM hiccup degrades to a delay, never a crash or a bad write.
"""
from __future__ import annotations

import json
import os
import re

MODEL = os.environ.get("HQ_LLM_MODEL", "claude-haiku-4-5")


def json_call(prompt: str, *, max_tokens: int = 1000, model: str | None = None) -> dict | None:
    """One prompt in, one JSON object out (None on any failure)."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
        client = anthropic.Anthropic()
        msg = client.messages.create(
            model=model or MODEL, max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
        return _extract_json(text)
    except Exception:
        return None


def _extract_json(text: str) -> dict | None:
    text = (text or "").strip()
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if m:
        text = m.group(1)
    else:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end <= start:
            return None
        text = text[start:end + 1]
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        return None
