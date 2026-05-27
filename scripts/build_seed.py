"""Build companies.seed.csv from the handoff doc's 'Public API (125)' table.

Parses the markdown table under '### Public API (125)', then appends 6 Workday rows.
Output columns (REQUIRED order): name,ats,slug,monitor,seeded
"""
import csv
import os

DOC = os.path.join(
    os.path.dirname(__file__),
    "..",
    "background-context",
    "grok-exported-chat-open-source-tools",
    "pm-job-monitor-handoff-doc.md",
)
OUT = os.path.join(os.path.dirname(__file__), "..", "companies.seed.csv")

WORKDAY_ROWS = [
    ("Adobe", "workday", "adobe.wd5.myworkdayjobs.com/external_experienced"),
    ("Atlassian", "workday", "atlassian.wd5.myworkdayjobs.com/Atlassian"),
    ("CrowdStrike", "workday", "crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers"),
    ("Nvidia", "workday", "nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"),
    ("Salesforce", "workday", "salesforce.wd12.myworkdayjobs.com/External_Career_Site"),
    ("ServiceNow", "workday", "servicenow.wd1.myworkdayjobs.com/ServiceNowCareers"),
]


def parse_table(path):
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()

    rows = []
    in_section = False
    in_table = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("### Public API (125)"):
            in_section = True
            continue
        if in_section and stripped.startswith("###"):
            break  # next heading -> stop
        if not in_section:
            continue
        if not stripped.startswith("|"):
            continue
        # It's a table line. Split on pipes.
        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if len(cells) < 3:
            continue
        # Skip header row and separator row.
        if cells[0].lower() == "company":
            in_table = True
            continue
        if set(cells[0]) <= {"-", ":"} and cells[0]:
            continue
        if not in_table:
            continue
        name = cells[0].strip()
        ats = cells[1].strip().lower()
        slug = cells[2].strip().strip("`").strip()
        if not name:
            continue
        rows.append((name, ats, slug))
    return rows


def main():
    rows = parse_table(DOC)
    all_rows = rows + WORKDAY_ROWS
    with open(OUT, "w", newline="\n", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["name", "ats", "slug", "monitor", "seeded"])
        for name, ats, slug in all_rows:
            w.writerow([name, ats, slug, "TRUE", "FALSE"])
    print(f"Wrote {len(all_rows)} data rows ({len(rows)} standard + {len(WORKDAY_ROWS)} workday)")


if __name__ == "__main__":
    main()
