"""Phase C's cutover switch. Every assertion here is about a REFUSAL.

MUTATION TARGETS (each run red before green):
  * make the unknown-value branch fall through to MIRROR -> the typo test passes
    a value nobody meant and the engine runs Phase A under Phase C's name;
  * drop the creds check in first_class() -> the pg-first-with-no-pg test writes
    nothing and reports success;
  * make first_class() import core.pg at module scope -> the lazy-import test
    stops proving that a sheet-only run never touches the store;
  * let `pg_user_id` fall back to the env var in multi-user mode -> the
    cross-tenant test hands dad's lane salman's uuid, which is a silent write
    into another person's pipeline that looks exactly like success;
  * drop the `uid()` call at the gate -> a non-UUID id reaches PostgREST as an
    opaque 4xx at 07:00 instead of a named refusal.
"""
import textwrap

import pytest

from core import config, pgwrites

UUID_A = "11111111-1111-1111-1111-111111111111"
UUID_B = "22222222-2222-2222-2222-222222222222"


@pytest.fixture(autouse=True)
def _clean_registry_caches():
    """`registry`/`_registry_doc` are lru_cached; a leaked cache would serve one
    test's users: map to the next (the same hazard handler._select_user clears)."""
    config._registry_doc.cache_clear()
    config.registry.cache_clear()
    yield
    config._registry_doc.cache_clear()
    config.registry.cache_clear()


def _multiuser(monkeypatch, tmp_path, *, dad_has_id: bool):
    doc = textwrap.dedent(f"""
        default_user: salman
        users:
          salman:
            sheet_id: S1
            pg_user_id: {UUID_A}
          dad:
            sheet_id: S2
        """)
    if dad_has_id:
        doc += f"    pg_user_id: {UUID_B}\n"
    p = tmp_path / "hq.config.yaml"
    p.write_text(doc)
    monkeypatch.setenv("HQ_REGISTRY_PATH", str(p))
    config._registry_doc.cache_clear()
    config.registry.cache_clear()


def test_unset_is_the_echo_and_never_looks_at_pg(monkeypatch):
    monkeypatch.delenv(pgwrites.FLAG_ENV, raising=False)
    monkeypatch.setattr("core.pg.enabled",
                        lambda: pytest.fail("pg consulted while HQ_PG_WRITES is unset"))
    assert pgwrites.mode() == pgwrites.MIRROR
    assert pgwrites.first_class() is False


def test_the_explicit_mirror_value_is_accepted(monkeypatch):
    """Ops rolling BACK from first_class writes the word rather than deleting the
    parameter — an SSM delete is a harder gesture to make in a hurry."""
    monkeypatch.setenv(pgwrites.FLAG_ENV, "  MIRROR ")
    assert pgwrites.mode() == pgwrites.MIRROR


def test_a_typo_refuses_instead_of_silently_running_phase_a(monkeypatch):
    for typo in ("firstclass", "first-class", "true", "1", "pg"):
        monkeypatch.setenv(pgwrites.FLAG_ENV, typo)
        with pytest.raises(RuntimeError, match="refusing to guess"):
            pgwrites.mode()


def test_first_class_without_credentials_refuses_loudly(monkeypatch):
    monkeypatch.setenv(pgwrites.FLAG_ENV, pgwrites.FIRST_CLASS)
    monkeypatch.setenv(pgwrites.USER_ENV, "u-1")
    monkeypatch.setattr("core.pg.enabled", lambda: False)
    with pytest.raises(RuntimeError, match="refusing to run pg-first"):
        pgwrites.first_class()


def test_first_class_without_a_user_refuses_loudly(monkeypatch):
    """Creds alone are not enough: every engine write is scoped to one user's
    lanes, and an unset id would upsert postings nobody can see."""
    monkeypatch.setenv(pgwrites.FLAG_ENV, pgwrites.FIRST_CLASS)
    monkeypatch.delenv(pgwrites.USER_ENV, raising=False)
    monkeypatch.setattr("core.pg.enabled", lambda: True)
    with pytest.raises(RuntimeError, match="refusing to run pg-first"):
        pgwrites.first_class()


def test_first_class_with_everything_set_is_on(monkeypatch):
    monkeypatch.setenv(pgwrites.FLAG_ENV, pgwrites.FIRST_CLASS)
    monkeypatch.setenv(pgwrites.USER_ENV, f" {UUID_A} ")
    monkeypatch.setattr("core.pg.enabled", lambda: True)
    assert pgwrites.first_class() is True
    assert pgwrites.user_id() == UUID_A


def test_a_non_uuid_id_is_refused_at_the_gate(monkeypatch):
    """One flag gate, one behaviour. This used to pass the gate and fail later as
    an opaque PostgREST 4xx from whichever job happened to POST first."""
    monkeypatch.setenv(pgwrites.FLAG_ENV, pgwrites.FIRST_CLASS)
    monkeypatch.setenv(pgwrites.USER_ENV, "salman")
    monkeypatch.setattr("core.pg.enabled", lambda: True)
    with pytest.raises(ValueError, match="must be a UUID"):
        pgwrites.first_class()


# ---- one lane, one tenant

def _handler():
    """The Lambda shim, loaded by path — `infra/` is not an importable package."""
    import importlib.util
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location(
        "hq_handler_under_test", root / "infra" / "app" / "handler.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_each_user_lane_resolves_its_own_pg_id(monkeypatch, tmp_path):
    """`HQ_PG_USER_ID` is one flat SSM value and the Lambda cannot remap it, so
    once a users: map exists the registry is authoritative — `sheet_id`'s rule.

    Lanes are switched through `handler._select_user`, not by poking HQ_USER: that
    function's cache_clear is half of the guarantee (registry() is lru_cached per
    argument, so a warm container that skipped it would serve the first lane's
    block to the second), and testing the two halves apart proves neither.
    """
    _multiuser(monkeypatch, tmp_path, dad_has_id=True)
    handler = _handler()
    monkeypatch.setenv(pgwrites.USER_ENV, UUID_A)     # the flat env, inherited

    handler._select_user("dad")
    assert pgwrites.user_id() == UUID_B, "dad's lane inherited another tenant's uuid"
    handler._select_user("salman")
    assert pgwrites.user_id() == UUID_A
    handler._select_user("dad")                        # and back, on the same process
    assert pgwrites.user_id() == UUID_B


def test_the_registry_beats_the_env_without_the_handler_popping_it(monkeypatch, tmp_path):
    """The config layer's OWN defence, with the shim's help deliberately withheld.

    Written this way because the combined test passed a mutation it should have
    killed: `_select_user` pops the env var, so a `pg_user_id` that fell back to
    the environment in multi-user mode had nothing to fall back TO and the bug was
    invisible. Two defences tested only together are one defence. Every non-Lambda
    caller — run-bot.yml, selfheal.yml's matrix, a local `HQ_USER=dad python -m …`
    — reaches this path with the env var still set.
    """
    _multiuser(monkeypatch, tmp_path, dad_has_id=True)
    monkeypatch.setenv(pgwrites.USER_ENV, UUID_A)     # salman's, never popped
    monkeypatch.setenv("HQ_USER", "dad")
    assert config.pg_user_id() == UUID_B
    assert config.pg_user_id("dad") == UUID_B
    assert pgwrites.user_id() == UUID_B


def test_the_flat_registry_still_reads_the_env(monkeypatch, tmp_path):
    """The control. Single-user is every deployment today, and the env var is how
    SSM delivers the id there — a registry-only rule would break the live lane."""
    p = tmp_path / "hq.config.yaml"
    p.write_text("sheet_id: S1\n")
    monkeypatch.setenv("HQ_REGISTRY_PATH", str(p))
    config._registry_doc.cache_clear()
    config.registry.cache_clear()
    monkeypatch.setenv(pgwrites.USER_ENV, UUID_A)
    assert config.pg_user_id() == UUID_A


def test_a_lane_with_no_pg_id_refuses_rather_than_inheriting(monkeypatch, tmp_path):
    """The fallback that 'works' is the one that writes dad's feed into salman's
    store. There is no correct guess here, so there is no guess."""
    _multiuser(monkeypatch, tmp_path, dad_has_id=False)
    handler = _handler()
    monkeypatch.setenv(pgwrites.FLAG_ENV, pgwrites.FIRST_CLASS)
    monkeypatch.setenv(pgwrites.USER_ENV, UUID_A)     # salman's, sitting in the env
    monkeypatch.setattr("core.pg.enabled", lambda: True)
    handler._select_user("dad")
    with pytest.raises(RuntimeError, match="no pg_user_id"):
        pgwrites.first_class()


def test_the_lambda_shim_drops_the_flat_id_for_a_named_user(monkeypatch):
    """Belt and braces at the other end: a warm container is a process that
    already ran with somebody else's environment in it."""
    import os
    handler = _handler()

    monkeypatch.setenv(pgwrites.USER_ENV, UUID_A)
    handler._select_user("dad")
    assert "HQ_PG_USER_ID" not in os.environ
    assert os.environ["HQ_USER"] == "dad"

    # the flat single-user lane keeps it: there is no registry block to read
    monkeypatch.setenv(pgwrites.USER_ENV, UUID_A)
    handler._select_user("")
    assert os.environ["HQ_PG_USER_ID"] == UUID_A
