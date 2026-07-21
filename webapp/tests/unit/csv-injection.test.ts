import { describe, expect, it } from "vitest";
import { JOB_COLUMNS } from "@/lib/export/columns";
import { escapeField, toCsv, toTsv, UTF8_BOM } from "@/lib/export/delimited";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";

/**
 * CSV/DDE formula injection.
 *
 * Excel and Google Sheets execute a cell whose text begins with = + - @,
 * TAB, or CR. Company names and job titles arrive verbatim from third-party
 * ATS boards, so anyone who can post a job to a watched board controls that
 * text — "=cmd|' /c calc'!A1" is the classic DDE payload, and =IMPORTXML /
 * =HYPERLINK exfiltrate data from Google Sheets. RFC-4180 quoting is no
 * defense: the quotes are stripped before the spreadsheet interprets the text.
 */

/** The characters a spreadsheet treats as the start of a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** Minimal RFC-4180 reader parameterized on the delimiter, so assertions see
 *  the fields the way Excel does after quote-stripping — the exact moment
 *  formula interpretation happens. */
function parseLine(line: string, delimiter: string): string[] {
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
    else if (c === delimiter) { out.push(field); field = ""; }
    else field += c;
  }
  out.push(field);
  return out;
}

describe("formula-lead neutralization in escapeField", () => {
  it("prefixes the classic DDE payload with an apostrophe", () => {
    expect(escapeField("=cmd|' /c calc'!A1", ",")).toBe("'=cmd|' /c calc'!A1");
  });

  it("prefixes each dangerous lead character", () => {
    expect(escapeField("=2+3", ",")).toBe("'=2+3");
    expect(escapeField("+2+3+cmd|' /c calc'!A1", ",")).toBe("'+2+3+cmd|' /c calc'!A1");
    expect(escapeField("-2+3", ",")).toBe("'-2+3");
    expect(escapeField("@SUM(A1)", ",")).toBe("'@SUM(A1)");
  });

  it("neutralizes a TAB lead", () => {
    // no comma, quote, or newline: stays unquoted, but no longer starts
    // with the tab a paste parser would honour as a formula lead
    expect(escapeField("\t=2+3", ",")).toBe("'\t=2+3");
  });

  it("neutralizes a CR lead, and the CR still forces quoting", () => {
    expect(escapeField("\r=2+3", ",")).toBe("\"'\r=2+3\"");
  });

  it("quoted-field interaction: prefix lands inside the quotes, doubling intact", () => {
    // commas and embedded quotes force RFC-4180 quoting; the apostrophe must
    // sit inside the quoted region so quote-stripping still yields a
    // neutralized value
    const raw = '=HYPERLINK("http://evil.example","click, me")';
    const escaped = escapeField(raw, ",");
    expect(escaped).toBe('"\'=HYPERLINK(""http://evil.example"",""click, me"")"');
    expect(parseLine(escaped, ",")).toEqual([`'${raw}`]);
  });

  it("does not mangle a negative number", () => {
    // "-15" is a value in a numeric column; Excel must keep reading it as -15
    expect(escapeField("-15", ",")).toBe("-15");
    expect(escapeField("-15.5", ",")).toBe("-15.5");
    expect(escapeField("+3", ",")).toBe("+3");
  });

  it("does not mangle the bare-hyphen placeholder", () => {
    // "-" is how a comp range says "not listed"; it cannot carry an expression
    expect(escapeField("-", ",")).toBe("-");
    expect(escapeField("--", ",")).toBe("--");
  });

  it("leaves interior formula characters alone", () => {
    // only the LEAD character triggers interpretation; "R&D = growth" is text
    expect(escapeField("R&D = growth", ",")).toBe("R&D = growth");
    expect(escapeField("C++ Engineer", ",")).toBe("C++ Engineer");
  });
});

describe("CSV output is formula-free end-to-end", () => {
  const hostile = {
    ...FIXTURE_JOBS[0],
    company: "=cmd|' /c calc'!A1",
    title: '=HYPERLINK("http://evil.example","click, me")',
  };

  it("no parsed field begins with a formula lead, across fixtures and payloads", () => {
    const csv = toCsv([...FIXTURE_JOBS, hostile], JOB_COLUMNS);
    const lines = csv.replace(UTF8_BOM, "").split("\r\n");
    for (const line of lines) {
      for (const field of parseLine(line, ",")) {
        expect(field).not.toMatch(FORMULA_LEAD);
      }
    }
  });

  it("the hostile row still parses to exactly one field per column", () => {
    const csv = toCsv([hostile], JOB_COLUMNS);
    const lines = csv.replace(UTF8_BOM, "").split("\r\n");
    const header = parseLine(lines[0], ",");
    const row = parseLine(lines[1], ",");
    expect(row).toHaveLength(JOB_COLUMNS.length);
    // the payload survives as readable text — prefixed, not truncated
    expect(row[header.indexOf("Company")]).toBe("'=cmd|' /c calc'!A1");
    expect(row[header.indexOf("Title")]).toBe(
      '\'=HYPERLINK("http://evil.example","click, me")',
    );
  });
});

describe("clipboard TSV is formula-free end-to-end", () => {
  it("neutralizes a formula lead before it reaches the clipboard", () => {
    const hostile = { ...FIXTURE_JOBS[0], company: "=2+3" };
    const tsv = toTsv([hostile], JOB_COLUMNS);
    const [head, row] = tsv.split("\r\n");
    const header = parseLine(head, "\t");
    const fields = parseLine(row, "\t");
    expect(fields[header.indexOf("Company")]).toBe("'=2+3");
  });

  it("a TAB-lead payload cannot split the row on paste", () => {
    const hostile = { ...FIXTURE_JOBS[0], company: "\t=2+3" };
    const tsv = toTsv([hostile], JOB_COLUMNS);
    const row = tsv.split("\r\n")[1];
    const fields = parseLine(row, "\t");
    expect(fields).toHaveLength(JOB_COLUMNS.length);
    for (const field of fields) {
      expect(field).not.toMatch(FORMULA_LEAD);
    }
  });
});
