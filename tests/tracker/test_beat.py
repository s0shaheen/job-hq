"""`python -m tracker.beat <lane>` — the beat for a job that is not a Python bot.

MUTATION TARGETS:
  * drop the first_class guard -> the Phase-A test writes to a store nobody enabled,
    and pgdump.yml's new step starts failing on every gated-off run;
  * catch the ValueError from an unknown lane -> the typo test stamps nothing and
    exits 0, leaving the real lane looking dead forever while the workflow is green;
  * return 0 on a missing argument -> the usage test's exit code stops meaning
    "the workflow step is malformed".
"""
import pytest

from core import pgwrites
from tracker import beat

UID = "11111111-1111-1111-1111-111111111111"


def test_phase_a_stamps_nothing_and_succeeds(monkeypatch, capsys):
    """pgdump.yml gains this step before the flag is ever set; it must be a no-op."""
    monkeypatch.delenv(pgwrites.FLAG_ENV, raising=False)
    monkeypatch.setattr("core.pg.insert",
                        lambda *a, **k: pytest.fail("a beat with the flag unset"))
    assert beat.main(["pgdump"]) == 0
    assert "no pg beat to stamp" in capsys.readouterr().err


def test_first_class_stamps_the_named_lane(monkeypatch):
    monkeypatch.setenv(pgwrites.FLAG_ENV, pgwrites.FIRST_CLASS)
    monkeypatch.setenv(pgwrites.USER_ENV, UID)
    monkeypatch.setattr("core.pg.enabled", lambda: True)
    sent = []
    monkeypatch.setattr("core.pg.insert",
                        lambda table, rows, session=None: sent.append((table, rows[0])))
    assert beat.main(["pgdump"]) == 0
    assert sent == [("channel_runs", {"user_id": UID, "channel": "pgdump",
                                      "detail": {"source": "engine"}})]


def test_a_typo_in_the_workflow_step_fails_the_run(monkeypatch):
    """Stamping an unwatched name is worse than not stamping: the workflow goes
    green, the beat lands somewhere nobody reads, and the real lane reads dead."""
    monkeypatch.setenv(pgwrites.FLAG_ENV, pgwrites.FIRST_CLASS)
    monkeypatch.setenv(pgwrites.USER_ENV, UID)
    monkeypatch.setattr("core.pg.enabled", lambda: True)
    monkeypatch.setattr("core.pg.insert",
                        lambda *a, **k: pytest.fail("an unwatched beat was stamped"))
    with pytest.raises(ValueError, match="core.beats.LANES"):
        beat.main(["pg_dump"])          # the plausible typo


def test_a_malformed_invocation_is_refused(capsys):
    assert beat.main([]) == 2
    assert beat.main(["a", "b"]) == 2
    assert "usage:" in capsys.readouterr().err
