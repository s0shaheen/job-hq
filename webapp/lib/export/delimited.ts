import type { Column } from "./columns";

/**
 * CSV / TSV generation.
 *
 * Three details decide whether the file opens cleanly AND safely, and all are
 * the kind that only show up on someone else's machine:
 *
 *   - **RFC-4180 quoting.** A field is quoted when it contains the delimiter,
 *     a quote, or a newline, and embedded quotes are doubled. Job titles
 *     contain commas constantly ("Product Manager, Payments"), so getting this
 *     wrong silently shifts every later column on exactly those rows.
 *   - **A UTF-8 BOM on CSV.** Without it, Excel on Windows mis-decodes accented
 *     company names. It is deliberately NOT added to clipboard TSV, where it
 *     would paste as a stray leading character.
 *   - **Formula-lead neutralization.** Excel and Google Sheets execute a cell
 *     whose text begins with = + - @, TAB, or CR. Company names and titles
 *     arrive verbatim from third-party ATS boards, so anyone who can post a
 *     job to a watched board controls that text — "=cmd|' /c calc'!A1" is the
 *     classic DDE payload; =IMPORTXML and =HYPERLINK exfiltrate from Google
 *     Sheets. Quoting is no defense: RFC-4180 quotes are stripped before the
 *     spreadsheet interprets the text.
 */
export const UTF8_BOM = "﻿";

/** A cell whose text begins with one of these is executed as a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Values that merely LOOK dangerous and must survive untouched: a signed
 * numeric literal ("-15" in a numeric column) that Excel should keep reading
 * as a number, and the bare-hyphen placeholder ("-") a comp range uses for
 * "not listed". Neither can carry an expression, so exempting them is safe.
 * The whole value must match — "-2+3" is an expression Excel evaluates, and
 * only its prefix looks numeric, so it is NOT exempt.
 */
const INERT_LEAD = /^[-+]?\d+(\.\d+)?$|^-+$/;

/**
 * Neutralize with Excel's own text marker, the apostrophe (the OWASP
 * recommendation). A tab prefix was rejected: tab is itself in the
 * dangerous set, and in clipboard TSV it forces quoting and bets that the
 * paste parser honours quotes — one that does not splits on the tab and
 * shifts every later column, the exact corruption quoting exists to
 * prevent. The apostrophe is visible when Excel opens the file, which is
 * the honest failure: the human sees exactly the text the board published.
 *
 * Exported on its own for the surfaces that echo a cell back OUTSIDE a
 * generated file — the companies add flow quotes an imported cell in its
 * per-line notices, and a quoted `=IMPORTXML(...)` must already be inert by
 * the time anyone copies it back into a spreadsheet. One regex pair, one
 * exemption, everywhere.
 */
export function neutralizeFormulaLead(value: string): string {
  return FORMULA_LEAD.test(value) && !INERT_LEAD.test(value) ? `'${value}` : value;
}

export function escapeField(value: string, delimiter: string): string {
  const neutralized = neutralizeFormulaLead(value);
  const needsQuotes =
    neutralized.includes(delimiter) ||
    neutralized.includes('"') ||
    /[\r\n]/.test(neutralized);
  const escaped = neutralized.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

function cell<T>(col: Column<T>, row: T): string {
  const v = col.value(row);
  if (v === null || v === undefined) return "";
  return String(v);
}

export function toDelimited<T>(
  rows: T[],
  columns: Column<T>[],
  opts: { delimiter?: string; bom?: boolean } = {},
): string {
  const delimiter = opts.delimiter ?? ",";
  const head = columns.map((c) => escapeField(c.header, delimiter)).join(delimiter);
  const body = rows.map((r) =>
    columns.map((c) => escapeField(cell(c, r), delimiter)).join(delimiter),
  );
  // CRLF is the line ending Excel is least surprised by, on every platform.
  const text = [head, ...body].join("\r\n");
  return (opts.bom ? UTF8_BOM : "") + text;
}

export function toCsv<T>(rows: T[], columns: Column<T>[]): string {
  return toDelimited(rows, columns, { delimiter: ",", bom: true });
}

/** Clipboard payload — pastes straight into Excel and Google Sheets. */
export function toTsv<T>(rows: T[], columns: Column<T>[]): string {
  return toDelimited(rows, columns, { delimiter: "\t", bom: false });
}
