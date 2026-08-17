from __future__ import annotations
import re
from dataclasses import dataclass

MODEL = "claude-haiku-4-5"

# Seniority ladders differ by field: a PM ladder (APM..VP) is meaningless for
# an FP&A or SWE search, and forcing one produces junk that the YoE-unknown
# gate then acts on. Each profile names its own.
#
# This map is NOT the general job-family taxonomy and must not be grown into
# one here: that decision is the owner's (docs/pilot-launch/
# 07-decisions-assumptions-risks.md §5, vault-audit Step 4.3) and is blocked,
# not deferred. `generic` is the normalization alphabet for every search whose
# field is not one of the three named above — including a search that named no
# field at all. It is a vocabulary, not a lens: it asserts nothing about who
# the seeker is or what they do.
SENIORITY_LADDERS = {
    "product-manager": "APM, PM, Senior, Staff, GPM, Director, VP",
    "finance": "Analyst, Senior Analyst, Manager, Senior Manager, Director, VP, CFO",
    "software-engineering": "Intern, Junior, Mid, Senior, Staff, Principal, Manager, Director",
    "generic": "Entry, Mid, Senior, Lead, Manager, Director, VP",
}

# There is deliberately no DEFAULT_DOMAIN. There used to be one
# (`"product-manager"`, with `domain or DEFAULT_DOMAIN` below), so a profile
# that never named a field had every posting read through the deployment
# owner's lens: the model was told in so many words that it was reading
# "product manager job postings" and made to normalize seniority to APM..VP.
# An unset domain is a STATE, not an invitation to pick one (RM-40 vault audit
# §3b, #253) — it stays unset all the way to the prompt, which then claims no
# field and tags the posting on its own text. Callers that HAVE a domain still
# pass it and get exactly the prompt they got before.


def domain_or_unset(domain) -> str:
    """The stated domain, or `""`. None and whitespace are unset, not values."""
    return str(domain or "").strip()


def _domain_label(domain: str) -> str:
    """Human phrasing of a STATED domain; `""` when nothing is stated."""
    return domain_or_unset(domain).replace("-", " ")


def _ladder(domain: str) -> str:
    """The seniority alphabet for this domain — `generic` when the field is
    unstated or has no ladder of its own (see SENIORITY_LADDERS)."""
    return SENIORITY_LADDERS.get(domain_or_unset(domain), SENIORITY_LADDERS["generic"])


UNSET_DOMAIN_WARNING = (
    "::warning title=Tagger domain unset::No tag_domain for this profile — "
    "postings are tagged with NO field lens and the generic seniority ladder "
    "(Entry..VP), which is weaker than a domain-shaped tagger and is the "
    "reason to set one. Set `tag_domain` in users/<name>/profile.yaml."
)


def unset_domain_warning(domain) -> str:
    """The line a tagging worker prints when it runs without a stated domain.

    Empty string when a domain IS stated, so callers can `if warning: print`.

    Degraded is not healthy (#252/#255). A domain-less tag run is not idle —
    it still extracts every fact that has nothing to do with the seeker's
    field (comp, YoE, work model, skills, industry), which is exactly why it
    runs at all instead of skipping and leaving the whole feed permanently
    `needs-info`. But it IS running weaker than a configured one, and until
    #253 it did so silently AND wrongly, tagging through one person's domain.
    """
    return "" if domain_or_unset(domain) else UNSET_DOMAIN_WARNING


def system_prompt(domain: str = "") -> str:
    """The tagger is domain-parameterized: the same extraction, told what kind
    of posting it is reading. Hardcoding 'product-manager' here is exactly what
    blocked a second user. An unset domain tells the model nothing about the
    field rather than telling it somebody else's."""
    label = _domain_label(domain)
    return (
        f"You tag {label + ' ' if label else ''}job postings for a job seeker. "
        # "field" below already means a tag field, so this says profession.
        + ("" if label else
           "The seeker's profession is not stated: read each posting on its "
           "own terms and never assume one. ")
        + "Extract ONLY what the posting actually states. When a field is not stated, "
        "return an empty string (or an empty list for skills) — never guess or invent. "
        "Condense each requirement/qualification to at most 5 words. "
        f"Normalize seniority to exactly one of: {_ladder(domain)}."
    )


def tag_tool(domain: str = "") -> dict:
    label = _domain_label(domain)
    tool = {k: (dict(v) if isinstance(v, dict) else v) for k, v in _TAG_TOOL.items()}
    if label:
        tool["description"] = (f"Emit structured tags extracted from a "
                               f"{label} job description.")
    props = {k: dict(v) for k, v in _TAG_TOOL["input_schema"]["properties"].items()}
    props["seniority"] = dict(props["seniority"],
                              description=f"One of {_ladder(domain)}. Empty if unclear.")
    tool["input_schema"] = dict(_TAG_TOOL["input_schema"], properties=props)
    return tool


SYSTEM = None  # set at call time from the profile's domain (see system_prompt)

_TAG_TOOL = {
    "name": "emit_tags",
    "description": "Emit structured tags extracted from a job description.",
    "input_schema": {
        "type": "object",
        "properties": {
            "yoe": {"type": "string",
                    "description": "Years of experience requested, e.g. '5+' or '3-5'. Empty if unstated."},
            "seniority": {"type": "string",
                          "description": "The posting's seniority level. Empty if unclear."},
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


def min_yoe_from(yoe: str) -> int | str:
    """Lower bound of a tagged YoE string: "3+" -> 3, "2-4" -> 2, "5" -> 5.

    Returns "" for junk (no digits, or an implausible number like a year) so
    the push filter treats unknown experience as not-pushable rather than 0.
    Also parses the min_yoe strings read back from the Feed tab ("3" -> 3).
    """
    m = re.search(r"\d+", str(yoe or ""))
    if not m:
        return ""
    v = int(m.group())
    return v if 0 <= v <= 30 else ""


@dataclass
class Tags:
    yoe: str = ""
    seniority: str = ""
    company_industry: str = ""
    role_focus: str = ""
    skills: str = ""          # semicolon-joined for the single Sheet cell
    comp_range: str = ""
    work_model: str = ""

    @property
    def min_yoe(self) -> int | str:
        """Computed (never stored on the dataclass) so it can't drift from yoe;
        the sheet's min_yoe column is written from this at write time."""
        return min_yoe_from(self.yoe)


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


def extract_tags(jd_text: str, title: str, company: str, *, client=None,
                 domain: str = "") -> Tags:
    if not jd_text or not jd_text.strip():
        return Tags()
    client = client or _default_client()
    message = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        temperature=0,
        system=system_prompt(domain),
        tools=[tag_tool(domain)],
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
