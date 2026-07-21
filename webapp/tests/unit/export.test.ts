import { describe, expect, it } from "vitest";
import { JOB_COLUMNS } from "@/lib/export/columns";
import { escapeField, toCsv, toTsv, UTF8_BOM } from "@/lib/export/delimited";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";

/** Minimal RFC-4180 reader, so assertions parse the file the way Excel does
 *  rather than the naive way the escaping exists to defeat. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { out.push(field); field = ""; }
    else field += c;
  }
  out.push(field);
  return out;
}

describe("field escaping", () => {
  it("quotes a value containing the delimiter", () => {
    // the case that matters: "Product Manager, Payments" would otherwise
    // shift every later column on that row
    expect(escapeField("Product Manager, Payments", ",")).toBe('"Product Manager, Payments"');
  });

  it("doubles embedded quotes", () => {
    expect(escapeField('a "quoted" thing', ",")).toBe('"a ""quoted"" thing"');
  });

  it("quotes values containing newlines", () => {
    expect(escapeField("line one\nline two", ",")).toBe('"line one\nline two"');
  });

  it("leaves plain values alone", () => {
    expect(escapeField("Ramp", ",")).toBe("Ramp");
  });

  it("does not quote a comma when the delimiter is a tab", () => {
    expect(escapeField("PM, Payments", "\t")).toBe("PM, Payments");
  });
});

describe("CSV", () => {
  const rows = FIXTURE_JOBS.slice(0, 3);

  it("starts with a BOM so Excel decodes accents correctly", () => {
    expect(toCsv(rows, JOB_COLUMNS).startsWith(UTF8_BOM)).toBe(true);
  });

  it("emits exactly one header row plus one row per record", () => {
    const lines = toCsv(rows, JOB_COLUMNS).split("\r\n");
    expect(lines).toHaveLength(rows.length + 1);
  });

  it("writes an unstated value as empty, never as 'null' or 'undefined'", () => {
    const noComp = FIXTURE_JOBS.find((j) => j.compRange === null)!;
    const csv = toCsv([noComp], JOB_COLUMNS);
    expect(csv).not.toMatch(/null|undefined|Not listed/);
    const header = parseCsvLine(csv.split("\r\n")[0].replace(UTF8_BOM, ""));
    const row = parseCsvLine(csv.split("\r\n")[1]);
    expect(row).toHaveLength(JOB_COLUMNS.length);
    // the compensation column exists and is empty — not omitted, not "null"
    expect(row[header.indexOf("Compensation")]).toBe("");
  });

  it("keeps every row parseable when titles contain commas", () => {
    const csv = toCsv(FIXTURE_JOBS, JOB_COLUMNS);
    const lines = csv.split("\r\n");
    // every row must yield EXACTLY the column count once quoting is honoured
    for (const line of lines.slice(1)) {
      expect(parseCsvLine(line)).toHaveLength(JOB_COLUMNS.length);
    }
    // and the fixture set really does contain comma-bearing titles, or this
    // test would be proving nothing
    expect(FIXTURE_JOBS.some((j) => j.title.includes(","))).toBe(true);
  });
});

describe("clipboard TSV", () => {
  it("has no BOM — it would paste as a stray character", () => {
    expect(toTsv(FIXTURE_JOBS.slice(0, 1), JOB_COLUMNS).startsWith(UTF8_BOM)).toBe(false);
  });

  it("separates with tabs", () => {
    expect(toTsv(FIXTURE_JOBS.slice(0, 1), JOB_COLUMNS).split("\r\n")[0]).toContain("\t");
  });
});
