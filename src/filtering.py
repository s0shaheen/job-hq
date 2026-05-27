# src/filtering.py
from __future__ import annotations


def title_matches(title: str, include: list[str], exclude: list[str]) -> bool:
    t = title.lower()
    if any(term.lower() in t for term in exclude):
        return False
    return any(term.lower() in t for term in include)
