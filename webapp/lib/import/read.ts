import "server-only";

import Papa from "papaparse";
import readXlsxFile, { readSheet } from "read-excel-file/node";
import { decodeBytes, type Encoding } from "./bytes";

/**
 * The byte-level half — caps, encoding, format sniffing — lives in
 * `./bytes.ts`, which is deliberately NOT server-only: the companies add flow
 * runs it in the browser, next to the paste parser it has always run there.
 * Re-exported here so this module remains the wizard's one import.
 */
export {
  decodeBytes,
  decodeWindows1252,
  MAX_ROWS,
  MAX_UPLOAD_BYTES,
  sniffFormat,
  tooLarge,
  type DecodedText,
  type Encoding,
  type SniffedFormat,
} from "./bytes";

/**
 * Turning an uploaded file into rows — the stage where an import quietly goes
 * wrong and nobody finds out for a month.
 *
 * Everything here is written against the four ways that happens:
 *
 *   1. **The dialect.** A `;`-delimited export from European Excel, a CRLF file
 *      with a UTF-8 BOM welded onto the first header cell, a note containing a
 *      newline inside quotes. Each of them parses into something — just not the
 *      thing on screen.
 *   2. **The encoding.** windows-1252 is still what Excel-for-Windows writes,
 *      and decoding it as UTF-8 either throws or produces `ZoÃ«`. So the UTF-8
 *      decode is STRICT and the fallback is explicit, and which one ran is
 *      reported so the UI can say so.
 *   3. **The dates.** The same column arrives as a JS `Date`, as `45678`, as
 *      `2026-03-04`, and as `03/04/2026`. The last one has no answer, and every
 *      date library on npm will give you one anyway.
 *   4. **The format.** `.xls`, `.numbers`, and a password-protected workbook all
 *      fail inside the parser with something unreadable. They are caught by
 *      their magic bytes first and refused by name.
 *
 * Server-only on purpose (§2 of docs/plans/PHASE-IMPORT.md): the browser never
 * parses the file. Parsing once, on the server, into Postgres is what makes a
 * half-finished import resumable instead of lost with the tab.
 */

/** A parsed cell. `null` means the file said nothing there — never `""`, never 0. */
export type Cell = string | number | boolean | Date | null;
export type SheetRows = Cell[][];
export type WorkbookSheet = { name: string; rows: SheetRows };

// --------------------------------------------------------------- blankness

/**
 * The whitespace and zero-width classes, spelled out rather than left to `\s`.
 *
 * Same reason `lib/data/view-models.ts` spells out `blankTrim`: "blank" has to
 * mean one thing everywhere, and `\s` means different things in JS, in Postgres
 * (`btrim` trims spaces ONLY), and in whatever wrote the file. A cell holding
 * one non-breaking space — what pasting from a web page into Excel leaves — is
 * blank to a human, and every check here has to agree with that.
 */
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF]/g;
const SPACE_CLASS = " \\t\\n\\r\\v\\f\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
const EDGE_SPACE = new RegExp(`^[${SPACE_CLASS}]+|[${SPACE_CLASS}]+$`, "g");

/** A cell as text, trimmed the way the rest of the app trims. Dates become ISO. */
export function cellText(cell: Cell): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return coerceDate(cell) ?? "";
  return String(cell).replace(ZERO_WIDTH, "").replace(EDGE_SPACE, "");
}

export function isBlankCell(cell: Cell): boolean {
  return cellText(cell) === "";
}

// ------------------------------------------------------------------- xlsx

/**
 * How much a workbook may weigh once it is OPEN.
 *
 * The 10 MB wire cap is a bound on the bytes; it is not a bound on the work,
 * because a zip is a compression format. A sheet of a million near-identical
 * rows is a few MB compressed and hundreds of MB of XML inflated, and the row
 * cap cannot help — it is checked over the parsed rows, which is to say after
 * the memory has already been spent. That was true while the route's own comment
 * said the caps were enforced "before parsing".
 *
 * 64 MB is comfortably past a 5,000-row, 60-column workbook (`wide-60.xlsx`
 * inflates to well under 1 MB) and far short of what puts a serverless function
 * on the floor.
 */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

/**
 * What the zip says it will weigh, read from the central directory.
 *
 * Every entry's UNCOMPRESSED size is a field in its central-directory header, so
 * this is a header read rather than an inflate — which is the whole point. A
 * hostile file could understate it, but then the sizes and CRCs it declares do
 * not match what it contains and the unzipper refuses on its own; the honest
 * bomb declares its real size, because that is how it stays a valid zip.
 *
 * `null` when the structure cannot be read at all. The caller treats that as
 * "let the parser answer", not as "safe": a file with no readable central
 * directory is one `readWorkbook` is about to reject by name anyway.
 */
export function declaredInflatedBytes(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The End Of Central Directory record is last, after a comment of up to 64 KB.
  const EOCD = 0x06054b50;
  let eocd = -1;
  const floor = Math.max(0, bytes.length - (0xffff + 22));
  for (let at = bytes.length - 22; at >= floor; at -= 1) {
    if (view.getUint32(at, true) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return null;

  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  // Zip64 puts 0xffffffff here and the real offset in a separate record. Not
  // decoded: a >4 GB archive is far past the wire cap, so this is unreachable
  // rather than unhandled.
  if (at === 0xffffffff) return null;

  const CENTRAL = 0x02014b50;
  let total = 0;
  for (let i = 0; i < entries; i += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL) return null;
    total += view.getUint32(at + 24, true);
    at +=
      46 +
      view.getUint16(at + 28, true) + // file name
      view.getUint16(at + 30, true) + // extra field
      view.getUint16(at + 32, true); // comment
  }
  return total;
}

/**
 * The refusal message for a workbook that is small on the wire and enormous
 * open, or `null`. Same shape as `tooLarge` and for the same reason: the caller
 * is an HTTP handler that has to turn this into a sentence.
 */
export function tooLargeInflated(bytes: Uint8Array): string | null {
  const inflated = declaredInflatedBytes(bytes);
  if (inflated === null || inflated <= MAX_INFLATED_BYTES) return null;
  const mb = (inflated / (1024 * 1024)).toFixed(0);
  const cap = MAX_INFLATED_BYTES / (1024 * 1024);
  return (
    `That workbook is small as a file but holds ${mb} MB of data once opened, and the limit is ` +
    `${cap} MB. Delete the sheets and rows you do not need, save a copy, and upload that.`
  );
}

function toBuffer(bytes: Uint8Array | ArrayBuffer): Buffer {
  return bytes instanceof ArrayBuffer ? Buffer.from(bytes) : Buffer.from(bytes);
}

/**
 * read-excel-file declares its cell type as `string | number | boolean |
 * typeof Date` — `typeof Date` is the Date *constructor*, not a `Date`, so the
 * published types describe a value the library never produces. Verified against
 * a real workbook: date cells come back as `Date` instances at UTC midnight.
 * The cast is confined to this one function so nothing downstream inherits the
 * library's mistake.
 */
function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value as Cell;
  return String(value);
}

/**
 * Every sheet in the workbook, in one pass.
 *
 * The default export returns `[{sheet, data}]` — ALL sheets — which is not what
 * the v5 examples all over the internet show, and is why this wrapper exists at
 * all. It also means the sheet names for the chooser are free; reading them any
 * other way would parse the zip twice.
 */
export async function readWorkbook(bytes: Uint8Array | ArrayBuffer): Promise<WorkbookSheet[]> {
  const sheets = await readXlsxFile(toBuffer(bytes));
  return sheets.map((s) => ({
    name: s.sheet,
    rows: s.data.map((row) => row.map(toCell)),
  }));
}

/**
 * One named (or 1-based indexed) sheet — the re-read after the user picks one.
 *
 * `readSheet` rather than filtering `readWorkbook`, so picking sheet 3 of a
 * ten-sheet workbook does not carry the other nine through memory.
 */
export async function readWorkbookSheet(
  bytes: Uint8Array | ArrayBuffer,
  sheet: string | number,
): Promise<SheetRows> {
  const data = await readSheet(toBuffer(bytes), sheet);
  return data.map((row) => row.map(toCell));
}

// -------------------------------------------------------------- delimited

export type DelimitedResult = {
  rows: string[][];
  /** Which decode produced these rows. The UI says so — a silent fallback is a guess. */
  encoding: Encoding;
  /** What papaparse auto-detected. `;` here is the whole reason auto-detect is on. */
  delimiter: string;
  newline: string;
  /** A UTF-8 BOM was present and stripped, so it is not welded to header 1. */
  bom: boolean;
  /** Papaparse's own complaints, flattened. Empty is the normal case. */
  problems: string[];
};

/**
 * CSV / TSV / pasted text to rows, with the encoding decided rather than assumed.
 *
 * The decode itself — BOM strip, strict UTF-8, windows-1252 fallback — is
 * `decodeBytes` in `./bytes.ts`; the notes on why the order is load-bearing
 * live there.
 *
 * `delimiter: ""` is papaparse's auto-detect. Not an empty delimiter: papaparse
 * treats any falsy value as "guess", and guessing is right here because the
 * `;` an Italian copy of Excel writes is invisible to whoever exported it.
 */
export function readDelimited(input: Uint8Array | ArrayBuffer | string): DelimitedResult {
  let text: string;
  let encoding: Encoding = "utf-8";
  let bom = false;

  if (typeof input === "string") {
    // Papaparse strips a leading BOM itself, so this slice is not what keeps the
    // header clean on the paste path — detecting it is, because `bom` is reported
    // and the UI says which encoding it read. Stripped anyway so `text` and the
    // flag agree for anything else that ever consumes them.
    bom = input.charCodeAt(0) === 0xfeff;
    text = bom ? input.slice(1) : input;
  } else {
    ({ text, encoding, bom } = decodeBytes(input));
  }

  const parsed = Papa.parse<string[]>(text, {
    delimiter: "",
    skipEmptyLines: "greedy",
  });

  return {
    rows: parsed.data,
    encoding,
    delimiter: parsed.meta.delimiter,
    newline: parsed.meta.linebreak,
    bom,
    problems: parsed.errors.map((e) =>
      e.row === undefined ? e.message : `row ${e.row + 1}: ${e.message}`,
    ),
  };
}

// ----------------------------------------------------------------- dates

export type DateForm = "date-cell" | "iso-string" | "excel-serial" | "unreadable";

export type DateReading = {
  /** `YYYY-MM-DD`, or `null` when the file did not say a date we can prove. */
  iso: string | null;
  form: DateForm;
  /** Why. Shown in the preview next to the row — a null date with no reason is a shrug. */
  reason: string;
};

/** Excel's day-zero for serials past the Lotus hole: 1899-12-30. */
const SERIAL_EPOCH_AFTER_HOLE = Date.UTC(1899, 11, 30);
/** Day-zero for serials 1..59, which Excel numbers one day later. */
const SERIAL_EPOCH_BEFORE_HOLE = Date.UTC(1899, 11, 31);
/** Serial 2958465 is 9999-12-31, Excel's last day. */
const MAX_SERIAL = 2958465;

function isoFromUtcMillis(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Does `YYYY-MM-DD` name a day that exists? `2026-02-29` does not. */
function isRealCalendarDay(y: number, m: number, d: number): boolean {
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

function readSerial(n: number): DateReading {
  if (!Number.isFinite(n)) {
    return { iso: null, form: "unreadable", reason: "not a finite number" };
  }
  const serial = Math.floor(n);
  if (serial < 1 || serial > MAX_SERIAL) {
    return {
      iso: null,
      form: "unreadable",
      reason: `${n} is outside Excel's date range (1 = 1900-01-01, ${MAX_SERIAL} = 9999-12-31)`,
    };
  }
  // A bare year is the one number that looks exactly like a serial and never is.
  // Serial 2026 is 1905-07-18, and importing that is worse than importing nothing.
  if (serial >= 1900 && serial <= 2200 && serial === n) {
    return {
      iso: null,
      form: "unreadable",
      reason: `${serial} reads as a year, not an Excel date serial — say which by writing a full date`,
    };
  }
  if (serial === 60) {
    // Lotus 1-2-3 thought 1900 was a leap year and Excel copied the bug for
    // compatibility. Serial 60 displays as 1900-02-29, a day that did not exist.
    return {
      iso: null,
      form: "unreadable",
      reason: "Excel serial 60 is 1900-02-29, a date that never happened (the Lotus leap-year bug)",
    };
  }
  const epoch = serial < 60 ? SERIAL_EPOCH_BEFORE_HOLE : SERIAL_EPOCH_AFTER_HOLE;
  return {
    iso: isoFromUtcMillis(epoch + serial * 86_400_000),
    form: "excel-serial",
    reason: `Excel date serial ${serial}`,
  };
}

const ISO_LIKE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/;
const ALL_DIGITS = /^\d+(?:\.\d+)?$/;

/**
 * A date in whichever of its four disguises it arrived in.
 *
 * The refusals matter more than the successes:
 *
 * - `03/04/2026` is 3 April in most of the world and 4 March in the US. The file
 *   does not say which, the person who exported it does not remember, and the
 *   only honest answer is `null` plus a reason the preview can show. Guessing
 *   puts a date a month out into a column nobody re-reads.
 * - `2026-02-29` parses cleanly and is not a day. `new Date()` silently rolls it
 *   to 1 March.
 * - `2026` on its own is a year somebody typed, not serial 2026 (1905-07-18).
 */
export function readDate(value: unknown): DateReading {
  if (value === null || value === undefined) {
    return { iso: null, form: "unreadable", reason: "empty" };
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return { iso: null, form: "unreadable", reason: "an Invalid Date" };
    }
    // A spreadsheet date has no time on it, and the xlsx reader builds it at UTC
    // midnight (verified against a real workbook). A Date carrying a time came
    // from somewhere with a clock, and the day its owner means is their local
    // day — reading UTC parts off that one shifts it west of Greenwich.
    const atUtcMidnight =
      value.getUTCHours() === 0 &&
      value.getUTCMinutes() === 0 &&
      value.getUTCSeconds() === 0 &&
      value.getUTCMilliseconds() === 0;
    const [y, m, d] = atUtcMidnight
      ? [value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()]
      : [value.getFullYear(), value.getMonth() + 1, value.getDate()];
    const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return { iso, form: "date-cell", reason: "a real date cell" };
  }

  if (typeof value === "number") return readSerial(value);

  if (typeof value !== "string") {
    return { iso: null, form: "unreadable", reason: `a ${typeof value}, not a date` };
  }

  const text = value.replace(ZERO_WIDTH, "").replace(EDGE_SPACE, "");
  if (text === "") return { iso: null, form: "unreadable", reason: "empty" };

  const iso = ISO_LIKE.exec(text);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (!isRealCalendarDay(y, m, d)) {
      return { iso: null, form: "unreadable", reason: `"${text}" is not a day that exists` };
    }
    return {
      iso: `${iso[1]}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      form: "iso-string",
      reason: "year-first, so the order is unambiguous",
    };
  }

  // A serial pasted as text. Same rules, including the bare-year refusal.
  if (ALL_DIGITS.test(text)) return readSerial(Number(text));

  // Anything with a two-or-one-digit leading component is day/month or
  // month/day and the file does not say which. Refuse the whole shape rather
  // than accepting the subset where the first number happens to exceed 12 —
  // half a column imported correctly is a column nobody can trust.
  const slashy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(text);
  if (slashy) {
    return {
      iso: null,
      form: "unreadable",
      reason: `"${text}" is ${slashy[1]}/${slashy[2]} or ${slashy[2]}/${slashy[1]} — the file does not say which. Re-export dates as YYYY-MM-DD.`,
    };
  }

  return { iso: null, form: "unreadable", reason: `"${text}" is not a date this can read` };
}

/** The ISO date, or `null`. Use `readDate` when the caller can show the reason. */
export function coerceDate(value: unknown): string | null {
  return readDate(value).iso;
}

// ---------------------------------------------------------- header sniffing

export type HeaderSniff = {
  /** 0-based index into the rows we were given. */
  index: number;
  /** The evidence, in words. Rendered next to the toggle, never swallowed. */
  reason: string;
  /**
   * The guess is not safe on its own — the caller MUST show "first row is data,
   * not headers" as a live choice rather than a footnote. Set when the chosen
   * row holds values that column names are not made of, or when the file is
   * too small to tell.
   */
  uncertain: boolean;
  /** Header-likeness per candidate row, so the UI can show its working. */
  scores: number[];
};

/** How many rows from the top can plausibly be the header. */
const HEADER_SEARCH_DEPTH = 5;
/** A later row has to beat row 1 by this much to displace it. Ties go to row 1. */
const DISPLACE_MARGIN = 0.05;

function looksNumericOrDate(cell: Cell): boolean {
  if (cell instanceof Date) return true;
  if (typeof cell === "number") return true;
  const text = cellText(cell);
  if (text === "") return false;
  if (ALL_DIGITS.test(text)) return true;
  return readDate(text).iso !== null;
}

/**
 * How much a row reads like a set of column names, 0..1.
 *
 * Four signals, weighted equally because no one of them is reliable alone: a
 * header row is filled in, short, made of words rather than dates or numbers,
 * and does not repeat itself. Data rows fail at least one of those most of the
 * time. The score is only ever used to *compare* rows within one file — never
 * against an absolute threshold, because "0.71 is a header" is not a fact.
 */
function headerLikeness(row: Cell[]): number {
  const cells = row.map(cellText);
  if (cells.length === 0) return 0;
  const filled = cells.filter((c) => c !== "");
  if (filled.length === 0) return 0;

  const fractionFilled = filled.length / cells.length;
  const fractionShort = filled.filter((c) => c.length <= 40).length / filled.length;
  const fractionWords =
    row.filter((c, i) => cells[i] !== "" && !looksNumericOrDate(c)).length / filled.length;
  const distinct = new Set(filled.map((c) => c.toLowerCase())).size / filled.length;

  return (fractionFilled + fractionShort + fractionWords + distinct) / 4;
}

/**
 * Which row holds the column names — with the guess and the evidence, never
 * silently.
 *
 * Row 1 is the header unless one of two things is true, and both are things a
 * person would notice by eye:
 *
 *   - it is blank in columns that have data below it (a title line: "My job
 *     tracker 2026" sitting above the real header), or
 *   - a later row simply reads more like column names.
 *
 * The other half of the job is admitting when there is no header at all. A
 * pasted sheet body has no row of names, and treating its first application as
 * the column names files that job under a column called "Acme" — which nobody
 * finds until they go looking for that row. So a chosen row containing a date
 * or a number comes back `uncertain`, and the toggle is the point of the whole
 * function.
 *
 * WHAT IT STILL GETS WRONG, said out loud: `uncertain` turns on the presence of a
 * date or a number in the chosen row, so a sheet whose first DATA row happens to
 * be all short distinct words — a company, a title, a status and no dates —
 * scores like a header and is promoted with `uncertain: false`, losing that one
 * application. Bounded rather than solved: the mapping screen renders the chosen
 * row's values as the live samples right next to the toggle, so the wrong answer
 * is on screen as itself ("Kestrel Labs" sitting where "Company" belongs) rather
 * than hidden behind a confidence flag. Making the flag right in this case would
 * mean guessing harder, which is the failure the toggle exists to avoid.
 */
export function sniffHeaderRow(rows: readonly Cell[][]): HeaderSniff {
  if (rows.length === 0) {
    return { index: 0, reason: "the file has no rows", uncertain: true, scores: [] };
  }

  const depth = Math.min(HEADER_SEARCH_DEPTH, rows.length);
  const scores = rows.slice(0, depth).map((r) => headerLikeness(r));

  // Columns that carry data somewhere below the top — the ones a header row is
  // obliged to name.
  const width = Math.max(...rows.map((r) => r.length), 0);
  const usedBelow: number[] = [];
  for (let c = 0; c < width; c += 1) {
    if (rows.slice(1).some((r) => !isBlankCell(r[c] ?? null))) usedBelow.push(c);
  }
  const holes = (rowIndex: number) =>
    usedBelow.filter((c) => isBlankCell(rows[rowIndex]?.[c] ?? null));

  let index = 0;
  let reason = "row 1 names every column that has data below it";

  const firstRowHoles = holes(0);
  if (firstRowHoles.length > 0) {
    const replacement = rows
      .slice(1, depth)
      .findIndex((_, i) => holes(i + 1).length === 0 && scores[i + 1] > 0);
    if (replacement !== -1) {
      index = replacement + 1;
      reason = `row 1 is blank in ${firstRowHoles.length} column(s) that have values below it, so it is a title rather than the header; row ${index + 1} names all of them`;
    } else {
      reason = `row 1 is blank in ${firstRowHoles.length} column(s) that have values below it, and no row below it names them either`;
    }
  } else {
    let best = 0;
    for (let i = 1; i < depth; i += 1) {
      if (scores[i] > scores[best] + DISPLACE_MARGIN && holes(i).length === 0) best = i;
    }
    if (best !== 0) {
      index = best;
      reason = `row ${best + 1} reads more like column names than row 1 does (${scores[best].toFixed(2)} vs ${scores[0].toFixed(2)})`;
    }
  }

  const chosen = rows[index] ?? [];
  const dataShaped = chosen.filter((c) => looksNumericOrDate(c));
  let uncertain = false;
  if (dataShaped.length > 0) {
    uncertain = true;
    reason = `row ${index + 1} contains ${dataShaped.length} value(s) that read as dates or numbers (e.g. "${cellText(dataShaped[0])}") — column names rarely are, so this may be data with no header row at all`;
  } else if (rows.length === 1) {
    uncertain = true;
    reason = "the file has one row, so there is nothing below it to tell headers from data";
  }

  return { index, reason, uncertain, scores };
}

