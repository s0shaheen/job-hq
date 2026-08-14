"""Multi-user registry: isolation, backward compatibility, and provisioning.

The risk this file exists for: a per-user system that silently serves one
person's sheet id (or ntfy topic) to another. Every test below is really
asking "can user A's run touch user B's instance?".
"""
import textwrap

import pytest

from core import config, notify
from tracker.provision import instance_block, to_multi_user

FLAT = """\
sheet_id: SALMAN_SHEET
tabs: {feed: 111, pipeline: 222}
ntfy: {jobs: salman-jobs, ops: salman-ops}
owner_email: salman@example.com
service_account_email: sa@project.iam.gserviceaccount.com
"""

MULTI = """\
service_account_email: sa@project.iam.gserviceaccount.com
default_user: salman
users:
  salman:
    sheet_id: SALMAN_SHEET
    tabs: {feed: 111}
    ntfy: {jobs: salman-jobs, ops: salman-ops}
    owner_email: salman@example.com
  dad:
    sheet_id: DAD_SHEET
    tabs: {feed: 999}
    ntfy: {jobs: dad-jobs, ops: salman-ops}
    owner_email: dad@example.com
"""


@pytest.fixture(autouse=True)
def _clear_caches():
    config._registry_doc.cache_clear()
    config.registry.cache_clear()
    yield
    config._registry_doc.cache_clear()
    config.registry.cache_clear()


def _write(tmp_path, monkeypatch, text):
    p = tmp_path / "hq.config.yaml"
    p.write_text(textwrap.dedent(text))
    monkeypatch.setenv("HQ_REGISTRY_PATH", str(p))
    monkeypatch.delenv(config.USER_ENV, raising=False)
    config._registry_doc.cache_clear()
    config.registry.cache_clear()
    return p


# ---- backward compatibility: the live single-user file must not change

def test_flat_registry_still_works_untouched(tmp_path, monkeypatch):
    _write(tmp_path, monkeypatch, FLAT)
    assert config.users() == []              # single-user mode
    assert config.current_user() == ""
    assert config.sheet_id() == "SALMAN_SHEET"
    assert config.registry()["ntfy"]["jobs"] == "salman-jobs"


def test_flat_registry_keeps_env_sheet_override(tmp_path, monkeypatch):
    _write(tmp_path, monkeypatch, FLAT)
    monkeypatch.setenv("HQ_SHEET_ID", "OVERRIDE")
    assert config.sheet_id() == "OVERRIDE"


# ---- isolation

def test_each_user_resolves_their_own_sheet(tmp_path, monkeypatch):
    _write(tmp_path, monkeypatch, MULTI)
    assert config.sheet_id("salman") == "SALMAN_SHEET"
    assert config.sheet_id("dad") == "DAD_SHEET"
    assert config.registry("dad")["tabs"]["feed"] == 999


def test_env_selects_the_user(tmp_path, monkeypatch):
    _write(tmp_path, monkeypatch, MULTI)
    monkeypatch.setenv(config.USER_ENV, "dad")
    assert config.current_user() == "dad"
    assert config.sheet_id() == "DAD_SHEET"


def test_interleaved_lookups_never_bleed(tmp_path, monkeypatch):
    """The per-user cache must survive alternation — a single-slot cache
    would return the previously-read user's sheet."""
    _write(tmp_path, monkeypatch, MULTI)
    for _ in range(3):
        assert config.registry("salman")["sheet_id"] == "SALMAN_SHEET"
        assert config.registry("dad")["sheet_id"] == "DAD_SHEET"


def test_env_sheet_override_is_ignored_in_multi_user(tmp_path, monkeypatch):
    """One exported HQ_SHEET_ID must not point every matrix leg at one sheet."""
    _write(tmp_path, monkeypatch, MULTI)
    monkeypatch.setenv("HQ_SHEET_ID", "OVERRIDE")
    assert config.sheet_id("dad") == "DAD_SHEET"


def test_unknown_user_fails_loud(tmp_path, monkeypatch):
    _write(tmp_path, monkeypatch, MULTI)
    with pytest.raises(KeyError):
        config.registry("stranger")


def test_shared_root_keys_inherit_but_instance_wins(tmp_path, monkeypatch):
    _write(tmp_path, monkeypatch, MULTI)
    for u in ("salman", "dad"):
        assert config.registry(u)["service_account_email"].startswith("sa@")
    assert config.registry("dad")["owner_email"] == "dad@example.com"


# ---- notifications route per user

def test_ntfy_topic_is_per_user(tmp_path, monkeypatch):
    _write(tmp_path, monkeypatch, MULTI)
    assert notify._topic("jobs", "salman") == "salman-jobs"
    assert notify._topic("jobs", "dad") == "dad-jobs"
    # ops points at the operator for BOTH, so a dad failure pages Salman
    assert notify._topic("ops", "dad") == "salman-ops"


def test_ntfy_env_override_ignored_in_multi_user(tmp_path, monkeypatch):
    _write(tmp_path, monkeypatch, MULTI)
    monkeypatch.setenv("HQ_NTFY_TOPIC", "everyone")
    assert notify._topic("jobs", "dad") == "dad-jobs"


# ---- provisioning migrates without disturbing the existing instance

def test_migration_preserves_the_existing_instance_verbatim():
    flat = {"sheet_id": "SALMAN_SHEET", "tabs": {"feed": 111},
            "ntfy": {"jobs": "salman-jobs"}, "owner_email": "s@example.com",
            "service_account_email": "sa@x.iam.gserviceaccount.com"}
    doc = to_multi_user(dict(flat), "salman")
    assert doc["default_user"] == "salman"
    assert doc["users"]["salman"]["sheet_id"] == "SALMAN_SHEET"
    assert doc["users"]["salman"]["tabs"] == {"feed": 111}
    # shared infra hoisted to the root, stated once
    assert doc["service_account_email"] == "sa@x.iam.gserviceaccount.com"
    assert "service_account_email" not in doc["users"]["salman"]


def test_migration_is_idempotent():
    doc = to_multi_user({"users": {"salman": {"sheet_id": "X"}},
                         "default_user": "salman"}, "salman")
    assert doc["users"] == {"salman": {"sheet_id": "X"}}


def test_instance_block_merges_without_dropping_pinned_gids():
    existing = {"tabs": {"feed": 7}, "ntfy": {"jobs": "old-jobs"}}
    inst = instance_block(sheet_id="NEW", owner="d@example.com",
                          ntfy_jobs="", ntfy_ops="ops-topic", existing=existing)
    assert inst["tabs"] == {"feed": 7}          # gids survive a re-provision
    assert inst["ntfy"]["jobs"] == "old-jobs"   # unspecified topic untouched
    assert inst["ntfy"]["ops"] == "ops-topic"
    assert inst["sheet_id"] == "NEW"


# ---- profiles drive the search per user

def test_profiles_differ_per_user_and_drive_the_gates():
    from core.profile import Profile
    dad = Profile.load("dad")
    sal = Profile.load("salman")
    assert dad.tag_domain == "finance" and sal.tag_domain == "product-manager"
    assert dad.gate_config().metros == ["Chicago"]
    assert sal.gate_config().metros == []        # national search
    assert dad.notify_channel == "email"


def test_config_tab_overlay_beats_the_committed_profile():
    from core.profile import Profile
    prof = Profile.load("dad", cfg={"filter_metros": ["Denver"],
                                    "filter_yoe_max": 3})
    assert prof.gate_config().metros == ["Denver"]
    assert prof.gate_config().yoe_max == 3


def test_untouched_config_defaults_never_shadow_the_profile():
    """The critical one: UserConfig always carries every committed default
    (bootstrap materializes them as real rows), so treating any value as an
    override would silently run one person's search inside another's
    instance."""
    from core.config import UserConfig, defaults
    from core.profile import Profile
    prof = Profile.load("dad", cfg=UserConfig(dict(defaults()), []))
    assert prof.yoe_max == 30                 # profile, not the committed default
    assert prof.yoe_unknown == "keep"
    assert prof.board_search_term == "financial"
    assert prof.gate_config().metros == ["Chicago"]
    assert "fp&a" in prof.titles_include
    assert "product manager" not in prof.titles_include


def test_a_deliberately_changed_config_cell_still_wins():
    from core.config import UserConfig, defaults
    from core.profile import Profile
    vals = dict(defaults())
    vals["filter_yoe_max"] = 7                # dad edited this cell himself
    prof = Profile.load("dad", cfg=UserConfig(vals, []))
    assert prof.yoe_max == 7
    assert prof.board_search_term == "financial"   # untouched keys stay profile
