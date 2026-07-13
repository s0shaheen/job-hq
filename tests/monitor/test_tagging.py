import pytest
from monitor.tagging import Tags, extract_tags, min_yoe_from


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
