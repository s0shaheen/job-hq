// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// `lib/import/read.ts` starts with `import "server-only"`, whose whole job is to
// throw when it is loaded outside a React Server Component. Replacing it here is
// what lets the parser be unit-tested at all; nothing else about it is stubbed.
vi.mock("server-only", () => ({}));

import {
  cellText,
  coerceDate,
  declaredInflatedBytes,
  decodeWindows1252,
  isBlankCell,
  MAX_INFLATED_BYTES,
  MAX_ROWS,
  MAX_UPLOAD_BYTES,
  readDate,
  readDelimited,
  readWorkbook,
  readWorkbookSheet,
  sniffFormat,
  sniffHeaderRow,
  tooLarge,
  tooLargeInflated,
} from "@/lib/import/read";

/**
 * The parser tests read the committed fixture files rather than strings built in
 * here, for the same reason `xlsx.test.ts` unzips its output instead of checking
 * the arguments it passed: every failure in this module is a *byte* failure.
 *
 * A windows-1252 fixture written as a JS string literal is a UTF-8 file wearing
 * a costume and would pass a test the real thing fails. Same for a BOM, same for
 * CRLF, same for the OLE2 header on a .xls. Regenerate them with
 * `node tests/fixtures/import/build-fixtures.mjs`.
 *
 * Field counts per row are asserted everywhere, not just "it parsed". A
 * `;`-delimited file parsed with `,` yields one field per row and no error at
 * all — the row count is identical and only the field count says so.
 */

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "import");
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));
const widths = (rows: readonly unknown[][]): number[] => rows.map((r) => r.length);

describe("CSV dialects", () => {
  it("auto-detects the `;` a European copy of Excel writes", () => {
    const r = readDelimited(bytes("semicolon.csv"));
    expect(r.delimiter).toBe(";");
    // 4 per row is the assertion. Parsed as comma-delimited this file yields
    // [1,1,2,1] with zero papaparse errors, which is the silent version.
    expect(widths(r.rows)).toEqual([4, 4, 4, 4]);
    // And the comma inside a cell survives, which is why the delimiter matters.
    expect(r.rows[2]).toEqual(["Globex", "Senior PM, Payments", "Screen", "2026-02-11"]);
  });

  it("strips the UTF-8 BOM instead of welding it to the first header", () => {
    const r = readDelimited(bytes("crlf-bom.csv"));
    expect(r.bom).toBe(true);
    // The failure this prevents: header[0] === "\uFEFFCompany", which no alias
    // in map-columns matches, so Company shows as Unmapped over a Company column.
    expect(r.rows[0][0]).toBe("Company");
    expect(r.rows[0][0].charCodeAt(0)).not.toBe(0xfeff);
  });

  it("strips a BOM the decoder will not, on the two paths where it matters", () => {
    // TextDecoder("utf-8") removes a BOM by itself, so the assertion above passes
    // whether or not this module does anything \u2014 these two do not.
    //
    // 1. Pasted text never goes through a TextDecoder at all.
    const pasted = readDelimited("\uFEFFCompany,Title\nAcme,PM\n");
    expect(pasted.bom).toBe(true);
    expect(pasted.rows[0][0]).toBe("Company");
    // 2. A BOM in front of a windows-1252 body: the strict UTF-8 decode fails, and
    //    the fallback renders EF BB BF as a visible three-character prefix.
    const mixed = readDelimited(bytes("bom-windows-1252.csv"));
    expect(mixed.bom).toBe(true);
    expect(mixed.encoding).toBe("windows-1252");
    expect(mixed.rows[0][0]).toBe("Company");
    expect(mixed.rows[1][1]).toBe("Tim O\u2019Reilly");
  });

  it("handles CRLF line endings and reports which it found", () => {
    const r = readDelimited(bytes("crlf-bom.csv"));
    expect(r.newline).toBe("\r\n");
    expect(widths(r.rows)).toEqual([4, 4, 4]);
    // A stray \r would ride on the last field of every row.
    expect(r.rows[1][3]).toBe("2026-01-04");
  });

  it("keeps a newline, a comma and an escaped quote inside one quoted cell", () => {
    const r = readDelimited(bytes("quoted-newline.csv"));
    expect(widths(r.rows)).toEqual([3, 3, 3]);
    expect(r.rows[1][0]).toBe("Acme, Inc.");
    expect(r.rows[1][1]).toBe('Call back Tuesday.\nAsked about the "platform" role.');
    expect(r.rows[1][2]).toBe("Screen");
  });

  it("drops trailing blank rows, including a whitespace-only one", () => {
    const r = readDelimited(bytes("blank-trailing.csv"));
    // The file ends with an empty line, a line of three spaces, and two more
    // empty lines. Counted, they become three blank applications.
    expect(r.rows).toHaveLength(3);
    expect(widths(r.rows)).toEqual([3, 3, 3]);
    expect(r.problems).toEqual([]);
  });

  it("reads a pasted string as well as bytes", () => {
    const r = readDelimited("Company\tTitle\nAcme\tPM\n");
    expect(r.delimiter).toBe("\t");
    expect(widths(r.rows)).toEqual([2, 2]);
  });
});

describe("windows-1252", () => {
  it("has a fixture that really is windows-1252, not UTF-8", () => {
    // If this ever stops throwing the fixture was regenerated as UTF-8 and every
    // other assertion in this block proves nothing.
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes("windows-1252.csv"))).toThrow();
  });

  it("round-trips accents that UTF-8 cannot read", () => {
    const r = readDelimited(bytes("windows-1252.csv"));
    expect(r.encoding).toBe("windows-1252");
    expect(widths(r.rows)).toEqual([3, 3, 3, 3]);
    expect(r.rows[1][0]).toBe("Zoë Industries");
    expect(r.rows[1][1]).toBe("Zoë Hart");
    expect(r.rows[2][0]).toBe("Peña Labs");
    expect(r.rows[2][1]).toBe("Ana Peña");
  });

  it("maps 0x92 to a curly apostrophe, which Node's own decoder does not", () => {
    const r = readDelimited(bytes("windows-1252.csv"));
    // Node v24 / ICU 77 decodes 0x92 to U+0092, an invisible C1 control
    // character, while reporting encoding === "windows-1252". Excel autocorrects
    // ' to ’ as you type, so this byte is in half the company names exported
    // from Windows, and the wrong answer is invisible in every UI.
    expect(r.rows[3][0]).toBe("O’Reilly Media");
    expect(r.rows[3][0]).not.toContain("\u0092");
    expect(decodeWindows1252(new Uint8Array([0x92, 0x80, 0x85, 0xeb]))).toBe("’€…ë");
  });

  it("leaves valid UTF-8 alone rather than falling back", () => {
    const r = readDelimited(new TextEncoder().encode("Company,Contact\nZoë Industries,Zoë Hart\n"));
    expect(r.encoding).toBe("utf-8");
    expect(r.rows[1][0]).toBe("Zoë Industries");
  });
});

describe("xlsx", () => {
  it("returns every sheet with its name, and every row at full width", async () => {
    const sheets = await readWorkbook(bytes("wide-60.xlsx"));
    expect(sheets.map((s) => s.name)).toEqual(["Applications"]);
    expect(widths(sheets[0].rows)).toEqual([60, 60, 60]);
    expect(sheets[0].rows[0][0]).toBe("Company");
  });

  it("reads one named sheet on its own", async () => {
    const rows = await readWorkbookSheet(bytes("dates.xlsx"), "Dates");
    expect(rows).toHaveLength(3);
    expect(rows[0][0]).toBe("Real Date Cell");
  });

  it("hands back a real Date for a date cell and a number for a number cell", async () => {
    const [sheet] = await readWorkbook(bytes("dates.xlsx"));
    // The library's published types say `typeof Date` (the constructor). This is
    // what it actually produces, and the coercion below depends on it.
    expect(sheet.rows[1][0]).toBeInstanceOf(Date);
    expect(sheet.rows[1][1]).toBe(45678);
    expect(sheet.rows[1][2]).toBe("2026-03-04");
    expect(sheet.rows[1][3]).toBe("03/04/2026");
  });
});

describe("coerceDate", () => {
  it("reads the four shapes a date arrives in, from a real workbook", async () => {
    const [sheet] = await readWorkbook(bytes("dates.xlsx"));
    const [dateCell, serial, iso, ambiguous] = sheet.rows[1];

    expect(coerceDate(dateCell)).toBe("2026-01-15");
    // 45678 is 2025-01-21 in Excel. Anchor: serial 45658 is 2025-01-01.
    expect(coerceDate(serial)).toBe("2025-01-21");
    expect(coerceDate(iso)).toBe("2026-03-04");
    // The one that must not be answered.
    expect(coerceDate(ambiguous)).toBeNull();
  });

  it("refuses D/M/Y-or-M/D/Y and says why, instead of picking one", () => {
    const r = readDate("03/04/2026");
    expect(r.iso).toBeNull();
    // Both readings named, so the preview can tell the user what to re-export.
    expect(r.reason).toContain("03/04");
    expect(r.reason).toContain("04/03");
    expect(readDate("3/4/26").iso).toBeNull();
    // Refused as a shape, not only when the first number exceeds 12 — half a
    // column read correctly is a column nobody can trust.
    expect(readDate("13/04/2026").iso).toBeNull();
    expect(readDate("04/13/2026").iso).toBeNull();
  });

  it("accepts year-first strings because their order is not in question", () => {
    expect(coerceDate("2026-03-04")).toBe("2026-03-04");
    expect(coerceDate("2026/3/4")).toBe("2026-03-04");
    expect(coerceDate("2026-03-04T09:12:00Z")).toBe("2026-03-04");
    expect(coerceDate("  2026-03-04  ")).toBe("2026-03-04");
  });

  it("rejects a date that parses cleanly and is not a day", () => {
    // `new Date("2026-02-29")` rolls silently to 1 March.
    expect(coerceDate("2026-02-29")).toBeNull();
    expect(readDate("2026-02-29").reason).toContain("not a day that exists");
    expect(coerceDate("2024-02-29")).toBe("2024-02-29"); // 2024 is a leap year
  });

  it("handles Excel serials across the Lotus leap-year hole", () => {
    expect(coerceDate(1)).toBe("1900-01-01");
    expect(coerceDate(59)).toBe("1900-02-28");
    // Serial 60 displays as 1900-02-29 in Excel, a day that never happened.
    expect(coerceDate(60)).toBeNull();
    expect(readDate(60).reason).toContain("1900-02-29");
    expect(coerceDate(61)).toBe("1900-03-01");
    expect(coerceDate(45658)).toBe("2025-01-01");
    // A serial pasted as text is the same number.
    expect(coerceDate("45658")).toBe("2025-01-01");
  });

  it("refuses a bare year, which is the number that looks exactly like a serial", () => {
    // Serial 2026 is 1905-07-18. Importing that is worse than importing nothing.
    expect(coerceDate(2026)).toBeNull();
    expect(readDate(2026).reason).toContain("year");
    expect(coerceDate("2026")).toBeNull();
    expect(coerceDate(0)).toBeNull();
    expect(coerceDate(-5)).toBeNull();
    expect(coerceDate(1e12)).toBeNull();
  });

  it("returns null with a reason for everything it cannot read", () => {
    for (const value of [null, undefined, "", "   ", true, "next Tuesday", "Q3", new Date(NaN)]) {
      expect(coerceDate(value)).toBeNull();
      expect(readDate(value).reason).not.toBe("");
    }
  });

  it("reads a UTC-midnight Date by its UTC parts in every timezone", () => {
    // A spreadsheet date has no time on it and the reader builds it at UTC
    // midnight. Reading local parts off that shifts it a day west of Greenwich —
    // an export that is silently wrong for everyone in the Americas.
    expect(coerceDate(new Date(Date.UTC(2026, 0, 15)))).toBe("2026-01-15");
    // A Date carrying a time came from somewhere with a clock; the day its owner
    // means is their local day.
    const local = new Date(2026, 0, 15, 9, 30);
    expect(coerceDate(local)).toBe("2026-01-15");
  });
});

describe("header sniffing", () => {
  it("takes row 1 when it names every column that has data below it", () => {
    const r = sniffHeaderRow(readDelimited(bytes("semicolon.csv")).rows);
    expect(r.index).toBe(0);
    expect(r.uncertain).toBe(false);
  });

  it("skips a title line that is blank where the data columns are not", () => {
    const rows = readDelimited(bytes("preamble.csv")).rows;
    const r = sniffHeaderRow(rows);
    // "My job tracker 2026,,," sits above the real header. Taking row 1 maps
    // three of four fields onto columns named "".
    expect(r.index).toBe(1);
    expect(rows[r.index]).toEqual(["Company", "Job Title", "Status", "Applied"]);
    expect(r.reason).toContain("blank");
  });

  it("flags a file whose first row is data, so the UI can offer the toggle", () => {
    const rows = readDelimited(bytes("headers-are-data.csv")).rows;
    const r = sniffHeaderRow(rows);
    // There is no header row to find, so the index stays 0 — the honest answer
    // is the flag, not a different guess. Silently accepting row 1 files the
    // first application under a column named "Acme".
    expect(r.index).toBe(0);
    expect(r.uncertain).toBe(true);
    expect(r.reason).toContain("2026-01-04");
  });

  it("walks past several junk rows to the one that names the columns", () => {
    const rows = [
      ["Sheet1", "", "", ""],
      ["", "", "", ""],
      ["Company", "Job Title", "Status", "Applied"],
      ["Acme", "Product Manager", "Applied", "2026-01-04"],
    ];
    const r = sniffHeaderRow(rows);
    expect(r.index).toBe(2);
    expect(r.uncertain).toBe(false);
  });

  it("prefers a later row that reads more like column names", () => {
    // Row 1 has no blank holes, so the only thing wrong with it is that it
    // repeats itself — a merged title spread across four columns. Header rows
    // do not repeat themselves; this is the case the score exists for.
    const rows = [
      ["Applications", "Applications", "Applications", "Applications"],
      ["Company", "Job Title", "Status", "Applied"],
      ["Acme", "Product Manager", "Applied", "2026-01-04"],
    ];
    const r = sniffHeaderRow(rows);
    expect(r.index).toBe(1);
    expect(r.reason).toContain("reads more like column names");
  });

  it("admits it cannot tell from a one-row file", () => {
    const r = sniffHeaderRow([["Company", "Title"]]);
    expect(r.uncertain).toBe(true);
    expect(r.reason).toContain("one row");
  });

  it("does not throw on no rows at all", () => {
    expect(sniffHeaderRow([])).toMatchObject({ index: 0, uncertain: true });
  });
});

describe("format sniffing", () => {
  it("accepts the two formats it can read", () => {
    expect(sniffFormat("dates.xlsx", bytes("dates.xlsx")).kind).toBe("xlsx");
    expect(sniffFormat("semicolon.csv", bytes("semicolon.csv")).kind).toBe("csv");
    expect(sniffFormat("pasted.txt", new TextEncoder().encode("a,b\n1,2\n")).kind).toBe("csv");
  });

  it("names a legacy .xls and says what to do about it", () => {
    const r = sniffFormat("tracker.xls", bytes("fake.xls"));
    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") return;
    expect(r.format).toContain("97-2003");
    expect(r.message).toContain(".xlsx");
  });

  it("tells a password-protected workbook apart from a legacy .xls", () => {
    // Both are OLE2 compound files with identical magic bytes. Only the
    // EncryptedPackage stream name inside distinguishes them, and getting it
    // wrong sends someone to Save As when the real problem is a password.
    const r = sniffFormat("locked.xlsx", bytes("encrypted.xlsx"));
    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") return;
    expect(r.format).toContain("password-protected");
    expect(r.format).not.toContain("97-2003");
    expect(r.message).toContain("password");
  });

  it("names an Apple Numbers file even though it is a zip like .xlsx", () => {
    const r = sniffFormat("tracker.numbers", bytes("fake.numbers"));
    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") return;
    expect(r.format).toContain("Numbers");
    expect(r.message).toContain("Export");
  });

  it("catches the name and the bytes disagreeing, in both directions", () => {
    // A CSV renamed .xlsx: no zip header, so the parser would die inside fflate.
    const renamed = sniffFormat("tracker.xlsx", new TextEncoder().encode("a,b\n1,2\n"));
    expect(renamed.kind).toBe("rejected");
    // A .numbers renamed .xlsx is still Numbers — the entry names say so.
    const disguised = sniffFormat("tracker.xlsx", bytes("fake.numbers"));
    expect(disguised.kind).toBe("rejected");
    if (disguised.kind !== "rejected") return;
    expect(disguised.format).toContain("Numbers");
  });

  it("refuses an empty file and an unsupported type by name", () => {
    expect(sniffFormat("empty.csv", new Uint8Array(0))).toMatchObject({ kind: "rejected" });
    const pdf = sniffFormat("posting.pdf", new TextEncoder().encode("%PDF-1.7\n"));
    expect(pdf.kind).toBe("rejected");
    if (pdf.kind !== "rejected") return;
    expect(pdf.format).toBe("PDF");
  });
});

describe("caps", () => {
  it("passes the cap exactly and refuses one past it", () => {
    expect(tooLarge({ bytes: MAX_UPLOAD_BYTES })).toBeNull();
    expect(tooLarge({ rows: MAX_ROWS })).toBeNull();
    expect(tooLarge({ bytes: MAX_UPLOAD_BYTES + 1 })).toContain("10 MB");
    expect(tooLarge({ rows: MAX_ROWS + 1 })).toContain("5,000");
  });

  it("says what to do, not just that it refused", () => {
    expect(tooLarge({ bytes: 41 * 1024 * 1024 })).toContain("split");
    expect(tooLarge({ rows: 8431 })).toContain("8,431");
  });
});

describe("UTF-16, which reads as success and is mojibake", () => {
  it("refuses a UTF-16LE file by name rather than parsing it into nonsense", () => {
    // What `Save As -> Unicode Text` writes. The strict UTF-8 decode fails on the
    // NUL bytes and the windows-1252 fallback CANNOT fail — every byte is a
    // character there — so without this the file parses "successfully" into one
    // column of `C\0o\0m\0p\0a\0n\0y` with no error anywhere.
    const utf16 = new Uint8Array([
      0xff, 0xfe, ...[..."Company\tTitle\nAcme\tPM\n"].flatMap((c) => [c.charCodeAt(0), 0]),
    ]);
    const before = readDelimited(utf16);
    // The measurement that justifies the refusal: it "works".
    expect(before.rows.length).toBeGreaterThan(0);
    expect(before.rows[0][0]).not.toBe("Company");

    const sniffed = sniffFormat("tracker.txt", utf16);
    expect(sniffed.kind).toBe("rejected");
    if (sniffed.kind === "rejected") {
      expect(sniffed.format).toMatch(/UTF-16/);
      expect(sniffed.message).toMatch(/Unicode Text/);
      // Says what to do, like every other refusal here.
      expect(sniffed.message).toMatch(/CSV UTF-8|\.xlsx/);
    }
  });

  it("refuses big-endian too", () => {
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x43, 0x00, 0x6f]);
    expect(sniffFormat("tracker.csv", be).kind).toBe("rejected");
  });

  it("still accepts a UTF-8 BOM, which is a different two bytes", () => {
    // EF BB BF, not FF FE. A guard that caught this would refuse the ordinary
    // Excel CSV export, which is the file most people actually upload.
    expect(sniffFormat("tracker.csv", bytes("crlf-bom.csv")).kind).toBe("csv");
  });
});

describe("the inflated cap — the one the byte cap cannot be", () => {
  /**
   * A zip's central directory declares each entry's UNCOMPRESSED size, so a bomb
   * can be measured without being opened. The row cap cannot do this job: it
   * counts rows that already exist in memory, which is after the damage.
   */
  it("reads a real workbook's open size from its own central directory", () => {
    const small = declaredInflatedBytes(bytes("clean-40.xlsx"));
    const wide = declaredInflatedBytes(bytes("wide-60.xlsx"));
    const big = declaredInflatedBytes(bytes("big-2000.xlsx"));
    for (const n of [small, wide, big]) {
      expect(n).not.toBeNull();
      expect(n!).toBeGreaterThan(0);
    }
    // Every committed fixture is well inside the cap, so the guard cannot be
    // passing merely because it never fires.
    expect(big!).toBeLessThan(MAX_INFLATED_BYTES);
    // And it is genuinely bigger than the file on disk: that difference is the
    // whole thing being bounded.
    expect(big!).toBeGreaterThan(bytes("big-2000.xlsx").length);
  });

  it("lets every real fixture through and refuses a declared bomb", () => {
    const real = bytes("big-2000.xlsx");
    expect(tooLargeInflated(real)).toBeNull();

    // Rewrite the first entry's declared uncompressed size to 2 GB, in place. The
    // archive is still structurally valid; it now says what it weighs.
    const bomb = Uint8Array.from(real);
    const view = new DataView(bomb.buffer);
    let eocd = -1;
    for (let at = bomb.length - 22; at >= 0; at -= 1) {
      if (view.getUint32(at, true) === 0x06054b50) {
        eocd = at;
        break;
      }
    }
    expect(eocd).toBeGreaterThan(0);
    view.setUint32(view.getUint32(eocd + 16, true) + 24, 2_000_000_000, true);

    const refusal = tooLargeInflated(bomb);
    expect(refusal).toContain("once opened");
    // Says what to do about it, like every other refusal in this module.
    expect(refusal).toMatch(/save a copy/i);
  });

  it("answers null for bytes that are not a zip at all, rather than guessing", () => {
    // The parser's own refusal is the better message for that file, and this
    // guard declines to invent one.
    expect(declaredInflatedBytes(bytes("fake.xls"))).toBeNull();
    expect(tooLargeInflated(new Uint8Array(10))).toBeNull();
  });
});

describe("blankness", () => {
  it("counts a cell of non-breaking space as blank", () => {
    // What pasting from a web page into Excel leaves behind. U+00A0 is not
    // trimmed by Postgres's btrim either, which is why the class is spelled out.
    expect(isBlankCell("\u00A0")).toBe(true);
    expect(isBlankCell("\u200B\u00A0 \t")).toBe(true);
    expect(isBlankCell(null)).toBe(true);
    expect(isBlankCell("")).toBe(true);
    expect(isBlankCell(" Acme ")).toBe(false);
    expect(isBlankCell(0)).toBe(false);
  });

  it("renders a cell for display without inventing a value", () => {
    expect(cellText(null)).toBe("");
    expect(cellText("\u00A0Acme\u200B ")).toBe("Acme");
    expect(cellText(new Date(Date.UTC(2026, 0, 15)))).toBe("2026-01-15");
    expect(cellText(45678)).toBe("45678");
  });
});
