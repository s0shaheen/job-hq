from __future__ import annotations
from dataclasses import dataclass

MODEL = "claude-haiku-4-5"

SYSTEM = (
    "You tag product-manager job postings for a job seeker. "
    "Extract ONLY what the posting actually states. When a field is not stated, "
    "return an empty string (or an empty list for skills) — never guess or invent. "
    "Condense each requirement/qualification to at most 5 words. "
    "Normalize seniority to exactly one of: APM, PM, Senior, Staff, GPM, Director, VP."
)

_TAG_TOOL = {
    "name": "emit_tags",
    "description": "Emit structured tags extracted from a product-manager job description.",
    "input_schema": {
        "type": "object",
        "properties": {
            "yoe": {"type": "string",
                    "description": "Years of experience requested, e.g. '5+' or '3-5'. Empty if unstated."},
            "seniority": {"type": "string",
                          "description": "One of APM, PM, Senior, Staff, GPM, Director, VP. Empty if unclear."},
            "company_industry": {"type": "string",
                                 "description": "Industry + main products, e.g. 'Fintech — payments/cards'."},
            "role_focus": {"type": "string",
                           "description": "The specific product/domain/team of THIS role."},
            "skills": {"type": "array", "items": {"type": "string"},
                       "description": "Each required/preferred qualification, condensed to <=5 words."},
            "comp_range": {"type": "string",
                           "description": "Salary range if stated, e.g. '$160k-$190k'. Empty if absent."},
            "work_model": {"type": "string",
                           "description": "Remote / Hybrid / Onsite plus geo, e.g. 'Remote (US)' or 'Hybrid — NYC'."},
        },
        "required": ["yoe", "seniority", "company_industry", "role_focus",
                     "skills", "comp_range", "work_model"],
    },
    # Best-effort prompt caching of the static tool schema (no-op if below the model's
    # min cacheable size; harmless).
    "cache_control": {"type": "ephemeral"},
}


@dataclass
class Tags:
    yoe: str = ""
    seniority: str = ""
    company_industry: str = ""
    role_focus: str = ""
    skills: str = ""          # semicolon-joined for the single Sheet cell
    comp_range: str = ""
    work_model: str = ""


def _default_client():
    import anthropic
    return anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment


def _tool_input(message) -> dict:
    """Return the input dict from the emit_tags tool_use block.

    Raises ValueError if no emit_tags block is present — callers must not
    silently swallow a missing tool response, as that would mark the row done
    with empty tags and mask the failure.
    """
    for block in message.content:
        if getattr(block, "type", None) == "tool_use" and block.name == "emit_tags":
            return block.input or {}
    raise ValueError("emit_tags tool block not found in model response")


def extract_tags(jd_text: str, title: str, company: str, *, client=None) -> Tags:
    if not jd_text or not jd_text.strip():
        return Tags()
    client = client or _default_client()
    message = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        temperature=0,
        system=SYSTEM,
        tools=[_TAG_TOOL],
        tool_choice={"type": "tool", "name": "emit_tags"},
        messages=[{"role": "user",
                   "content": f"Company: {company}\nTitle: {title}\n\nJob description:\n{jd_text}"}],
    )
    data = _tool_input(message)
    skills = data.get("skills") or []
    return Tags(
        yoe=str(data.get("yoe", "")).strip(),
        seniority=str(data.get("seniority", "")).strip(),
        company_industry=str(data.get("company_industry", "")).strip(),
        role_focus=str(data.get("role_focus", "")).strip(),
        skills="; ".join(s.strip() for s in skills if str(s).strip()),  # list → single semicolon-separated Sheet cell
        comp_range=str(data.get("comp_range", "")).strip(),
        work_model=str(data.get("work_model", "")).strip(),
    )
