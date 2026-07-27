import "server-only";

import type { MappedImportRow } from "@/lib/data/source";
import { isStrong, jobKey } from "@/lib/import/job-key";
import {
  MAPPABLE_FIELDS,
  suggestMapping,
  unmappedHeaders,
  type Mapping,
  type MappableField,
} from "@/lib/import/map-columns";
import {
  collectStatusValues,
  normalizeStatus,
  suggestStatusMap,
  type StatusMapEntry,
  type StatusValue,
} from "@/lib/import/map-status";
import { cellText, isBlankCell, readDate, sniffHeaderRow, type Cell } from "@/lib/import/read";
import { isCanonicalStatus } from "@/lib/status";
import type { ImportMapping, ImportRowView } from "@/lib/import/views";

/**
 * Everything the wizard's server side derives from STAGED ROWS.
 *
 * The whole file exists because of one decision in §2 of the plan: the upload
 * route parses the bytes into `import_rows` and then throws the bytes away. So
 * every later question — which row holds the column names, what three values sit
 * under this header, which status words appear and how often, what does this
 * mapping mean for row 37 — has to be answerable from the staged rows alone.
 * That is what makes a reload mid-mapping render the same screen instead of
 * sending somebody back to the file picker.
 *
 * Both the page and the mapping action call in here, and that is the point: the
 * screen shows the samples this file computed and the action maps with the same
 * grid and the same header row. A second implementation of "which rows are data"
 * is how the preview describes one thing and the commit writes another.
 *
 * ## `raw` is keyed by COLUMN INDEX, as a string
 *
 * `{"0": "Acme", "1": "Product Manager"}`, blanks omitted. Two reasons, and both
 * are failures rather than preferences:
 *
 *   1. **A header name is not an address.** A sheet with two columns called
 *      "Notes" gives a by-name lookup a coin flip, and the loser is silently not
 *      imported. `ImportMapping.columnMap` is already index-based for exactly
 *      this reason; `raw` has to agree with it.
 *   2. **jsonb does not preserve key order.** Postgres sorts object keys, so
 *      column ORDER cannot be recovered from a name-keyed object — the header row
 *      would come back alphabetised. Numeric keys sort back into place.
 *
 * An omitted key means the file said nothing in that cell, which is the rule
 * `view-models.ts` states for every value in this app: absent, never invented.
 */

/** `headerRowIndex` when the file has no header row at all — every row is data. */
export const NO_HEADER_ROW = -1;

/** How many live values are shown under each target field. */
const SAMPLE_N = 3;

/**
 * Past this many distinct values, a column is not a status column.
 *
 * The status step asks the user to decide about every distinct value, so the
 * list has to be finite to be a question. A column with 900 different values is
 * a notes column somebody pointed at Status by mistake, and rendering 900 selects
 * is not the way to tell them that — the screen says how many it found instead.
 */
const MAX_STATUS_DISTINCT = 50;

/** A rectangular view of the staged rows, in source order. */
export type Grid = {
  cells: Cell[][];
  /** `numbers[i]` is the 1-based SOURCE row number of `cells[i]`. */
  numbers: number[];
  /** Columns, from the widest row. */
  width: number;
};

/**
 * Staged rows → a grid.
 *
 * Blank rows were dropped at upload, so the source numbers have gaps — and they
 * are kept rather than renumbered, because "row 37" in the report has to be the
 * row 37 the person can see in their own file.
 */
export function grid(rows: readonly ImportRowView[]): Grid {
  const ordered = [...rows].sort((a, b) => a.rowNumber - b.rowNumber);
  let width = 0;
  for (const r of ordered) {
    for (const key of Object.keys(r.raw)) {
      const i = Number(key);
      if (Number.isInteger(i) && i >= 0 && i + 1 > width) width = i + 1;
    }
  }
  return {
    cells: ordered.map((r) => {
      const row: Cell[] = new Array(width).fill(null);
      for (const [key, value] of Object.entries(r.raw)) {
        const i = Number(key);
        if (Number.isInteger(i) && i >= 0 && i < width) row[i] = value;
      }
      return row;
    }),
    numbers: ordered.map((r) => r.rowNumber),
    width,
  };
}

export type HeaderGuess = {
  /** 0-based SOURCE position — `rowNumber - 1` — or `NO_HEADER_ROW`. */
  headerRowIndex: number;
  reason: string;
  uncertain: boolean;
};

/**
 * Which staged row holds the column names.
 *
 * Recomputed from the staged rows rather than persisted at upload, so there is
 * one answer and it survives a reload. `sniffHeaderRow` works on the grid's
 * ARRAY index; this converts it to the source row number the rest of the wizard
 * speaks, which are not the same thing the moment a blank row was dropped above
 * the header.
 */
export function headerGuess(g: Grid): HeaderGuess {
  const sniff = sniffHeaderRow(g.cells);
  const number = g.numbers[sniff.index];
  return {
    headerRowIndex: number === undefined ? NO_HEADER_ROW : number - 1,
    reason: sniff.reason,
    uncertain: sniff.uncertain,
  };
}

/** A live value from a column, plus whether it reads as a date. */
export type SampleCell = {
  text: string;
  /**
   * Shown only under the two date fields. `03/04/2026` is 3 April or 4 March and
   * the file does not say which, so it imports as no date at all — and the place
   * to learn that is next to the value, at the moment somebody points a date
   * field at the column, not in a report after 300 rows landed dateless.
   */
  date: boolean;
};

export type StatusColumn = {
  /** How many distinct values the column holds, whether or not they are listed. */
  distinct: number;
  /** The values, folded case- and whitespace-insensitively. Empty when `distinct` is over the cap. */
  values: StatusValue[];
  /** What each one maps to unless the user says otherwise. */
  suggested: Record<string, StatusMapEntry>;
};

export type MapModel = {
  headerRowIndex: number;
  /** In file order. A column with a blank name gets a positional one so it can still be mapped. */
  headers: string[];
  /** `samples[column]` — up to three non-blank values from the data rows. */
  samples: SampleCell[][];
  /** `statusColumns[column]` — every column, because the user may point Status anywhere. */
  statusColumns: StatusColumn[];
  /** Target field → column index, or null for Unmapped. Deterministic (never an LLM). */
  suggestion: Record<string, number | null>;
  /** Rows that would actually be imported under this header choice. */
  dataRows: number;
  /** Rows at or above the header row — never imported, and the screen says so. */
  skippedRows: number;
};

/** Where the data starts, as a grid index. `-1` when every row is data. */
function headerPositionIn(g: Grid, headerRowIndex: number): number {
  if (headerRowIndex === NO_HEADER_ROW) return -1;
  return g.numbers.indexOf(headerRowIndex + 1);
}

function headersFor(g: Grid, headerPos: number): string[] {
  return Array.from({ length: g.width }, (_, c) => {
    const named = headerPos >= 0 ? cellText(g.cells[headerPos]?.[c] ?? null) : "";
    // A positional name rather than "", so a column whose header cell is empty is
    // still something the user can point a field at. Unmapped, it is reported by
    // that name too, which is more use than a blank line in the report.
    return named || `Column ${c + 1}`;
  });
}

/**
 * The column names for one header-row choice.
 *
 * Split out so the mapping ACTION can have them without paying for the samples
 * and the per-column status vocabulary the SCREEN needs — on a 2,000-row file
 * that is the difference between a fast gesture and a slow one.
 */
export function headersOf(rows: readonly ImportRowView[], headerRowIndex: number): string[] {
  const g = grid(rows);
  return headersFor(g, headerPositionIn(g, headerRowIndex));
}

/**
 * Everything the mapping screen renders, for ONE header-row choice.
 *
 * Called twice by the page — once for the guess and once for "the first row is
 * data" — so the toggle answers instantly instead of costing a round trip. Both
 * models are the server's, so neither is a client-side guess about what the file
 * says.
 */
export function mapModel(rows: readonly ImportRowView[], headerRowIndex: number): MapModel {
  const g = grid(rows);
  const headerPos = headerPositionIn(g, headerRowIndex);
  const headers = headersFor(g, headerPos);
  const data = g.cells.slice(headerPos + 1);

  const samples: SampleCell[][] = [];
  const statusColumns: StatusColumn[] = [];
  for (let c = 0; c < g.width; c += 1) {
    const bucket: SampleCell[] = [];
    for (const row of data) {
      if (bucket.length >= SAMPLE_N) break;
      const text = cellText(row[c] ?? null);
      // Blanks are skipped rather than shown: three empty samples say nothing,
      // and the first rows of a real export are often the emptiest.
      if (text === "") continue;
      bucket.push({ text, date: readDate(text).iso !== null });
    }
    samples.push(bucket);

    const values = collectStatusValues(data, c);
    statusColumns.push(
      values.length > MAX_STATUS_DISTINCT
        ? { distinct: values.length, values: [], suggested: {} }
        : { distinct: values.length, values, suggested: suggestStatusMap(values) },
    );
  }

  const suggested = suggestMapping(headers);
  const suggestion: Record<string, number | null> = {};
  for (const field of MAPPABLE_FIELDS) suggestion[field] = suggested[field]?.index ?? null;

  return {
    headerRowIndex,
    headers,
    samples,
    statusColumns,
    suggestion,
    dataRows: data.length,
    skippedRows: headerPos + 1,
  };
}

/**
 * A `Mapping` shaped from the user's choices, for the two functions in
 * `map-columns.ts` that answer questions about one.
 *
 * A projection, never stored and never shown: `confidence` and `source` describe
 * a machine's guess, and these columns were picked by a person. Neither
 * `unmappedHeaders` nor `isRoundTrip` reads either field — going through them
 * rather than re-deriving "which indices are taken" is what keeps one answer to
 * that question.
 */
function asMapping(headers: readonly string[], columnMap: Record<string, number>): Mapping {
  const mapping = {} as Mapping;
  for (const field of MAPPABLE_FIELDS) {
    const index = columnMap[field];
    mapping[field] =
      index === undefined || index < 0 || index >= headers.length
        ? null
        : { header: headers[index], index, confidence: 1, source: "alias" };
  }
  return mapping;
}

/**
 * The headers that went nowhere, split into the two things "nowhere" can mean.
 *
 * `unmapped` is a column this app HAS a field for and the user did not point at
 * it — a second "Notes" column, a "Location" left alone. `unknown-column` is a
 * header this app has no field for at all: somebody's "Recruiter" column.
 *
 * The difference is decided by running the suggester on that one header, which is
 * the same deterministic function that pre-filled the screen. Deciding it from
 * whether the header appears in the FULL suggestion would misfile every duplicate
 * — the second "Notes" loses to the first and would be reported as a column this
 * app has never heard of.
 */
export function unmappedFor(
  headers: readonly string[],
  columnMap: Record<string, number>,
): ImportMapping["unmapped"] {
  return unmappedHeaders(headers, asMapping(headers, columnMap)).map((name) => {
    const alone = suggestMapping([name]);
    const known = MAPPABLE_FIELDS.some((f) => alone[f] !== null);
    return { name, disposition: known ? ("unmapped" as const) : ("unknown-column" as const) };
  });
}

export type MappedRows = {
  /** Every staged row, because a row that never got a mapping blocks the batch. */
  rows: MappedImportRow[];
  /** Row numbers at or above the header row: mapped to nothing, and excluded. */
  excluded: number[];
};

/**
 * Apply a mapping to every staged row.
 *
 * Server-side, and the key is computed HERE from the mapped company/title/url/
 * location — nothing else in this app computes one. `lib/import/job-key.ts` is
 * pinned against `core/jobkeys.py` through one golden corpus; a third
 * implementation (or a client-side one the user could edit) would need its own,
 * and a key that differs by a character makes every re-import a silent duplicate.
 *
 * The header row and anything above it get `mapped: {}` AND come back in
 * `excluded`. Both halves are needed: an empty mapping means no cell of a title
 * line is ever read as a company, and the exclusion is what keeps it from
 * committing as an application called "Company".
 */
export function mapRows(
  rows: readonly ImportRowView[],
  headerRowIndex: number,
  columnMap: Record<string, number>,
  statusMap: Record<string, string>,
): MappedRows {
  const g = grid(rows);
  const headerPos = headerPositionIn(g, headerRowIndex);

  // Normalised on the way in, so a decision the user made about "Applied " also
  // covers "applied" and "APPLIED" — `collectStatusValues` folded those into one
  // question, and the answer has to fold back the same way.
  const chosen = new Map<string, string>();
  for (const [word, status] of Object.entries(statusMap)) {
    if (isCanonicalStatus(status)) chosen.set(normalizeStatus(word), status);
  }

  const out: MappedImportRow[] = [];
  const excluded: number[] = [];

  for (let i = 0; i < g.cells.length; i += 1) {
    const rowNumber = g.numbers[i];
    if (i <= headerPos) {
      excluded.push(rowNumber);
      out.push({ rowNumber, mapped: {}, jobKey: "", keyStrength: "none" });
      continue;
    }

    const cells = g.cells[i];
    const at = (field: MappableField | string): string => {
      const c = columnMap[field];
      return c === undefined ? "" : cellText(cells[c] ?? null);
    };
    const date = (field: string): string => {
      const text = at(field);
      // `null` rather than a guess, and therefore "" rather than a wrong date.
      return text === "" ? "" : (readDate(text).iso ?? "");
    };

    const company = at("company");
    const title = at("title");
    const url = at("url");
    const location = at("location");

    let status = "";
    let statusNote: string | null = null;
    const rawStatus = at("status");
    if (rawStatus !== "") {
      const picked = chosen.get(normalizeStatus(rawStatus));
      if (picked) {
        status = picked;
      } else {
        // The closed vocabulary, and the word the file used kept verbatim in the
        // notes. A spreadsheet cell may not mint a status: `statusRank` ranks an
        // invented one above everything and no bot may touch a row carrying one,
        // so 300 rows of somebody's "Stage" column would freeze 300 rows against
        // the engine that is supposed to be tracking them (matrix row 43).
        const fallback = suggestStatusMap([rawStatus])[rawStatus];
        status = fallback.status;
        statusNote = fallback.note;
      }
    }

    const notes = [at("notes"), statusNote].filter((s): s is string => Boolean(s)).join("\n");

    const mapped: Record<string, string> = {};
    const put = (key: string, value: string) => {
      if (value !== "") mapped[key] = value;
    };
    put("company", company);
    put("title", title);
    put("url", url);
    put("location", location);
    put("status", status);
    put("notes", notes);
    put("nextAction", at("nextAction"));
    put("nextActionDate", date("nextActionDate"));
    put("appliedDate", date("appliedDate"));
    put("hqId", at("hqId"));
    put("hqVersion", at("hqVersion"));

    const key = jobKey({ url, company, title, location });
    out.push({
      rowNumber,
      mapped,
      jobKey: key,
      keyStrength: key === "" ? "none" : isStrong(key) ? "strong" : "weak",
    });
  }

  return { rows: out, excluded };
}

/**
 * One row as the preview renders it.
 *
 * Deliberately NOT `ImportRowView`: that carries `raw`, and shipping every source
 * cell of a 2,000-row file to the browser to render a list of companies is the
 * kind of payload that makes a page feel broken on a phone. The preview shows
 * what committing would do; `raw` is kept forever server-side for the question
 * "what did the file actually say", which is not this screen's question.
 */
export type PreviewRow = {
  rowNumber: number;
  company: string;
  title: string;
  status: string;
  matchKind: ImportRowView["matchKind"];
  matchedApplicationId: number | null;
  keyStrength: ImportRowView["keyStrength"];
  conflictState: ImportRowView["conflictState"];
  conflict: ImportRowView["conflict"];
  choices: ImportRowView["choices"];
  included: boolean;
  notice: string;
  outcome: ImportRowView["outcome"];
  error: string;
};

/**
 * The data rows, for the preview.
 *
 * Rows at or above the header row are left out entirely rather than rendered with
 * their Skip toggle already off: a per-row toggle on a title line invites
 * somebody to switch it back on, and the row it would import is a row of column
 * names. The count is stated instead.
 */
export function previewRows(
  rows: readonly ImportRowView[],
  headerRowIndex: number,
): { rows: PreviewRow[]; skipped: number } {
  const dataFrom = headerRowIndex === NO_HEADER_ROW ? 0 : headerRowIndex + 1;
  const data = rows.filter((r) => r.rowNumber > dataFrom);
  return {
    rows: data
      .map((r) => ({
        rowNumber: r.rowNumber,
        company: r.mapped.company ?? "",
        title: r.mapped.title ?? "",
        status: r.mapped.status ?? "",
        matchKind: r.matchKind,
        matchedApplicationId: r.matchedApplicationId,
        keyStrength: r.keyStrength,
        conflictState: r.conflictState,
        conflict: r.conflict,
        choices: r.choices,
        included: r.included,
        notice: r.notice,
        outcome: r.outcome,
        error: r.error,
      }))
      .sort((a, b) => a.rowNumber - b.rowNumber),
    skipped: rows.length - data.length,
  };
}

/** Is anything in this grid worth importing? Used by the upload route's refusals. */
export function hasContent(cells: readonly Cell[][]): boolean {
  return cells.some((row) => row.some((cell) => !isBlankCell(cell)));
}
