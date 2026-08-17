import pytest

from core.profile import Profile
from monitor import tagging
from monitor.tagging import (SENIORITY_LADDERS, Tags, extract_tags, min_yoe_from,
                             system_prompt, tag_tool, unset_domain_warning)


# ---- min_yoe derivation

@pytest.mark.parametrize("yoe,expected", [
    ("3+", 3),
    ("2-4", 2),
    ("0-2", 0),
    ("5", 5),
    ("10+ years", 10),
    ("", ""),
    ("banana", ""),
    ("2026", ""),          # implausible number = junk, not 2026 years
])
def test_min_yoe_from(yoe, expected):
    assert min_yoe_from(yoe) == expected


def test_tags_min_yoe_is_computed_from_yoe():
    assert Tags(yoe="3+").min_yoe == 3
    assert Tags(yoe="2-4").min_yoe == 2
    assert Tags().min_yoe == ""
    assert min_yoe_from("3") == 3   # round-trips the sheet's min_yoe cell too


class _FakeBlock:
    def __init__(self, tool_input):
        self.type = "tool_use"
        self.name = "emit_tags"
        self.input = tool_input


class _FakeMessage:
    def __init__(self, tool_input):
        self.content = [_FakeBlock(tool_input)]


class _FakeClient:
    """Captures the create() kwargs and returns a canned tool_use block."""
    def __init__(self, tool_input):
        self._input = tool_input
        self.calls = []
        self.messages = self  # so client.messages.create works

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return _FakeMessage(self._input)


def test_extract_tags_maps_tool_input_to_tags():
    client = _FakeClient({
        "yoe": "5+", "seniority": "Senior",
        "company_industry": "Fintech — payments",
        "role_focus": "Checkout platform",
        "skills": ["SQL", "A/B testing", "B2B SaaS"],
        "comp_range": "$160k-$190k", "work_model": "Remote (US)",
    })
    tags = extract_tags("Lead the checkout team...", "Senior PM", "Acme", client=client)
    assert tags == Tags(
        yoe="5+", seniority="Senior", company_industry="Fintech — payments",
        role_focus="Checkout platform", skills="SQL; A/B testing; B2B SaaS",
        comp_range="$160k-$190k", work_model="Remote (US)",
    )
    # forced tool-use was requested
    kw = client.calls[0]
    assert kw["tool_choice"] == {"type": "tool", "name": "emit_tags"}
    assert kw["model"] == "claude-haiku-4-5"


def test_extract_tags_empty_jd_returns_blank_without_calling_llm():
    client = _FakeClient({"yoe": "SHOULD NOT BE USED"})
    tags = extract_tags("   ", "PM", "Acme", client=client)
    assert tags == Tags()
    assert client.calls == []  # never hit the model on empty JD


def test_extract_tags_blank_skills_list_yields_empty_cell():
    client = _FakeClient({
        "yoe": "", "seniority": "PM", "company_industry": "", "role_focus": "",
        "skills": [], "comp_range": "", "work_model": "",
    })
    tags = extract_tags("real jd text", "PM", "Acme", client=client)
    assert tags.skills == ""
    assert tags.seniority == "PM"


def test_extract_tags_raises_when_no_tool_block():
    """_tool_input must raise, not return {}, so the failure is not silently masked."""
    class _EmptyMessage:
        content = []

    class _EmptyClient:
        calls = []
        messages = None

        def __init__(self):
            self.messages = self

        def create(self, **kwargs):
            self.calls.append(kwargs)
            return _EmptyMessage()

    client = _EmptyClient()
    with pytest.raises(ValueError, match="emit_tags tool block not found"):
        extract_tags("real jd", "PM", "Acme", client=client)


# ---- the domain lens (#253): unset is a state, not the owner's field

# The exact prompt the LIVE flat single-user lane gets. That registry has no
# tag_domain key at all, so `Profile.tag_domain` supplies "product-manager"
# (core/profile.py, deliberately kept by #251) — this pins that
# de-personalizing the UNSET path left the SET path byte-for-byte alone.
LIVE_FLAT_LANE_PROMPT = (
    "You tag product manager job postings for a job seeker. "
    "Extract ONLY what the posting actually states. When a field is not stated, "
    "return an empty string (or an empty list for skills) — never guess or invent. "
    "Condense each requirement/qualification to at most 5 words. "
    "Normalize seniority to exactly one of: APM, PM, Senior, Staff, GPM, Director, VP."
)


def test_a_stated_domain_is_unchanged():
    """The owner's live lane, and every named user's, behaves exactly as before."""
    assert system_prompt("product-manager") == LIVE_FLAT_LANE_PROMPT
    assert Profile().tag_domain == "product-manager"        # what run.py passes it
    assert system_prompt(Profile().tag_domain) == LIVE_FLAT_LANE_PROMPT

    tool = tag_tool("product-manager")
    assert tool["description"] == ("Emit structured tags extracted from a "
                                   "product manager job description.")
    assert tool["input_schema"]["properties"]["seniority"]["description"] == (
        "One of APM, PM, Senior, Staff, GPM, Director, VP. Empty if unclear.")

    assert system_prompt("finance").startswith("You tag finance job postings")
    assert "Analyst, Senior Analyst, Manager" in system_prompt("finance")


@pytest.mark.parametrize("unset", ["", "   ", None])
def test_unset_domain_claims_no_field(unset):
    """No field lens at all — not a different person's field."""
    prompt = system_prompt(unset)
    assert prompt.startswith("You tag job postings for a job seeker. ")
    assert "The seeker's profession is not stated" in prompt
    assert "product" not in prompt.casefold()      # the old DEFAULT_DOMAIN
    assert "finance" not in prompt.casefold()
    # still a useful tagger: the whole extraction contract survives
    assert "Extract ONLY what the posting actually states." in prompt
    assert "Normalize seniority to exactly one of: Entry, Mid, Senior" in prompt

    tool = tag_tool(unset)
    assert tool["description"] == "Emit structured tags extracted from a job description."
    assert tool["input_schema"]["properties"]["seniority"]["description"] == (
        "One of Entry, Mid, Senior, Lead, Manager, Director, VP. Empty if unclear.")


def test_unset_domain_is_the_default_everywhere_the_domain_is_optional():
    """The regression itself: every default argument used to be the owner's
    domain, so a caller that simply did not know the field got it anyway."""
    assert system_prompt() == system_prompt("")
    assert tag_tool() == tag_tool("")
    assert not hasattr(tagging, "DEFAULT_DOMAIN")     # nothing to fall back to


def test_extract_tags_default_domain_sends_no_field_lens():
    client = _FakeClient({"yoe": "", "seniority": "", "company_industry": "",
                          "role_focus": "", "skills": [], "comp_range": "",
                          "work_model": ""})
    extract_tags("A real job description", "Staff Nurse", "Acme", client=client)
    sent = client.calls[0]
    assert sent["system"] == system_prompt("")
    assert "product" not in sent["system"].casefold()
    assert sent["tools"][0]["description"] == (
        "Emit structured tags extracted from a job description.")


def test_extract_tags_sends_a_stated_domain_through():
    client = _FakeClient({"yoe": "", "seniority": "", "company_industry": "",
                          "role_focus": "", "skills": [], "comp_range": "",
                          "work_model": ""})
    extract_tags("A real job description", "FP&A Manager", "Acme",
                 client=client, domain="finance")
    assert client.calls[0]["system"] == system_prompt("finance")


@pytest.mark.parametrize("unset", ["", "   ", None])
def test_a_domainless_tag_run_is_not_silent(unset):
    """Weaker-than-configured must be legible; #252/#255: a lane running on a
    misconfiguration does not get to look identical to a healthy one."""
    warning = unset_domain_warning(unset)
    assert warning.startswith("::warning title=Tagger domain unset::")
    assert "tag_domain" in warning
    assert unset_domain_warning("product-manager") == ""
    assert unset_domain_warning("anything-else") == ""


def test_ladder_taxonomy_is_untouched():
    """#253 fixes the UNSET path only. Growing or renaming the families is the
    blocked owner taxonomy decision (vault-audit Step 4.3) — not this change."""
    assert set(SENIORITY_LADDERS) == {"product-manager", "finance",
                                      "software-engineering", "generic"}
    assert SENIORITY_LADDERS["generic"] == "Entry, Mid, Senior, Lead, Manager, Director, VP"
