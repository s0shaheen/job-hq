/**
 * The export request model — what gets exported, and how it is stated.
 *
 * The spec's rule for this surface is blunt: "Selection semantics are stated in
 * the dialog. Silently exporting only the filtered subset is a top-tier trust
 * bug." This file is the machine half of that promise. Every value is a closed
 * set and a malformed request is rejected rather than defaulted, because the
 * failure mode of a lenient parser here is a file that looks completely correct
 * and contains the wrong rows.
 */

export const EXPORT_DATASETS = ["jobs", "applications"] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

/**
 * `view` — exactly what the current screen is showing (the default).
 * `selection` — only the rows the user picked; requires explicit keys.
 * `all` — every row the user can see, ignoring the current view.
 */
export const EXPORT_SCOPES = ["view", "selection", "all"] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];

export const EXPORT_FORMATS = ["csv", "xlsx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * A bound, because everything that can grow gets one. Ten thousand keys is far
 * past any real selection and still small enough to serialize; beyond it the
 * request is a bug or an attack, and failing fast beats a request that hangs.
 */
export const MAX_EXPORT_KEYS = 10_000;

export type ExportRequest = {
  dataset: ExportDataset;
  scope: ExportScope;
  format: ExportFormat;
  /** Explicit row keys, or null to let the server resolve the scope. */
  keys: string[] | null;
  /**
   * Carry `hq_id` and `hq_version`, so the file can be imported back.
   *
   * Applications only, and refused rather than ignored for `jobs`: a posting has
   * no editable row behind it, so a jobs file with those columns would promise a
   * round trip the importer cannot perform. Silently dropping the flag is the
   * same class of failure this whole module exists to prevent — a file that
   * looks right and is not.
   */
  roundTrip: boolean;
};

export type ParseResult =
  | { ok: true; request: ExportRequest }
  | { ok: false; error: string };

function isOneOf<T extends readonly string[]>(
  set: T,
  v: unknown,
): v is T[number] {
  return typeof v === "string" && (set as readonly string[]).includes(v);
}

export function parseExportRequest(raw: unknown): ParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "Expected an export request object." };
  }
  const body = raw as Record<string, unknown>;

  if (!isOneOf(EXPORT_DATASETS, body.dataset)) {
    return { ok: false, error: `Unknown dataset: ${String(body.dataset)}` };
  }
  if (!isOneOf(EXPORT_SCOPES, body.scope)) {
    return { ok: false, error: `Unknown scope: ${String(body.scope)}` };
  }
  if (!isOneOf(EXPORT_FORMATS, body.format)) {
    return { ok: false, error: `Unknown format: ${String(body.format)}` };
  }

  let keys: string[] | null = null;
  if (body.keys !== undefined && body.keys !== null) {
    if (!Array.isArray(body.keys)) {
      return { ok: false, error: "keys must be an array." };
    }
    if (body.keys.length > MAX_EXPORT_KEYS) {
      return { ok: false, error: `Too many rows selected (limit ${MAX_EXPORT_KEYS}).` };
    }
    if (!body.keys.every((k) => typeof k === "string")) {
      return { ok: false, error: "keys must be strings." };
    }
    keys = body.keys as string[];
  }

  // A selection of nothing is never what someone meant. Producing a
  // header-only file would read as "you have no data", which is a lie.
  if (body.scope === "selection" && (keys === null || keys.length === 0)) {
    return { ok: false, error: "Nothing is selected." };
  }

  let roundTrip = false;
  if (body.roundTrip !== undefined && body.roundTrip !== null) {
    if (typeof body.roundTrip !== "boolean") {
      return { ok: false, error: "roundTrip must be true or false." };
    }
    roundTrip = body.roundTrip;
  }
  if (roundTrip && body.dataset !== "applications") {
    return {
      ok: false,
      error: "Only the pipeline can be exported for re-import; a role has no row to write back to.",
    };
  }

  return {
    ok: true,
    request: { dataset: body.dataset, scope: body.scope, format: body.format, keys, roundTrip },
  };
}

export function exportFilename(
  dataset: ExportDataset,
  format: ExportFormat,
  isoDate: string,
): string {
  return `job-search-hq-${dataset}-${isoDate}.${format}`;
}

export function contentTypeFor(format: ExportFormat): string {
  return format === "xlsx"
    ? // The exact OOXML type. A generic octet-stream makes Excel on Windows
      // treat the download as untrusted and refuse to open it directly.
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "text/csv; charset=utf-8";
}

/** Excel caps a tab name at 31 characters and forbids : \ / ? * [ ]. */
export function sheetNameFor(dataset: ExportDataset): string {
  return dataset === "jobs" ? "Jobs" : "Pipeline";
}
