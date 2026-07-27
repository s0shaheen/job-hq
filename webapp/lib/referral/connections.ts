/**
 * Reading LinkedIn's own `Connections.csv` — the map/preview half, pure.
 *
 * WHAT MAKES THIS FILE'S EXPORT DIFFERENT FROM EVERY OTHER IMPORT
 *
 * LinkedIn's export does not start with its header row. The file opens with a
 * literal `Notes:` line and a paragraph of prose about missing email addresses,
 * then a blank line, and only then the real columns. Every naive CSV reader maps
 * `Notes:` as a one-column header and files 3,000 people under it.
 *
 * This app already answers that: `sniffHeaderRow` in `lib/import/read.ts` picks
 * the first row that names every column with data below it, and reports its
 * reasoning in words. So the preamble is handled by the machinery P9 already
 * paid for rather than by a LinkedIn-specific `if` — which matters because
 * LinkedIn has changed that preamble twice and a hardcoded skip-two-lines breaks
 * silently the third time.
 *
 * The date column is the one thing the shared reader legitimately does not know:
 * LinkedIn writes `21 Mar 2023`, a named-month form `readDate` refuses because
 * it refuses everything it cannot prove. It is unambiguous BY CONSTRUCTION (the
 * month is a word, so there is no day/month order to guess wrong), which is
 * exactly the property `readDate` demands — so it is read here rather than by
 * widening the shared reader's contract for one vendor.
 *
 * PURE ON PURPOSE. `lib/import/read.ts` is `server-only` and `map-columns.ts`
 * inherits that; this module operates on already-decoded text and imports
 * neither, so the preview screen and the fixture data source can both use it.
 */
import { companyNameKey } from "@/lib/data/view-models";
import type { ConnectionImportRow } from "@/lib/data/source";
import { suggestFor, unmappedFor, type Suggestion } from "@/lib/import/suggest";

/**
 * The fields a connections import can write.
 *
 * `fullName` first because it is the only required one — the rest are things a
 * row is better with and survives without.
 */
export const CONNECTION_FIELDS = [
  "fullName",
  "firstName",
  "lastName",
  "company",
  "title",
  "profileUrl",
  "connectedOn",
] as const;
export type ConnectionField = (typeof CONNECTION_FIELDS)[number];

/**
 * "Their words" for each field, normalized.
 *
 * LinkedIn's own headers are `First Name`, `Last Name`, `URL`, `Email Address`,
 * `Company`, `Position`, `Connected On` — every one of them is an exact alias
 * here, so a stock export maps with no fuzzy pass at all and no guessing. The
 * extra aliases are for the other two files people actually have: a Google
 * Contacts export and a hand-kept sheet.
 *
 * `Email Address` is deliberately mapped by NOTHING. This app has no use for a
 * connection's email — outreach happens on LinkedIn, by hand, from the user's
 * own account — and a column that lands nowhere shows up in the report as
 * "unmapped", which is the honest description of a field we chose not to store.
 * Storing it "just in case" would put a pile of personal email addresses in a
 * database for a feature nobody has.
 */
export const CONNECTION_ALIASES: Record<ConnectionField, readonly string[]> = {
  fullName: ["full name", "name", "connection", "person", "contact", "contact name"],
  firstName: ["first name", "given name", "firstname", "first"],
  lastName: ["last name", "surname", "family name", "lastname", "last"],
  company: ["company", "company name", "employer", "organisation", "organization", "org"],
  title: ["position", "title", "job title", "role", "headline", "current position"],
  profileUrl: ["url", "profile url", "linkedin url", "link", "profile", "linkedin"],
  connectedOn: ["connected on", "connected", "connection date", "date connected", "since"],
};

export type ConnectionMapping = Record<ConnectionField, Suggestion | null>;

export function suggestConnectionMapping(headers: readonly string[]): ConnectionMapping {
  return suggestFor({ fields: CONNECTION_FIELDS, aliases: CONNECTION_ALIASES }, headers);
}

export function unmappedConnectionHeaders(
  headers: readonly string[],
  mapping: ConnectionMapping,
): string[] {
  return unmappedFor(CONNECTION_FIELDS, headers, mapping);
}

/** The provenance tags `app_import_connections` accepts. Closed at both ends. */
export const CONNECTION_SOURCE_TAGS = ["linkedin-export", "manual", "import"] as const;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * LinkedIn's `Connected On` value as an ISO date, or `null` with a reason.
 *
 * Three shapes are accepted and every one of them is unambiguous:
 *
 *   - `21 Mar 2023` — what LinkedIn writes today.
 *   - `Mar 21, 2023` — what it wrote before, and what a US-locale re-save
 *     produces.
 *   - `2023-03-21` — what somebody who tidied the file in a spreadsheet leaves.
 *
 * Everything else answers null, INCLUDING `03/04/2026`. That is 3 April in most
 * of the world and 4 March in the US, the file does not say which, and this
 * column is decoration on a popover — guessing it wrong is a date nobody
 * re-reads, which is precisely the failure `readDate` was written to refuse.
 */
export function readConnectedOn(value: string): { iso: string | null; reason: string } {
  const text = (value ?? "").trim();
  if (text === "") return { iso: null, reason: "empty" };

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    return finishDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), "year-first, unambiguous");
  }

  // "21 Mar 2023"
  const dmy = /^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/.exec(text);
  if (dmy) {
    const month = MONTHS[dmy[2].slice(0, 3).toLowerCase()];
    if (month) {
      return finishDate(Number(dmy[3]), month, Number(dmy[1]), "day, named month, year");
    }
  }

  // "Mar 21, 2023"
  const mdy = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (mdy) {
    const month = MONTHS[mdy[1].slice(0, 3).toLowerCase()];
    if (month) {
      return finishDate(Number(mdy[3]), month, Number(mdy[2]), "named month, day, year");
    }
  }

  return {
    iso: null,
    reason: `"${text.slice(0, 40)}" is not a date this can read without guessing`,
  };
}

function finishDate(y: number, m: number, d: number, reason: string) {
  // `2023-02-29` parses cleanly and is not a day; `new Date()` rolls it silently
  // to 1 March. Round-tripping through UTC is what catches that.
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return { iso: null, reason: `${y}-${m}-${d} is not a day that exists` };
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return { iso: `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`, reason };
}

/**
 * A person's whole name, from whichever columns the file gave.
 *
 * LinkedIn splits it and most other exports do not, so both shapes have to
 * work — and a file carrying all three columns must not produce
 * `Ada Lovelace Ada Lovelace`. An explicit full-name column wins; otherwise the
 * parts are joined.
 */
export function joinName(row: {
  fullName?: string;
  firstName?: string;
  lastName?: string;
}): string {
  const full = (row.fullName ?? "").trim();
  if (full) return full;
  return [(row.firstName ?? "").trim(), (row.lastName ?? "").trim()].filter(Boolean).join(" ");
}

/** One parsed row, before the server sees it. */
export type ConnectionDraft = ConnectionImportRow & {
  /** 1-based source row, so the preview can point at a line in the file. */
  rowNumber: number;
  /** Why `connectedOn` is null, when it is. Shown, never swallowed. */
  dateReason: string;
};

/**
 * Apply a mapping to the data rows.
 *
 * By column INDEX, never by header name: a file with two columns called `URL`
 * gives a by-name reader a coin flip whose loser is silently not imported, and
 * LinkedIn's export has genuinely shipped duplicate headers.
 */
export function applyConnectionMapping(
  rows: readonly (readonly string[])[],
  mapping: ConnectionMapping,
): ConnectionDraft[] {
  const at = (row: readonly string[], field: ConnectionField): string => {
    const index = mapping[field]?.index;
    if (index === undefined) return "";
    return (row[index] ?? "").trim();
  };

  return rows.map((row, i) => {
    const date = readConnectedOn(at(row, "connectedOn"));
    return {
      rowNumber: i + 1,
      fullName: joinName({
        fullName: at(row, "fullName"),
        firstName: at(row, "firstName"),
        lastName: at(row, "lastName"),
      }),
      firstName: at(row, "firstName"),
      lastName: at(row, "lastName"),
      company: at(row, "company"),
      title: at(row, "title"),
      profileUrl: at(row, "profileUrl"),
      connectedOn: date.iso,
      dateReason: date.reason,
    };
  });
}

/**
 * What committing this file would do — computed before anything is written.
 *
 * The number that matters is `matchedCompanies`: how many of the companies in
 * this export are companies the person is actually tracking. That is the whole
 * value proposition of the import in one integer, and it is the number that
 * tells somebody whether their export is worth uploading before they upload a
 * second one.
 */
export type ConnectionPreview = {
  /** Data rows in the file. */
  total: number;
  /** Rows with a usable name — the ones the server will act on. */
  named: number;
  /** Rows with no name at all. `total - named`, stated rather than inferred. */
  unnamed: number;
  /** Distinct people, after collapsing duplicates the same way the SQL does. */
  distinct: number;
  /** Distinct normalized companies across those people. */
  companies: number;
  /** …of those, ones this user already watches. */
  matchedCompanies: number;
  /** Rows whose date could not be read. Not an error; the column is optional. */
  unreadableDates: number;
  /** Up to five rows, for the "is this the right file" glance. */
  samples: ConnectionDraft[];
};

export const PREVIEW_SAMPLE_ROWS = 5;

export function previewConnections(
  drafts: readonly ConnectionDraft[],
  universeCompanyKeys: ReadonlySet<string>,
): ConnectionPreview {
  const named = drafts.filter((d) => d.fullName.trim() !== "");

  // The SQL's identity, mirrored: a profile URL when there is one, otherwise
  // name + normalized company. A preview that counted rows instead of people
  // would promise more than the commit delivers on every re-import.
  const idents = new Set<string>();
  const companies = new Set<string>();
  for (const d of named) {
    idents.add(
      d.profileUrl.trim()
        ? `u:${d.profileUrl.trim().toLowerCase()}`
        : `n:${d.fullName.trim().toLowerCase()}|${companyNameKey(d.company)}`,
    );
    const key = companyNameKey(d.company);
    if (key) companies.add(key);
  }

  return {
    total: drafts.length,
    named: named.length,
    unnamed: drafts.length - named.length,
    distinct: idents.size,
    companies: companies.size,
    matchedCompanies: [...companies].filter((k) => universeCompanyKeys.has(k)).length,
    unreadableDates: named.filter((d) => d.connectedOn === null && d.dateReason !== "empty").length,
    samples: named.slice(0, PREVIEW_SAMPLE_ROWS),
  };
}

/** The rows the commit sends, without the preview-only fields. */
export function toImportRows(drafts: readonly ConnectionDraft[]): ConnectionImportRow[] {
  return drafts
    .filter((d) => d.fullName.trim() !== "")
    .map((d) => ({
      fullName: d.fullName,
      firstName: d.firstName,
      lastName: d.lastName,
      company: d.company,
      title: d.title,
      profileUrl: d.profileUrl,
      connectedOn: d.connectedOn,
    }));
}
