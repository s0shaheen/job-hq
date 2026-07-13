from __future__ import annotations


def title_matches(title: str, include: list[str], exclude: list[str]) -> bool:
    """Substring filter over the Config tab's titles_include/titles_exclude;
    exclude always wins (a 'Product Marketing Manager' never sneaks through)."""
    t = title.lower()
    if any(term.lower() in t for term in exclude):
        return False
    return any(term.lower() in t for term in include)
