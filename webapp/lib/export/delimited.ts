import type { Column } from "./columns";

/**
 * CSV / TSV generation.
 *
 * Two details decide whether the file opens cleanly, and both are the kind
 * that only show up on someone else's machine:
 *
 *   - **RFC-4180 quoting.** A field is quoted when it contains the delimiter,
 *     a quote, or a newline, and embedded quotes are doubled. Job titles
 *     contain commas constantly ("Product Manager, Payments"), so getting this
 *     wrong silently shifts every later column on exactly those rows.
 *   - **A UTF-8 BOM on CSV.** Without it, Excel on Windows mis-decodes accented
 *     company names. It is deliberately NOT added to clipboard TSV, where it
 *     would paste as a stray leading character.
 */
export const UTF8_BOM = "﻿";

export function escapeField(value: string, delimiter: string): string {
  const needsQuotes =
    value.includes(delimiter) || value.includes('"') || /[\r\n]/.test(value);
  const escaped = value.replace(/"/g, '""');
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
