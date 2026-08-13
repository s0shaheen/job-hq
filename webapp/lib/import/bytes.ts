/**
 * The byte-level half of `lib/import/read.ts`: caps, format sniffing, and
 * decoding — everything that inspects an uploaded file WITHOUT parsing it.
 *
 * Split out of `read.ts` because that module is `server-only` on purpose (the
 * applications wizard parses once, on the server, into Postgres — §2 of
 * docs/plans/PHASE-IMPORT.md) and this half has no reason to be: it touches no
 * parser library and no Node API, and the companies add flow needs it in the
 * browser, where its paste parser has always run. `read.ts` re-exports all of
 * it, so the wizard's imports and tests are unchanged — one implementation,
 * two entry points, never a second copy of the magic bytes.
 */

/**
 * Caps, enforced by the route handler before any parsing runs.
 *
 * 10 MB is roughly a 60-column, 20,000-row xlsx — comfortably past any real job
 * tracker and comfortably short of tying up a serverless function on a zip bomb.
 * 5,000 rows is the row cap from matrix row 42; both are exported so the handler
 * and the tests read the same number.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 5000;

/**
 * The refusal message, or `null` when the upload is within the caps.
 *
 * Returned rather than thrown because the caller is an HTTP handler that has to
 * turn this into a 413 with a body a person can act on. "Payload too large" is
 * not a sentence that tells anyone what to do next.
 */
export function tooLarge(size: { bytes?: number; rows?: number }): string | null {
  if (size.bytes !== undefined && size.bytes > MAX_UPLOAD_BYTES) {
    const mb = (size.bytes / (1024 * 1024)).toFixed(1);
    const cap = MAX_UPLOAD_BYTES / (1024 * 1024);
    return `That file is ${mb} MB and the limit is ${cap} MB. Export a narrower date range, or split it in two and import twice.`;
  }
  if (size.rows !== undefined && size.rows > MAX_ROWS) {
    return `That file has ${size.rows.toLocaleString("en-US")} rows and the limit is ${MAX_ROWS.toLocaleString("en-US")}. Split it and import in two passes — both halves land in the same pipeline.`;
  }
  return null;
}

// ---------------------------------------------------------------- decoding

export type Encoding = "utf-8" | "windows-1252";

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/**
 * windows-1252's 0x80-0x9F block, mapped by hand — because Node's own
 * `TextDecoder("windows-1252")` does not.
 *
 * Measured on Node v24.11.1 / ICU 77.1: the decoder reports
 * `encoding === "windows-1252"` and then decodes 0x92 to U+0092, a C1 control
 * character, instead of U+2019 ('). It is ISO-8859-1 wearing the windows-1252
 * label — every alias (`cp1252`, `latin1`, `iso-8859-1`) resolves to the same
 * table. Browsers get this right, which is how it survives unnoticed.
 *
 * That matters more than it sounds. Excel autocorrects `'` to `'` as you type,
 * so a curly apostrophe is in half the company names anyone exports from
 * Windows — `O'Reilly Media` would have imported as `O<U+0092>Reilly Media`:
 * invisible in every UI, unsearchable, and wrong in the database forever.
 *
 * Doing it here also removes the ICU dependency. A Node built with small-icu
 * throws on `new TextDecoder("windows-1252")` outright, which would have turned
 * the fallback path into a 500 on upload.
 */
const CP1252_C1 = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

export function decodeWindows1252(bytes: Uint8Array): string {
  const CHUNK = 8192;
  const parts: string[] = [];
  const codes = new Uint16Array(Math.min(CHUNK, bytes.length) || 1);
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const n = Math.min(CHUNK, bytes.length - start);
    for (let i = 0; i < n; i += 1) {
      const b = bytes[start + i];
      codes[i] = b >= 0x80 && b <= 0x9f ? CP1252_C1[b - 0x80] : b;
    }
    parts.push(String.fromCharCode(...codes.subarray(0, n)));
  }
  return parts.join("");
}

export type DecodedText = {
  text: string;
  /** Which decode produced the text. The UI can say so — a silent fallback is a guess. */
  encoding: Encoding;
  /** A UTF-8 BOM was present and stripped, so it is not welded to the first cell. */
  bom: boolean;
};

/**
 * Bytes to text, with the encoding decided rather than assumed.
 *
 * The decode order is the load-bearing part. `TextDecoder("utf-8")` is lenient
 * by default: it replaces every byte it cannot read with U+FFFD and returns
 * happily, so a windows-1252 file becomes `Zo<?>` and imports without a word.
 * `fatal: true` makes it throw instead, and the throw is the signal to retry as
 * windows-1252 — which never fails, so it can only ever be the fallback.
 * (The fallback is `decodeWindows1252`, not `TextDecoder`; see the note there.)
 *
 * The BOM is stripped from the BYTES, before either decode. `TextDecoder`
 * would drop it for us; the windows-1252 fallback would not, and a file with a
 * BOM and a cp1252 body arrives with a visible three-character prefix welded
 * to the first cell.
 */
export function decodeBytes(input: Uint8Array | ArrayBuffer): DecodedText {
  let bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  const bom = bytes.length >= 3 && UTF8_BOM.every((b, i) => bytes[i] === b);
  if (bom) bytes = bytes.subarray(3);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8", bom };
  } catch {
    // Every byte is a character in windows-1252, so this cannot throw and
    // cannot be reached unless the strict pass already refused the bytes.
    return { text: decodeWindows1252(bytes), encoding: "windows-1252", bom };
  }
}

// -------------------------------------------------------- format sniffing

export type SniffedFormat =
  | { kind: "xlsx"; reason: string }
  | { kind: "csv"; reason: string }
  | { kind: "rejected"; format: string; message: string };

const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const PDF = [0x25, 0x50, 0x44, 0x46];
/** Excel's "Unicode Text (*.txt)" export. Little-endian in practice; both checked. */
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

/** How far into the file the container markers are looked for. */
const MARKER_SCAN_BYTES = 64 * 1024;

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  return bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
}

function contains(bytes: Uint8Array, needle: Uint8Array): boolean {
  const limit = Math.min(bytes.length, MARKER_SCAN_BYTES);
  outer: for (let i = 0; i + needle.length <= limit; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

const ascii = (s: string) => new TextEncoder().encode(s);
/** CFB directory entry names are UTF-16LE, which is why this is not an ASCII scan. */
const utf16le = (s: string) => {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i += 1) out[i * 2] = s.charCodeAt(i) & 0xff;
  return out;
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

/**
 * What this file is, decided from its bytes and its name together — before any
 * parser touches it.
 *
 * Three uploads look like a spreadsheet, are not one, and fail deep inside a
 * library with a message about an unexpected token. Every one of them has a
 * thirty-second fix the person could do themselves, so the whole point is to
 * name the format and say what to do (matrix row 41):
 *
 *   - **.xls** — Excel 97-2003, an OLE2 compound file. Not a zip at all.
 *   - **password-protected .xlsx** — ALSO an OLE2 compound file, because Office
 *     encrypts the whole OOXML package into one. Same magic bytes as .xls; what
 *     tells them apart is the `EncryptedPackage` stream name inside.
 *   - **.numbers** — a zip, so the magic bytes say "xlsx". Its entry names give
 *     it away.
 *
 * Extension alone is not enough (renaming a file changes nothing) and bytes
 * alone are not enough (.numbers and .xlsx are both zips), so both are checked.
 */
export function sniffFormat(filename: string, bytes: Uint8Array): SniffedFormat {
  const ext = extensionOf(filename);

  if (bytes.length === 0) {
    return { kind: "rejected", format: "empty file", message: "That file is empty — nothing to import." };
  }

  if (startsWith(bytes, OLE2)) {
    if (contains(bytes, utf16le("EncryptedPackage")) || contains(bytes, utf16le("EncryptionInfo"))) {
      return {
        kind: "rejected",
        format: "password-protected Excel workbook",
        message:
          "This workbook is password-protected, so nothing can read it without the password. Open it in Excel, File → Info → Protect Workbook → Encrypt with Password, clear the password, save, and upload it again.",
      };
    }
    return {
      kind: "rejected",
      format: "Excel 97-2003 (.xls)",
      message:
        "This is the old Excel 97-2003 format (.xls). Open it in Excel or Google Sheets and Save As .xlsx or .csv, then upload that.",
    };
  }

  if (startsWith(bytes, ZIP)) {
    if (ext === ".numbers" || (contains(bytes, ascii("Index/")) && contains(bytes, ascii(".iwa")))) {
      return {
        kind: "rejected",
        format: "Apple Numbers",
        message:
          "This is an Apple Numbers file. In Numbers, File → Export To → Excel (or CSV), then upload the exported file.",
      };
    }
    if (ext === ".xlsx" || ext === ".xlsm" || contains(bytes, ascii("xl/workbook.xml"))) {
      return { kind: "xlsx", reason: "a zip container holding an Excel workbook" };
    }
    return {
      kind: "rejected",
      format: "an unrecognised zip archive",
      message:
        "This is a zip archive but not a spreadsheet. If it holds one, unzip it first and upload the .xlsx or .csv inside.",
    };
  }

  // UTF-16, which Excel's own "Unicode Text (*.txt)" export writes and which
  // `readDelimited` cannot read: the strict UTF-8 decode fails on the NUL bytes,
  // the windows-1252 fallback CANNOT fail (every byte is a character there), so
  // the file parses "successfully" into one column of `C\0o\0m\0p\0a\0n\0y`.
  // No error anywhere, and a mapping screen full of mojibake is the only clue.
  // Refused by name instead, because the fix is one Save As away.
  if (startsWith(bytes, UTF16LE_BOM) || startsWith(bytes, UTF16BE_BOM)) {
    return {
      kind: "rejected",
      format: "UTF-16 text",
      message:
        "This file is saved as UTF-16 text, which is what Excel's \"Unicode Text\" export writes, and its characters cannot be read as a spreadsheet. Open it and Save As \"CSV UTF-8\" — or .xlsx — and upload that.",
    };
  }

  if (startsWith(bytes, PDF)) {
    return {
      kind: "rejected",
      format: "PDF",
      message: "PDFs cannot be imported — there are no rows in them to read. Upload the .xlsx or .csv the PDF was made from.",
    };
  }

  // Past here the bytes are not any known container, so the name is all there is
  // — and a name that promises a spreadsheet over text that is not one is worth
  // saying out loud rather than handing to a CSV parser and hoping.
  if (ext === ".numbers") {
    return {
      kind: "rejected",
      format: "Apple Numbers",
      message:
        "This is an Apple Numbers file. In Numbers, File → Export To → Excel (or CSV), then upload the exported file.",
    };
  }
  if (ext === ".xls" || ext === ".xlsx" || ext === ".xlsm") {
    return {
      kind: "rejected",
      format: `named ${ext} but not a spreadsheet`,
      message: `This file is named ${ext} but its contents are not an Excel workbook. If it is really a CSV, rename it to .csv and upload it again.`,
    };
  }
  if (ext === "" || ext === ".csv" || ext === ".tsv" || ext === ".tab" || ext === ".txt") {
    return { kind: "csv", reason: `text, read as delimited (${ext || "no extension"})` };
  }
  return {
    kind: "rejected",
    format: `unsupported file type (${ext})`,
    message: `${ext} files cannot be imported. Upload an .xlsx or a .csv.`,
  };
}
