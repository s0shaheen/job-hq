"""docs/SYSTEM.md is a lockfile: the committed generated sections must match the repo.

`scripts/sysmap.py` reads the real sources of truth (Terraform's var.jobs, handler.JOBS, the
workflow files, tracker/monitor snapshot constants, digest's watchdog table, alerts.tf, schema.TABS,
hq.config.yaml). If any of those change and nobody re-runs the generator, the owner-facing map
starts lying — so a stale doc is a red suite, exactly like an out-of-date lockfile.

Loaded by path because scripts/ is not a package (same trick tests/infra/test_lambda_handler.py
uses for infra/app/handler.py).
"""
import importlib.util
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
_PATH = REPO / "scripts" / "sysmap.py"
_spec = importlib.util.spec_from_file_location("hq_sysmap", _PATH)
sysmap = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sysmap)


def test_committed_doc_is_current():
    """The lockfile check. Fix: `python scripts/sysmap.py`, then commit docs/SYSTEM.md."""
    doc = sysmap.DOC.read_text()
    stale = sysmap.stale_sections(doc, sysmap.build_sections())
    assert not stale, ("docs/SYSTEM.md generated sections are stale: "
                       f"{', '.join(stale)} — run `python scripts/sysmap.py`")


def test_generator_is_deterministic():
    """No timestamps, no set iteration order, no environment: two runs, identical bytes.
    A non-deterministic generator would make the check above flap in CI."""
    first, second = sysmap.build_sections(), sysmap.build_sections()
    assert first == second
    doc = sysmap.DOC.read_text()
    assert sysmap.render(doc, first) == sysmap.render(doc, second) == doc


def test_check_mode_passes_on_the_committed_doc():
    assert sysmap.main(["--check"]) == 0


def test_every_terraform_job_reaches_the_schedule_table():
    """Mutation canary. A parser that silently matched nothing (a moved `variable "jobs"` block,
    a reformatted map) would render an empty-but-well-formed table, the check above would pass on
    a hollow doc, and the owner's map would quietly stop listing what actually runs."""
    jobs = sysmap.terraform_jobs()
    assert len(jobs) >= 7, "var.jobs parse collapsed — 7 schedules were deployed at last count"
    section = sysmap.build_sections()["lambda-schedules"]
    for job, cron, _note in jobs:
        assert f"| `{job}` |" in section, f"{job} is scheduled but missing from the table"
        assert cron in section, f"{job}'s cron is not in the table"
    # every scheduled job must also show the module chain the handler will actually run
    handler_jobs = sysmap.handler_jobs()
    for job, _cron, _note in jobs:
        for module, _argv in handler_jobs[job]:
            assert module in section, f"{job} runs {module} but the table doesn't say so"


def test_other_parsers_cannot_render_hollow_sections():
    """Same canary shape for the remaining sources: each section must name every fact it exists
    to carry, so an empty parse fails here instead of shipping a plausible-looking blank."""
    secs = sysmap.build_sections()

    for key, title in sysmap.schema_tabs():
        assert f"| `{key}` | {title} |" in secs["sheet-tabs"]
    never = sysmap.snapshot_facts()["never"]
    assert never and all(f"`{tab}`" in secs["sheet-tabs"] for tab in never)

    for alarm in sysmap.alarms():
        assert f"`{alarm['name']}`" in secs["alerting"]
        assert alarm["metric"] in secs["alerting"]
        assert alarm["period"] in secs["alerting"]
        assert alarm["missing"] in secs["alerting"]

    facts = sysmap.digest_facts()
    for beat, _hours in facts["cadence"]:
        assert f"`heartbeat_{beat}`" in secs["watchdogs"]
    # The store's beats are NOT `heartbeat_*` Config rows — they are `channel_runs` lanes,
    # and one of them (`pgdump`) has no sheet beat at all. Rendering them as heartbeat rows
    # would be a doc that reads plausibly and describes a mechanism that does not exist.
    pg_lanes = [n for n, _h in facts["pg_cadence"]]
    assert pg_lanes, "PG_CADENCE_HOURS parsed to nothing"
    for lane in pg_lanes:
        assert f"| `{lane}` |" in secs["watchdogs"], f"pg lane {lane} is watched by nobody"
    for beat in facts["backup_beats"]:
        owned = (f"`heartbeat_{beat}`" in secs["backup-lanes"]     # a sheet-beat lane
                 or f"`{beat}`" in secs["backup-lanes"])           # a pg-only lane
        assert owned, f"no backup lane in the table owns the beat {beat!r}"

    for _name, filename, _trigger in sysmap.workflows():
        assert filename in secs["actions-workflows"]
    # Four since the migration scaffolding came out: ci, resume, selfheal, run-bot. A parse that
    # collapsed to nothing must still fail here, so this stays a floor, not a decoration.
    assert len(sysmap.workflows()) >= 4


def test_mermaid_blocks_are_fenced_and_use_supported_diagram_types():
    """GitHub renders ```mermaid fences only, and only stable diagram types."""
    doc = sysmap.DOC.read_text()
    blocks = re.findall(r"```mermaid\n(.*?)```", doc, re.S)
    assert len(blocks) >= 2, "the generated big-picture and alerting diagrams are missing"
    for block in blocks:
        assert block.splitlines()[0].strip() in ("flowchart TD", "flowchart LR")
        assert block.count('"') % 2 == 0, "unbalanced quotes in a mermaid label"


def test_cron_to_ct_conversion():
    assert sysmap.cron_to_ct("cron(0 12,23 * * ? *)") == "07:00 + 18:00"   # CDT, UTC-5
    assert sysmap.cron_to_ct("cron(31 0/2 * * ? *)") == "every 2 h at :31"  # offset-invariant
    assert sysmap.cron_to_ct("23 8 * * *") == "03:23"                      # 5-field Actions cron
    assert sysmap.cron_to_ct("cron(0 3 * * ? *)") == "22:00"               # wraps to the day before
    assert sysmap.cron_to_ct("cron(? ? ? ? ? ?)") == "—"                   # never guesses


def test_render_refuses_a_doc_missing_a_marker():
    """Fail loud, not silent: a dropped marker pair must stop the generator, not skip a section."""
    import pytest
    with pytest.raises(SystemExit):
        sysmap.render("# no markers here\n", sysmap.build_sections())
