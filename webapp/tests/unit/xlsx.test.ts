// @vitest-environment node
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { FIXTURE_APPLICATIONS, FIXTURE_JOBS } from "@/lib/data/fixtures";
import { APPLICATION_COLUMNS, JOB_COLUMNS } from "@/lib/export/columns";
import { buildXlsx } from "@/lib/export/xlsx";

/**
 * These tests read the generated workbook the way Excel does — by unzipping it
 * and parsing the sheet XML — rather than trusting that the writer was called
 * with the right arguments.
 *
 * That distinction is the whole point. The failure this guards against is a
 * file that opens without complaint and is quietly wrong: a date column that
 * shows `46222` instead of a date, an autofilter that covers half the rows, a
 * `null` written as the four-letter word. Every one of those passes a test
 * that only checks the arguments passed to the library.
 */

type Cell = { ref: string; t: string | null; s: number | null; v: string | null };

function open(buf: Uint8Array) {
  const files = unzipSync(buf);
  const read = (p: string) => (files[p] ? strFromU8(files[p]) : null);

  const sheet = read("xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error(`no sheet1.xml; parts: ${Object.keys(files).join(", ")}`);
  const styles = read("xl/styles.xml") ?? "";
  const sharedXml = read("xl/sharedStrings.xml") ?? "";

  // XML entities are how a correct writer stores `&` and `<`; a reader that
  // does not decode them reports an escaping bug that is not there.
  const decode = (s: string) =>
    s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&amp;/g, "&");

  // Shared strings, in document order — `t="s"` cells index into this.
  const shared = [...sharedXml.matchAll(/<si>(.*?)<\/si>/gs)].map((m) =>
    decode([...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((t) => t[1]).join("")),
  );

  const cells = new Map<string, Cell>();
  for (const m of sheet.matchAll(/<c\s+([^>]*?)\/>|<c\s+([^>]*?)>(.*?)<\/c>/gs)) {
    const attrs = m[1] ?? m[2] ?? "";
    const body = m[3] ?? "";
    const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const v = /<v>(.*?)<\/v>/s.exec(body)?.[1] ?? null;
    cells.set(ref, {
      ref,
      t: /t="([^"]+)"/.exec(attrs)?.[1] ?? null,
      s: attrs.includes('s="') ? Number(/s="(\d+)"/.exec(attrs)?.[1]) : null,
      v,
    });
  }

  /** Number-format code actually applied to a cell, resolved through styles.xml. */
  const formatOf = (cell: Cell): string | null => {
    if (cell.s === null) return null;
    const xfs = /<cellXfs[^>]*>(.*?)<\/cellXfs>/s.exec(styles)?.[1] ?? "";
    const xf = [...xfs.matchAll(/<xf\s[^>]*\/>|<xf\s[^>]*>.*?<\/xf>/gs)][cell.s];
    if (!xf) return null;
    const numFmtId = /numFmtId="(\d+)"/.exec(xf[0])?.[1];
    if (!numFmtId) return null;
    const custom = new RegExp(`<numFmt[^>]*numFmtId="${numFmtId}"[^>]*/>`).exec(styles)?.[0];
    return custom ? (/formatCode="([^"]*)"/.exec(custom)?.[1] ?? null) : `builtin:${numFmtId}`;
  };

  /** Text of a cell as a human would read it in Excel. */
  const text = (ref: string): string | null => {
    const c = cells.get(ref);
    if (!c || c.v === null) return null;
    return c.t === "s" ? (shared[Number(c.v)] ?? null) : c.v;
  };

  return { sheet, styles, shared, cells, formatOf, text };
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** 0-based column index to a spreadsheet column letter (A, B, ... Z, AA). */
function colLetter(i: number): string {
  return i < 26 ? LETTERS[i] : LETTERS[Math.floor(i / 26) - 1] + LETTERS[i % 26];
}

/** Excel's day serial, computed independently of the implementation. */
function excelSerial(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

const jobs = FIXTURE_JOBS;
const book = await buildXlsx(jobs, JOB_COLUMNS, { sheetName: "Jobs" });

describe("workbook structure", () => {
  it("is a real zip container with the parts Excel requires", () => {
    const files = unzipSync(book);
    for (const part of ["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]) {
      expect(Object.keys(files)).toContain(part);
    }
  });

  it("writes one header row plus one row per record", () => {
    const { sheet } = open(book);
    const rows = [...sheet.matchAll(/<row[\s>]/g)].length;
    expect(rows).toBe(jobs.length + 1);
  });

  it("writes the column headers verbatim in order", () => {
    const { text } = open(book);
    const headers = JOB_COLUMNS.map((_, i) => text(`${colLetter(i)}1`));
    expect(headers).toEqual(JOB_COLUMNS.map((c) => c.header));
  });
});

describe("frozen header", () => {
  // Without this, scrolling row 400 of an export leaves the reader guessing
  // which column is which — the single most common complaint about exports.
  it("freezes exactly the header row", () => {
    const { sheet } = open(book);
    const pane = /<pane[^>]*\/>/.exec(sheet)?.[0] ?? "";
    expect(pane).toContain('ySplit="1"');
    expect(pane).toContain('state="frozen"');
  });
});

describe("autofilter", () => {
  it("covers the header and every data row, not just the first screen", () => {
    const { sheet } = open(book);
    const ref = /<autoFilter[^>]*ref="([^"]+)"/.exec(sheet)?.[1];
    expect(ref).toBe(`A1:${colLetter(JOB_COLUMNS.length - 1)}${jobs.length + 1}`);
  });

  it("places autoFilter after sheetData, where the schema requires it", () => {
    // Out of order, Excel calls the file corrupt and offers to repair it.
    const { sheet } = open(book);
    expect(sheet.indexOf("<autoFilter")).toBeGreaterThan(sheet.indexOf("</sheetData>"));
  });
});

describe("real dates", () => {
  const postedIdx = JOB_COLUMNS.findIndex((c) => c.key === "posted");
  const firstWithDate = jobs.findIndex((j) => j.posted !== null);
  const ref = `${colLetter(postedIdx)}${firstWithDate + 2}`;

  it("stores a date as a number Excel can sort and filter on", () => {
    const { cells } = open(book);
    const cell = cells.get(ref)!;
    expect(cell.t).not.toBe("s"); // a shared string would be text, not a date
    expect(Number(cell.v)).toBe(excelSerial(jobs[firstWithDate].posted!));
  });

  it("displays that date as a date rather than a five-digit serial", () => {
    const { cells, formatOf } = open(book);
    expect(formatOf(cells.get(ref)!)).toBe("yyyy-mm-dd");
  });

  it("does not also leak the date into the shared string table as text", () => {
    const { shared } = open(book);
    expect(shared).not.toContain(jobs[firstWithDate].posted);
  });
});

describe("numbers", () => {
  it("stores compensation as a number so Excel can sum and sort it", () => {
    const idx = JOB_COLUMNS.findIndex((c) => c.key === "compMin");
    const row = jobs.findIndex((j) => j.compMinK !== null);
    const cell = open(book).cells.get(`${colLetter(idx)}${row + 2}`)!;
    expect(cell.t).not.toBe("s");
    expect(Number(cell.v)).toBe(jobs[row].compMinK);
  });
});

describe("unstated values", () => {
  it("writes a blank cell, never the word null", () => {
    const { sheet, shared } = open(book);
    expect(shared).not.toContain("null");
    expect(shared).not.toContain("undefined");
    expect(sheet).not.toMatch(/<v>null<\/v>/);
  });

  it("leaves the compensation cell empty for a posting that stated none", () => {
    const idx = JOB_COLUMNS.findIndex((c) => c.key === "comp");
    const row = jobs.findIndex((j) => j.compRange === null);
    expect(row).toBeGreaterThan(-1); // else this test proves nothing
    expect(open(book).text(`${colLetter(idx)}${row + 2}`)).toBeNull();
  });
});

describe("awkward content", () => {
  it("carries a very long title through intact", async () => {
    const longest = [...jobs].sort((a, b) => b.title.length - a.title.length)[0];
    expect(longest.title.length).toBeGreaterThan(60); // the fixture really is long
    const idx = JOB_COLUMNS.findIndex((c) => c.key === "title");
    const row = jobs.indexOf(longest);
    expect(open(book).text(`${colLetter(idx)}${row + 2}`)).toBe(longest.title);
  });

  it("escapes XML metacharacters instead of producing a corrupt file", async () => {
    const nasty = { ...jobs[0], company: 'A & B <Ltd> "quoted"', title: "x > y" };
    const buf = await buildXlsx([nasty], JOB_COLUMNS, { sheetName: "Jobs" });
    expect(open(buf).text("A2")).toBe('A & B <Ltd> "quoted"');
  });

  it("handles an empty row set without producing a broken autofilter", async () => {
    const buf = await buildXlsx([], JOB_COLUMNS, { sheetName: "Jobs" });
    const { sheet, text } = open(buf);
    expect(text("A1")).toBe("Company");
    // A1:P1 — the header alone. A range ending at row 0 is what Excel rejects.
    expect(/<autoFilter[^>]*ref="([^"]+)"/.exec(sheet)?.[1]).toBe(
      `A1:${colLetter(JOB_COLUMNS.length - 1)}1`,
    );
  });
});

describe("applications sheet", () => {
  it("writes the applied date as a real date too", async () => {
    const buf = await buildXlsx(FIXTURE_APPLICATIONS, APPLICATION_COLUMNS, {
      sheetName: "Pipeline",
    });
    const idx = APPLICATION_COLUMNS.findIndex((c) => c.key === "appliedDate");
    const row = FIXTURE_APPLICATIONS.findIndex((a) => a.appliedDate !== null);
    const { cells, formatOf } = open(buf);
    const cell = cells.get(`${colLetter(idx)}${row + 2}`)!;
    expect(Number(cell.v)).toBe(excelSerial(FIXTURE_APPLICATIONS[row].appliedDate!));
    expect(formatOf(cell)).toBe("yyyy-mm-dd");
  });
});
