import writeXlsxFile, { getSheetData } from "write-excel-file/node";
import type { Column } from "./columns";

/**
 * XLSX generation — the format the spec calls Dad's primary path.
 *
 * Three properties separate a spreadsheet someone can work in from a data dump
 * with an .xlsx extension, and all three are asserted in tests/unit/xlsx.test.ts
 * by unzipping the result rather than by trusting the call site:
 *
 *   1. **The header row is frozen.** Scrolling to row 300 without it means
 *      guessing which column is which.
 *   2. **An autofilter covers the used range.** This is how a non-technical
 *      user slices a sheet — it is the entire reason to prefer XLSX over CSV.
 *   3. **Dates are real dates and numbers are real numbers.** A date stored as
 *      text is invisible to Excel's date filters, and a number stored as text
 *      sorts 100 before 20. Both look completely fine on screen, which is what
 *      makes them worth a test.
 *
 * `write-excel-file` is used rather than `xlsx`/SheetJS: the npm-published
 * SheetJS is frozen at 0.18.5 (2022) carrying CVE-2023-30533.
 */

const DATE_FORMAT = "yyyy-mm-dd";

/** 0-based column index to a spreadsheet column letter (A, B, ... Z, AA, AB). */
export function columnLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * ISO `YYYY-MM-DD` to a UTC-midnight Date.
 *
 * UTC deliberately: the library converts with `getTime()`, so a Date built in a
 * timezone behind UTC would land on the previous day in the file. An export
 * that shifts every date by one day west of Greenwich is the kind of bug that
 * survives review because it is invisible to whoever wrote it.
 */
function isoToUtcDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Excel's `<autoFilter>` is not an option in write-excel-file 4.1.1, but the
 * library exposes a documented feature hook and its element-ordering table
 * already knows where `autoFilter` belongs — so this inserts the element and
 * the library moves it after `</sheetData>`, where the schema requires it.
 * Out of order, Excel declares the file corrupt and offers to repair it, so
 * the position is asserted in the tests rather than assumed.
 */
function autoFilterFeature(ref: string) {
  return {
    files: {
      transform: {
        "xl/worksheets/sheet{id}.xml": {
          insert: () => `<autoFilter ref="${ref}"/>`,
        },
      },
    },
  };
}

/** Readable widths without a layout engine: header vs. the longest value, capped. */
function widthFor<T>(col: Column<T>, rows: T[]): number {
  let longest = col.header.length;
  for (const row of rows) {
    const v = col.value(row);
    if (v === null || v === undefined) continue;
    const len = String(v).length;
    if (len > longest) longest = len;
  }
  // Capped at 60: one 300-character cell must not push every other column
  // off the screen. Excel wraps the overflow, which is the better failure.
  return Math.min(Math.max(longest + 2, 10), 60);
}

export type XlsxOptions = {
  /** Tab name. Excel forbids : \ / ? * [ ] and caps it at 31 characters. */
  sheetName: string;
};

export async function buildXlsx<T>(
  rows: T[],
  columns: Column<T>[],
  opts: XlsxOptions,
): Promise<Buffer> {
  const spec = columns.map((col) => ({
    header: { value: col.header, fontWeight: "bold" as const },
    width: widthFor(col, rows),
    cell: (row: T) => {
      const v = col.value(row);
      // An unstated value is a blank cell — never "null", never 0, never "".
      // Absence is information; inventing a value destroys it.
      if (v === null || v === undefined || v === "") return null;

      if (col.type === "number") {
        const n = typeof v === "number" ? v : Number(v);
        return Number.isFinite(n) ? { type: Number, value: n } : { type: String, value: String(v) };
      }

      if (col.type === "date") {
        const d = isoToUtcDate(String(v));
        // A date that will not parse is written as the text it was, rather
        // than dropped: a visible odd value beats a silently empty cell.
        return d
          ? { type: Date, value: d, format: DATE_FORMAT }
          : { type: String, value: String(v) };
      }

      return { type: String, value: String(v) };
    },
  }));

  const lastCol = columnLetter(Math.max(columns.length - 1, 0));
  // Header row included, so a zero-row export still yields the valid range
  // A1:P1 rather than A1:P0, which Excel rejects.
  const ref = `A1:${lastCol}${rows.length + 1}`;

  // Sheet-data mode rather than objects mode, and deliberately so.
  //
  // Passing objects directly means the library has to guess whether an array is
  // a list of records or already-shaped sheet data — and for an EMPTY array it
  // guesses "sheet data", drops the header row, and emits a completely blank
  // sheet. Exporting a view with no rows is not an error; getting back a file
  // with no column names is indistinguishable from a corrupt download.
  // Resolving the shape here makes zero rows behave exactly like N rows.
  const data = getSheetData(rows, spec as never);

  const file = writeXlsxFile(
    data,
    {
      columns: spec.map((c) => ({ width: c.width })),
      sheet: opts.sheetName.slice(0, 31),
      stickyRowsCount: 1,
    },
    { features: [autoFilterFeature(ref) as never] },
  );

  return file.toBuffer();
}
