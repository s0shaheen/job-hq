#!/usr/bin/env python3
"""Generate the machine-checked half of `docs/SYSTEM.md` from the repo's own sources of truth.

    python scripts/sysmap.py            # rewrite the generated sections in place
    python scripts/sysmap.py --check    # exit 1 if the committed doc is stale (CI / pytest)

Design constraints, all load-bearing:

* **stdlib only, no network, no AWS.** It must produce byte-identical output on a laptop, in
  GitHub Actions, and inside a bare `python3` with no requirements installed — so it parses
  Terraform/YAML/Python text instead of importing anything that needs gspread or boto3. The one
  import-by-path exception is `infra/app/handler.py`, whose module-level imports are stdlib
  (same trick `tests/infra/test_lambda_handler.py` uses).
* **Deterministic.** No timestamps, no environment, no dict-order surprises: everything is
  either sorted or taken in source order.
* **Fail loud.** A parse that finds nothing raises instead of quietly emitting a hollow table —
  a doc that looks generated but says nothing is worse than a red test.
* **It only ever writes between the markers.** Everything outside
  `<!-- sysmap:begin NAME -->` / `<!-- sysmap:end NAME -->` is human-maintained prose.

Sources parsed (add a section only by adding a parser + a marker pair in the doc):
  infra/terraform/variables.tf   var.jobs (job, cron, trailing comment), var.project
  infra/app/handler.py           JOBS (the module chain each job runs)
  infra/terraform/alerts.tf      alarm names / metrics / periods / treat_missing_data
  .github/workflows/*.yml        name + the `on:` block
  tracker/snapshot.py            NEVER_SNAPSHOT, HEARTBEAT_GIT/S3, S3_BUCKET_ENV
  monitor/snapshot.py            the feed-JSON S3 key
  tracker/digest.py              CADENCE_HOURS, BACKUP_BEATS, CAPTURE_ALERT_HOURS
  core/schema.py                 TABS
  hq.config.yaml                 ntfy topics, registry shape (flat vs users:)
"""
from __future__ import annotations

import argparse
import difflib
import importlib.util
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DOC = REPO / "docs" / "SYSTEM.md"

#: America/Chicago daylight offset. Schedules are pinned to UTC on purpose, so this conversion is
#: a reading aid, not a fact about the system — the caveat is printed once in the schedule section.
CT_OFFSET_H = 5

_BEGIN = "<!-- sysmap:begin {} -->"
_END = "<!-- sysmap:end {} -->"


# ------------------------------------------------------------------ tiny parsers

def _read(rel: str) -> str:
    return (REPO / rel).read_text()


def _need(value, what: str):
    """Fail loud: an empty parse means a source file moved, not that the fact went away."""
    if not value:
        raise SystemExit(f"[sysmap] parsed nothing for {what} — did the source move? Fix the parser.")
    return value


def _mini_yaml(text: str) -> dict:
    """Enough YAML for `hq.config.yaml`: 2-space indented maps of scalars, `#` comments.

    Deliberately not the `yaml` module: PyYAML ships as a gspread dependency, but this script
    must also run under a bare interpreter in CI before anything is installed. Lists and
    multi-line scalars are not supported — the registry has none, and bootstrap owns its shape.
    """
    root: dict = {}
    stack: list[tuple[int, dict]] = [(-1, root)]
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip() or ":" not in line:
            continue
        indent = len(line) - len(line.lstrip())
        key, _, val = line.strip().partition(":")
        while stack and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        val = val.strip()
        if val:
            parent[key.strip()] = val
        else:
            child: dict = {}
            parent[key.strip()] = child
            stack.append((indent, child))
    return root


def _on_block(text: str) -> list[str]:
    """The lines under a workflow's top-level `on:` key (a top-level key ends the block)."""
    out, inside = [], False
    for line in text.splitlines():
        if re.match(r"^on:\s*$", line):
            inside = True
            continue
        if inside:
            if line.strip() and not line.startswith((" ", "\t")):
                break
            out.append(line)
    return out


def _keys_at_top_indent(lines: list[str]) -> list[tuple[str, str, list[str]]]:
    """[(key, inline value, nested lines)] for the shallowest indent in `lines`."""
    body = [ln for ln in lines if ln.strip() and not ln.strip().startswith("#")]
    if not body:
        return []
    base = min(len(ln) - len(ln.lstrip()) for ln in body)
    out: list[tuple[str, str, list[str]]] = []
    for line in body:
        indent = len(line) - len(line.lstrip())
        key, _, val = line.strip().partition(":")
        if indent == base:
            out.append((key.strip(), val.strip(), []))
        elif out:
            out[-1][2].append(line)
    return out


def _list_values(lines: list[str], key: str) -> list[str]:
    """Values of `key:` inside `lines`, in either YAML shape: inline `[a, b]` or a `- a` block."""
    for i, line in enumerate(lines):
        k, _, val = line.strip().partition(":")
        if k.strip() != key:
            continue
        val = val.strip()
        if val.startswith("["):
            return [v.strip().strip("\"'") for v in val.strip("[]").split(",") if v.strip()]
        indent = len(line) - len(line.lstrip())
        out = []
        for nxt in lines[i + 1:]:
            if not nxt.strip():
                continue
            if len(nxt) - len(nxt.lstrip()) <= indent:
                break
            m = re.match(r"\s*-\s*(.+?)\s*$", nxt)
            if m:
                out.append(m.group(1).strip().strip("\"'"))
        return out
    return []


# ------------------------------------------------------------------ cron -> CT

def _cron_fields(expr: str) -> list[str]:
    """Fields of an EventBridge `cron(...)` (6-field) or a plain Actions cron (5-field)."""
    e = expr.strip()
    m = re.fullmatch(r"cron\((.*)\)", e)
    if m:
        e = m.group(1)
    return e.split()


def cron_to_ct(expr: str) -> str:
    """UTC cron -> a human ~CT reading. Returns "—" for anything it can't state truthfully."""
    f = _cron_fields(expr)
    if len(f) < 2 or not f[0].isdigit():
        return "—"
    minute, hour = int(f[0]), f[1]
    if "/" in hour:                       # 0/2 -> every 2 h; the offset shifts the wall clock,
        step = hour.split("/", 1)[1]      # not the cadence, so this reading is offset-invariant
        return f"every {int(step)} h at :{minute:02d}" if step.isdigit() else "—"
    if hour == "*":
        return f"hourly at :{minute:02d}"
    parts = hour.split(",")
    if not all(p.isdigit() for p in parts):
        return "—"
    hours = sorted((int(p) - CT_OFFSET_H) % 24 for p in parts)
    return " + ".join(f"{h:02d}:{minute:02d}" for h in hours)


# ------------------------------------------------------------------ fact gathering

def terraform_jobs() -> list[tuple[str, str, str]]:
    """(job, cron, trailing comment) from var.jobs — same split-then-regex as
    tests/infra/test_lambda_handler.py::test_scheduled_job_names_all_exist_in_jobs."""
    tf = _read("infra/terraform/variables.tf")
    block = tf.split('variable "jobs"')[1]
    rows = re.findall(
        r'^\s*(\w+)\s*=\s*\{\s*cron\s*=\s*"([^"]+)"\s*\}\s*(?:#\s*(.*?))?\s*$',
        block, re.MULTILINE)
    return [(j, c, (note or "").strip()) for j, c, note in _need(rows, "var.jobs")]


def terraform_project() -> str:
    tf = _read("infra/terraform/variables.tf")
    m = re.search(r'variable\s+"project"\s*\{.*?default\s*=\s*"([^"]+)"', tf, re.S)
    return _need(m and m.group(1), "var.project")


def handler_jobs() -> dict[str, list[tuple[str, list[str]]]]:
    """handler.JOBS, loaded by path (infra/app is not a package; its imports are stdlib)."""
    path = REPO / "infra" / "app" / "handler.py"
    spec = importlib.util.spec_from_file_location("hq_lambda_handler_sysmap", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return _need(dict(mod.JOBS), "handler.JOBS")


def workflows() -> list[tuple[str, str, str]]:
    """(workflow name, filename, trigger summary) for every .github/workflows/*.yml."""
    out = []
    for path in sorted((REPO / ".github" / "workflows").glob("*.yml")):
        text = path.read_text()
        m = re.search(r"^name:\s*(.+?)\s*$", text, re.MULTILINE)
        name = m.group(1).strip('"\'') if m else path.stem
        lines = _on_block(text)
        parts: list[str] = []
        for key, _inline, nested in _keys_at_top_indent(lines):
            if key == "schedule":
                for cron in re.findall(r'-\s*cron:\s*["\']?([^"\'#\n]+?)["\']?\s*(?:#.*)?$',
                                       "\n".join(nested), re.MULTILINE):
                    parts.append(f"cron `{cron.strip()}` (~{cron_to_ct(cron)} CT)")
            elif key == "push":
                bits = []
                branches = _list_values(nested, "branches")
                paths = _list_values(nested, "paths")
                if branches:
                    bits.append("branches " + ", ".join(f"`{b}`" for b in branches))
                if paths:
                    bits.append("paths " + ", ".join(f"`{p}`" for p in paths))
                parts.append("push" + (" (" + "; ".join(bits) + ")" if bits else ""))
            elif key == "pull_request":
                parts.append("pull_request")
            elif key == "workflow_dispatch":
                parts.append("dispatch")
            elif key == "workflow_run":
                # A listener workflow (red-main.yml). Without this branch the map
                # would print "—" — an alarm that looks like it has no trigger.
                watched = _list_values(nested, "workflows")
                types = _list_values(nested, "types")
                bits = []
                if watched:
                    bits.append("after " + ", ".join(f"`{w}`" for w in watched))
                if types:
                    bits.append(", ".join(types))
                parts.append("workflow_run" + (" (" + "; ".join(bits) + ")" if bits else ""))
        if parts == ["dispatch"]:
            parts = ["**dispatch only**"]
        out.append((name, path.name, " · ".join(parts) or "—"))
    return _need(out, "workflows")


def snapshot_facts() -> dict:
    t = _read("tracker/snapshot.py")
    m = re.search(r"NEVER_SNAPSHOT\s*=\s*frozenset\(\{(.*?)\}\)", t, re.S)
    never = sorted(re.findall(r'"(\w+)"', m.group(1) if m else ""))
    mon = _read("monitor/snapshot.py")
    feed_key = re.search(r'f"(feeds/[^"]+)"', mon)
    return {
        "never": _need(never, "tracker.snapshot NEVER_SNAPSHOT"),
        "bucket_env": _need(re.search(r'S3_BUCKET_ENV\s*=\s*"([^"]+)"', t).group(1),
                            "tracker.snapshot S3_BUCKET_ENV"),
        "hb_git": _need(re.search(r'HEARTBEAT_GIT\s*=\s*"([^"]+)"', t).group(1), "HEARTBEAT_GIT"),
        "hb_s3": _need(re.search(r'HEARTBEAT_S3\s*=\s*"([^"]+)"', t).group(1), "HEARTBEAT_S3"),
        "feed_key": _need(feed_key and feed_key.group(1).replace("{label}", "<label>"),
                          "monitor.snapshot feed key"),
    }


def digest_facts() -> dict:
    t = _read("tracker/digest.py")
    body = re.search(r"CADENCE_HOURS\s*=\s*\{(.*?)\}", t, re.S)
    cadence = [(k, v) for k, v in re.findall(r'"(\w+)"\s*:\s*([0-9.]+)', body.group(1) if body else "")]
    pg_body = re.search(r"PG_CADENCE_HOURS\s*=\s*\{(.*?)\n\}", t, re.S)
    pg_cadence = [(k, v) for k, v in
                  re.findall(r'"(\w+)"\s*:\s*([0-9.]+)', pg_body.group(1) if pg_body else "")]
    beats = re.search(r"BACKUP_BEATS\s*=\s*\((.*?)\)", t, re.S)
    capture = re.search(r"CAPTURE_ALERT_HOURS\s*=\s*([0-9.]+)", t)
    return {
        "cadence": _need(cadence, "digest CADENCE_HOURS"),
        # The STORE's cadence table, deliberately not a slice of the sheet's: the two
        # stores hold different lanes (`pgdump` has no Config row; `capture` has no pg one).
        "pg_cadence": _need(pg_cadence, "digest PG_CADENCE_HOURS"),
        "backup_beats": _need(re.findall(r'"(\w+)"', beats.group(1) if beats else ""),
                              "digest BACKUP_BEATS"),
        "capture_alert_h": _need(capture and capture.group(1), "digest CAPTURE_ALERT_HOURS"),
    }


def alarms() -> list[dict]:
    """The CloudWatch alarms, with ${local.name} resolved to var.project."""
    t = _read("infra/terraform/alerts.tf")
    project = terraform_project()
    out = []
    for m in re.finditer(r'resource\s+"aws_cloudwatch_metric_alarm"\s+"(\w+)"\s*\{(.*?)\n\}',
                         t, re.S):
        body = m.group(2)

        def field(key: str, default: str = "—") -> str:
            f = re.search(rf'^\s*{key}\s*=\s*"?([^"\n]+?)"?\s*(?:#.*)?$', body, re.MULTILINE)
            return f.group(1).strip().replace("${local.name}", project) if f else default

        out.append({
            "resource": m.group(1),
            "name": field("alarm_name"),
            "metric": field("metric_name"),
            "statistic": field("statistic"),
            "comparison": field("comparison_operator"),
            "threshold": field("threshold"),
            "period": field("period"),
            "missing": field("treat_missing_data"),
        })
    return _need(out, "alerts.tf alarms")


def sns_topic() -> str:
    t = _read("infra/terraform/alerts.tf")
    m = re.search(r'resource\s+"aws_sns_topic"\s+"alerts"\s*\{.*?name\s*=\s*"([^"]+)"', t, re.S)
    return _need(m and m.group(1).replace("${local.name}", terraform_project()), "SNS topic")


def schema_tabs() -> list[tuple[str, str]]:
    t = _read("core/schema.py")
    body = re.search(r"^TABS\s*=\s*\{(.*?)^\}", t, re.S | re.MULTILINE)
    pairs = re.findall(r'"(\w+)"\s*:\s*"([^"]+)"', body.group(1) if body else "")
    return _need(pairs, "core.schema TABS")


def registry() -> dict:
    doc = _mini_yaml(_read("hq.config.yaml"))
    users = doc.get("users") if isinstance(doc.get("users"), dict) else {}
    return {
        "users": sorted(users) if users else [],
        "default_user": str(doc.get("default_user") or ""),
        "ntfy": doc.get("ntfy") if isinstance(doc.get("ntfy"), dict) else {},
    }


def selfheal_cron() -> str:
    m = re.search(r'-\s*cron:\s*"([^"]+)"', _read(".github/workflows/selfheal.yml"))
    return _need(m and m.group(1), "selfheal.yml cron")


# There is no pgdump_cron(): `pgdump.yml` was deleted with the rest of the migration scaffolding
# (it was gated OFF and had no database behind it). Its row in the backup-lanes table below is a
# literal, not a parse — resurrect the workflow from git history and re-add a parser here if a
# live Supabase ever exists.


# ------------------------------------------------------------------ section renderers

def _chain(steps: list[tuple[str, list[str]]]) -> str:
    return " → ".join("`" + " ".join([m, *a]) + "`" for m, a in steps)


def sec_lambda_schedules() -> str:
    jobs = terraform_jobs()
    hjobs = handler_jobs()
    scheduled = {j for j, _, _ in jobs}
    lines = [
        f"One Lambda function (`{terraform_project()}-bots`, one container image) runs every job; "
        "EventBridge Scheduler fires it with `{\"job\": \"<name>\"}`.",
        "",
        "| Job | Cron (UTC) | ~CT | Module chain it runs | Note in `variables.tf` |",
        "|---|---|---|---|---|",
    ]
    for job, cron, note in jobs:
        chain = _chain(hjobs.get(job, [])) or "**missing from handler.JOBS**"
        lines.append(f"| `{job}` | `{cron}` | {cron_to_ct(cron)} | {chain} | {note or '—'} |")
    for job in sorted(set(hjobs) - scheduled):
        lines.append(f"| `{job}` | — | *unscheduled — dispatch by hand* | {_chain(hjobs[job])} | — |")
    lines += [
        "",
        f"~CT is CDT (UTC−{CT_OFFSET_H}), the current Chicago offset. The crons themselves are "
        "pinned to UTC, so in winter (CST, UTC−6) every ~CT time above lands one hour earlier.",
        "",
        "Dispatch an unscheduled job (or re-run any job now):",
        "",
        "```sh",
        f'aws lambda invoke --function-name {terraform_project()}-bots \\',
        "  --payload '{\"job\":\"selfheal\"}' --cli-binary-format raw-in-base64-out /tmp/out.json",
        "```",
    ]
    return "\n".join(lines)


def sec_actions_workflows() -> str:
    lines = ["| Workflow | File | Trigger |", "|---|---|---|"]
    for name, filename, trigger in workflows():
        lines.append(f"| {name} | `.github/workflows/{filename}` | {trigger} |")
    lines += [
        "",
        "**Run a bot** is the whole manual lane: one dispatch, pick any job from "
        "`infra/app/handler.py`'s `JOBS`, same code and same repo secrets as the Lambda — the "
        "re-run path and the fallback for the day AWS itself is the problem. The eleven per-bot "
        "workflows it replaced were cutover scaffolding and live on in git history. Everything else "
        "here is scheduled because its product is a git commit, plus CI and the resume pipeline.",
    ]
    return "\n".join(lines)


def sec_backup_lanes() -> str:
    s = snapshot_facts()
    jobs = dict((j, c) for j, c, _ in terraform_jobs())
    snap_cron = jobs.get("snapshot", "—")
    sh_cron = selfheal_cron()
    tabs = [k for k, _ in schema_tabs()]
    kept = len(tabs) - len(s["never"])
    never = ", ".join(f"`{n}`" for n in s["never"])
    lines = [
        "| Lane | What | Where it lands | Cadence | Own heartbeat | How its death reaches you |",
        "|---|---|---|---|---|---|",
        f"| CSV → git (Actions) | {kept} of {len(tabs)} tab CSVs (never {never}) | "
        f"`snapshots/<user>/*.csv`, committed by `selfheal.yml` | `{sh_cron}` "
        f"(~{cron_to_ct(sh_cron)} CT) | `heartbeat_{s['hb_git']}` | workflow ops push on failure; "
        "digest pages **HQ backups stale** once the beat passes 2× its cadence |",
        f"| CSV → S3 (Lambda) | the same tab CSVs | `s3://$"
        f"{s['bucket_env']}/snapshots/<user>/<tab>.csv` (versioned bucket) | `{snap_cron}` "
        f"(~{cron_to_ct(snap_cron)} CT) | `heartbeat_{s['hb_s3']}` | a failed upload **raises**, so "
        "`handler.py` names the job in an ops push; staleness pages from the digest |",
        f"| Schema + gid re-pin (Actions) | re-asserted headers/dropdowns/protections and the "
        f"re-pinned `hq.config.yaml` | a git commit on `main` | `{sh_cron}` "
        f"(~{cron_to_ct(sh_cron)} CT) | `heartbeat_selfheal` | same as the git CSV lane |",
        f"| Feed JSON (best effort) | `monitor.run`'s feed history | `monitor/snapshots/*.json` in "
        f"git on a **Run a bot** dispatch; `{s['feed_key']}` in S3 when the FS is read-only | with "
        "each sweep | none | prints a warning and never fails a completed sweep — the CSV lanes are "
        "the Feed tab's real backup |",
        "| PG dump | `pg_dump --schema=public` of the Supabase store | `snapshots/pg/hq.sql.gz` + "
        "commit | `pgdump.yml`, nightly — but the job is gated on the `PGDUMP_ENABLED` repo "
        "variable, so it runs only once that is `true` | pg lane `pgdump` in `channel_runs` "
        "(written by `python -m tracker.beat pgdump` as the job's last step) | the digest pages "
        "**HQ backups stale** naming `pgdump (pg)` — including while the lane has never run, which "
        "is what makes “pg is load-bearing and has no backup” visible the morning after "
        "`HQ_PG_WRITES=first_class` is set |",
        "",
        "The git and S3 CSV lanes are deliberately independent copies on independent schedulers, "
        "each with its **own** heartbeat: one shared beat would let the nightly Actions run keep it "
        "fresh while the S3 copy had been dead for a week. The PG dump lane is the same doctrine "
        "for the store the sheet is being replaced by. Restore procedure (the CSV lanes plus "
        "Sheets' own version history): `docs/RUNBOOK.md` § Restoring the sheet.",
    ]
    return "\n".join(lines)


def sec_watchdogs() -> str:
    d = digest_facts()
    beats = set(d["backup_beats"])
    cap_h = d["capture_alert_h"]
    lines = [
        "`tracker.digest` reads the `heartbeat_*` rows in the Config tab and flags anything older "
        "than 2× its cadence. Most flags only print in the briefing; the ones marked **pages** "
        "also push to the ops topic.",
        "",
        "| Heartbeat | Expected every | Flagged in the briefing after | Pages? |",
        "|---|---|---|---|",
    ]
    for name, hours in d["cadence"]:
        h = float(hours)
        pretty = f"{h:g} h"
        if name in beats:
            pages = "**pages** — “HQ backups stale”, naming the lane"
        elif name == "capture":
            pages = f"**pages** — Gmail capture silent for {float(cap_h):g} h"
        else:
            pages = "briefing line only"
        lines.append(f"| `heartbeat_{name}` | {pretty} | {h * 2:g} h | {pages} |")
    lines += [
        "",
        f"Backup beats watched as a set: {', '.join('`' + b + '`' for b in d['backup_beats'])}. "
        "A beat that was never written reads “no heartbeat yet” and pages the same way — a lane "
        "that has never run is not a lane that is fine.",
        "",
        "**The store's own beats** (`HQ_PG_WRITES=first_class` only). The same lanes stamp a row "
        "in `channel_runs`, and the digest holds each store to the cadence SEPARATELY — neither "
        "may vouch for the other, so a lane alive in the sheet and dead in pg pages, and the "
        "reverse pages too. With the flag unset this table is not read at all.",
        "",
        "| pg lane | Expected every | Written by | Pages? |",
        "|---|---|---|---|",
    ]
    writers = {
        "snapshot": "`tracker.snapshot` (git mode, `selfheal.yml`)",
        "snapshot_s3": "`tracker.snapshot` (S3 mode, the `snapshot` Lambda job)",
        "digest": "`tracker.digest`, after the briefing is composed and sent",
        "pgdump": "`python -m tracker.beat pgdump`, last step of `pgdump.yml`",
    }
    for name, hours in d["pg_cadence"]:
        h = float(hours)
        pages = ("**pages** — “HQ backups stale”, naming the lane and the store"
                 if name in beats else "briefing line only")
        lines.append(f"| `{name}` | {h:g} h | {writers.get(name, '—')} | {pages} |")
    return "\n".join(lines)


def sec_alerting() -> str:
    al = alarms()
    reg = registry()
    ops = reg["ntfy"].get("ops", "?")
    project = terraform_project()
    lines = ["```mermaid", "flowchart TD"]
    lines += [
        '    BOT["a bot raises or exits nonzero"] --> H["handler.py except block<br/>'
        'core.notify.ops_alert — names the job AND the module"]',
        '    KILL["timeout · OOM kill · broken image<br/>import error · dead SSM secret store"] '
        '--> A1',
        '    DEAD["the schedules stop firing<br/>(role, account, or EventBridge itself)"] --> A2',
    ]
    for i, a in enumerate(al, start=1):
        node = f"A{i}"
        lines.append(
            f'    {node}["CloudWatch alarm {a["name"]}<br/>{a["metric"]} '
            f'{a["comparison"]} {a["threshold"]} · period {a["period"]}s<br/>'
            f'missing data: {a["missing"]}"] --> SNS'
        )
    lines += [
        f'    SNS["SNS topic {sns_topic()}"] --> AL["{project}-alerter Lambda<br/>'
        'stdlib-only zip — shares no code with the bots\' image"]',
        '    STALE["a backup heartbeat goes stale"] --> DG["tracker.digest watchdog"]',
        f'    H --> NTFY["ntfy topic {ops}<br/>(your phone)"]',
        "    AL --> NTFY",
        "    DG --> NTFY",
        "```",
        "",
        "| Alarm | Metric | Rule | Period | Missing data | Terraform |",
        "|---|---|---|---|---|---|",
    ]
    for a in al:
        lines.append(
            f'| `{a["name"]}` | {a["metric"]} ({a["statistic"]}) | {a["comparison"]} '
            f'{a["threshold"]} | {a["period"]}s | `{a["missing"]}` | '
            f'`aws_cloudwatch_metric_alarm.{a["resource"]}` |'
        )
    lines += [
        "",
        "Both alarms also fire on recovery, so an ALARM always closes with a push. Layer 1 "
        "(`handler.py`) is the only layer that can name which bot died — one Lambda runs them all "
        "— and layer 2 is the only layer that survives that Lambda being broken.",
    ]
    return "\n".join(lines)


def sec_sheet_tabs() -> str:
    never = set(snapshot_facts()["never"])
    lines = [
        "The tabs `core/schema.py` owns. bootstrap creates them, self-heal re-asserts them "
        "nightly, and every bot addresses them by gid and by header name — never by position.",
        "",
        "| Key (code) | Tab title (sheet) | In the nightly CSV snapshots? |",
        "|---|---|---|",
    ]
    for key, title in schema_tabs():
        mark = "no — `NEVER_SNAPSHOT`" if key in never else "yes"
        lines.append(f"| `{key}` | {title} | {mark} |")
    lines.append("")
    lines.append(
        "`NEVER_SNAPSHOT` tabs are excluded because a snapshot is forever: the scout preferences "
        "tab is free text a human has pasted credentials into, Email Events holds third-party "
        "personal mail that Gmail capture can rebuild, and Outbox holds the rendered text of "
        "pending notifications. All three are still covered by Sheets' own version history.")
    return "\n".join(lines)


def sec_users_lanes() -> str:
    reg = registry()
    jobs = terraform_jobs()
    project = terraform_project()
    n = len(jobs)
    if not reg["users"]:
        shape = ["**Registry shape: flat (single user).** `hq.config.yaml` has no `users:` map, so "
                 "every bot reads the one sheet id at the top of the file and EventBridge sends the "
                 "bare `{\"job\": \"<name>\"}` payload.",
                 "",
                 f"- Schedules deployed: **{n}** — `{project}-<job>`, one per job.",
                 "- `HQ_USER` is unset on every invocation (the handler pops it, so a warm "
                 "container can't inherit the previous run's user).",
                 "- Adding a user: `tracker.provision` writes a `users:` map into `hq.config.yaml`, "
                 f"then `terraform apply` grows the lanes to jobs × users. The default user keeps "
                 f"the flat schedule name `{project}-<job>`; everyone else gets "
                 f"`{project}-<job>-<user>`."]
    else:
        who = ", ".join(f"`{u}`" for u in reg["users"])
        shape = [f"**Registry shape: multi-user.** `hq.config.yaml` carries a `users:` map "
                 f"({who}), default `{reg['default_user'] or '(unset)'}`.",
                 "",
                 f"- Schedules deployed: **{n} jobs × {len(reg['users'])} users = "
                 f"{n * len(reg['users'])}** — the default user keeps the flat name "
                 f"`{project}-<job>`, everyone else is `{project}-<job>-<user>`.",
                 "- Each invocation carries `{\"job\", \"user\"}`; the handler exports `HQ_USER` "
                 "and clears `core.config`'s caches every time, so no warm container can serve one "
                 "user's sheet id to another."]
    topics = reg["ntfy"]
    shape += ["", "| ntfy topic | Carries |", "|---|---|"]
    if topics.get("jobs"):
        shape.append(f"| `{topics['jobs']}` | the useful pushes: new roles, instant OA/interview "
                     "mail, resume previews |")
    if topics.get("ops"):
        shape.append(f"| `{topics['ops']}` | failures only — silence means healthy |")
    return "\n".join(shape)


def sec_big_picture() -> str:
    jobs = terraform_jobs()
    hjobs = handler_jobs()
    project = terraform_project()
    s = snapshot_facts()
    return "\n".join([
        "```mermaid",
        "flowchart LR",
        f'    EB["EventBridge Scheduler<br/>{len(jobs)} schedules"] --> '
        f'LAM["Lambda {project}-bots<br/>one image · {len(hjobs)} jobs"]',
        '    SSM["SSM /job-hq/* SecureStrings"] --> LAM',
        '    LAM --> SHEET["Google Sheet<br/>Job Search HQ"]',
        f'    LAM --> S3["S3 backups bucket<br/>${s["bucket_env"]}"]',
        '    LAM --> NTFY["ntfy → your phone<br/>jobs topic + ops topic"]',
        '    ACT["GitHub Actions<br/>selfheal · CI · resume · Run a bot"] --> '
        'GIT["git commits on main<br/>tab CSVs · re-pinned gids"]',
        '    ACT --> DRIVE["Google Drive<br/>Resume/Current + Archive"]',
        "    ACT --> NTFY",
        '    GS["Gmail Apps Script<br/>capture, every 15 min"] --> EV["Email Events tab"]',
        '    EV --> JOIN["tracker.join<br/>(in the 2-hourly tracker chain)"] --> SHEET',
        "    GS --> NTFY",
        '    ED["Vercel editor<br/>phone edits to resume/*.yaml"] --> PUSH["git push"] --> ACT',
        '    HUMAN["you + the scout"] --> SHEET',
        "    SHEET --> LAM",
        "```",
    ])


SECTIONS: dict[str, callable] = {
    "big-picture": sec_big_picture,
    "lambda-schedules": sec_lambda_schedules,
    "actions-workflows": sec_actions_workflows,
    "backup-lanes": sec_backup_lanes,
    "watchdogs": sec_watchdogs,
    "alerting": sec_alerting,
    "sheet-tabs": sec_sheet_tabs,
    "users-lanes": sec_users_lanes,
}


# ------------------------------------------------------------------ doc surgery

def _doc_label() -> str:
    """Repo-relative when it can be (stable output), the raw path when a test repoints DOC."""
    try:
        return str(DOC.relative_to(REPO))
    except ValueError:
        return str(DOC)


def build_sections() -> dict[str, str]:
    return {name: fn().rstrip("\n") for name, fn in SECTIONS.items()}


def render(doc: str, sections: dict[str, str]) -> str:
    """Replace each marked section's body; everything outside the markers is untouched."""
    out = doc
    for name, body in sections.items():
        begin, end = _BEGIN.format(name), _END.format(name)
        pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end), re.S)
        if not pattern.search(out):
            raise SystemExit(
                f"[sysmap] {_doc_label()} has no '{name}' marker pair "
                f"({begin} … {end}) — add it, or drop the section from SECTIONS.")
        out = pattern.sub(lambda _m, b=begin, e=end, s=body: f"{b}\n{s}\n{e}", out, count=1)
    return out


def stale_sections(doc: str, sections: dict[str, str]) -> list[str]:
    return [name for name, body in sections.items()
            if not re.search(re.escape(_BEGIN.format(name)) + r"\n" + re.escape(body)
                             + r"\n" + re.escape(_END.format(name)), doc)]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python scripts/sysmap.py", description=__doc__.split("\n")[0])
    ap.add_argument("--check", action="store_true",
                    help="don't write; exit 1 if the committed doc is stale")
    args = ap.parse_args(argv)

    doc = DOC.read_text()
    sections = build_sections()
    fresh = render(doc, sections)

    if args.check:
        stale = stale_sections(doc, sections)
        if not stale and fresh == doc:
            print(f"[sysmap] {_doc_label()} is current ({len(sections)} sections).")
            return 0
        print(f"[sysmap] STALE generated sections in {_doc_label()}: "
              f"{', '.join(stale) or 'formatting'}", file=sys.stderr)
        diff = list(difflib.unified_diff(doc.splitlines(), fresh.splitlines(),
                                         "committed", "regenerated", lineterm="", n=1))
        for line in diff[:40]:
            print("  " + line, file=sys.stderr)
        if len(diff) > 40:
            print(f"  … {len(diff) - 40} more diff lines", file=sys.stderr)
        print("[sysmap] fix: python scripts/sysmap.py  (then commit docs/SYSTEM.md)",
              file=sys.stderr)
        return 1

    if fresh == doc:
        print(f"[sysmap] {_doc_label()} already current ({len(sections)} sections).")
        return 0
    DOC.write_text(fresh)
    print(f"[sysmap] rewrote {len(sections)} generated sections in {_doc_label()}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
