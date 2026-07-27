import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isConfigured } from "@/lib/data/get-source";
import { isDemoMode } from "@/lib/data/source";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import {
  MAX_ROWS,
  cellText,
  isBlankCell,
  readDelimited,
  readWorkbook,
  sniffFormat,
  sniffHeaderRow,
  tooLarge,
  tooLargeInflated,
  type Cell,
} from "@/lib/import/read";

/**
 * POST /api/connections/upload — a LinkedIn `Connections.csv`, parsed.
 *
 * ## Why a Route Handler, and why it looks like `/api/import/upload`
 *
 * Same reason, measured in the same Next 15.5.20: a server action's
 * `bodySizeLimit` defaults to 1 MB and throws a bare `ApiError(413)` past it. A
 * 3,000-connection export is comfortably over that, and the failure surfaces as
 * a generic error with nothing a person can act on.
 *
 * Every guard in that route is reused here rather than reimplemented — the size
 * caps, the magic-byte format refusals, the zip-bomb inflate check, the strict
 * UTF-8 decode with the hand-written windows-1252 fallback, the UTF-16 refusal.
 * Those are the four ways an import goes quietly wrong and they are not specific
 * to what the file is ABOUT.
 *
 * ## What is different, and it is one thing
 *
 * **This route does not stage.** It parses and answers with the rows; the
 * browser holds them through the mapping screen and posts them back to commit.
 * The applications importer stages into Postgres because a 2,000-row spreadsheet
 * with per-row conflict resolution cannot be re-done from scratch when a tab
 * closes. A connections export has no per-row decisions at all — the whole file
 * is one gesture — so staging would buy resumability nobody needs at the cost of
 * a second batch state machine.
 *
 * The cost is stated on screen rather than implied: closing the tab mid-mapping
 * loses the mapping, and the fix is to upload the file again.
 *
 * ## The preamble
 *
 * LinkedIn's export opens with a literal `Notes:` line, a paragraph about
 * missing email addresses, and a blank line before the header. `sniffHeaderRow`
 * finds the real header by looking for the first row that names every column
 * with data below it — so the preamble is handled by machinery that already
 * exists rather than by a skip-two-lines that breaks silently the third time
 * LinkedIn rewords its own paragraph.
 */

export const runtime = "nodejs"; // read-excel-file/node
export const dynamic = "force-dynamic";

const DEMO_EXPIRED_COOKIE = "hq_demo_session";

function fail(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

async function hasSession(): Promise<boolean> {
  if (isDemoMode()) {
    try {
      return (await cookies()).get(DEMO_EXPIRED_COOKIE)?.value !== "expired";
    } catch {
      return true;
    }
  }
  if (!getSupabaseEnv()) return true;
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return Boolean(data?.claims);
}

export type ConnectionsUploadResponse = {
  filename: string;
  /** The header row's cells, verbatim. */
  headers: string[];
  /** Data rows, as text, in file order. */
  rows: string[][];
  /** Which row `sniffHeaderRow` chose, 1-based, and why — always shown. */
  headerRow: number;
  headerReason: string;
  /** True when the guess is not safe on its own. The UI must offer the toggle. */
  headerUncertain: boolean;
  /** Which decode ran. A silent fallback is a guess. */
  encoding: string;
};

export async function POST(request: Request): Promise<NextResponse> {
  if (!isConfigured()) return fail("This deployment is not configured.", 503);
  if (!(await hasSession())) {
    return fail("Your session expired. Sign in again and upload the file once more.", 401);
  }

  // A string check first: `.get()` answers null for an absent header and
  // `Number(null)` is 0 — finite, non-negative, and straight past the cap. A
  // chunked request is exactly the one that declines to say how big it is.
  const declaredHeader = request.headers.get("content-length");
  const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader.trim() || "x");
  if (!Number.isFinite(declared) || declared < 0) {
    return fail(
      "That upload did not say how big it is, so it was not read. Choose the file again.",
      411,
    );
  }
  const overWire = tooLarge({ bytes: declared });
  if (overWire) return fail(overWire, 413);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("That upload could not be read. Choose the file again.", 400);
  }
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return fail("No file came through. Choose your Connections.csv and try again.", 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Re-checked on the real bytes: `Content-Length` covers the whole multipart
  // envelope, so the header is a claim rather than a measurement.
  const overBytes = tooLarge({ bytes: bytes.length });
  if (overBytes) return fail(overBytes, 413);

  const filename = typeof file.name === "string" && file.name ? file.name : "Connections.csv";
  const sniff = sniffFormat(filename, bytes);
  if (sniff.kind === "rejected") return fail(sniff.message, 415);

  let cells: Cell[][];
  let encoding = "utf-8";
  if (sniff.kind === "xlsx") {
    // LinkedIn ships a .csv, but somebody who opened it in Excel and saved is
    // uploading a workbook — and refusing that would be refusing the ordinary
    // thing a person does to look at their own file first.
    const overInflated = tooLargeInflated(bytes);
    if (overInflated) return fail(overInflated, 413);
    let sheets;
    try {
      sheets = await readWorkbook(bytes);
    } catch {
      return fail(
        "That .xlsx could not be opened. Re-save it from Excel or Google Sheets and try again.",
        415,
      );
    }
    const withData = sheets.filter((s) => s.rows.some((r) => r.some((c) => !isBlankCell(c))));
    if (withData.length === 0) {
      return fail("Every sheet in that workbook is empty — there is nothing to import.", 415);
    }
    if (withData.length > 1) {
      // Guessed silently, this is somebody's Archive tab becoming their
      // connections. `/api/import/upload` refuses for the same reason.
      const names = withData.map((s) => `"${s.name}"`).join(", ");
      return fail(
        `That workbook has ${withData.length} sheets with data in them (${names}). Copy the connections sheet into its own file and upload that.`,
        415,
      );
    }
    cells = withData[0].rows;
  } else {
    const delimited = readDelimited(bytes);
    cells = delimited.rows;
    encoding = delimited.encoding;
  }

  // Blank lines dropped before the header sniff, because LinkedIn puts one
  // between its preamble and the header and a blank row scores 0 for
  // header-likeness — leaving it in would make the sniff's own reasoning about
  // "the row below" point at nothing.
  const nonEmpty = cells.filter((r) => r.some((c) => !isBlankCell(c)));
  if (nonEmpty.length === 0) {
    return fail("There are no rows in that file — every line is empty.", 400);
  }

  const header = sniffHeaderRow(nonEmpty);
  const headerCells = nonEmpty[header.index] ?? [];
  const dataRows = nonEmpty.slice(header.index + 1);

  if (dataRows.length === 0) {
    return fail(
      "That file has a header and no rows under it. Re-download your export from LinkedIn (Settings → Data privacy → Get a copy of your data → Connections).",
      400,
    );
  }
  const overRows = tooLarge({ rows: dataRows.length });
  if (overRows) {
    // "Split it and upload twice" was the first version of this sentence and it
    // was a half-truth: both halves DO land in the table, and `connections()`
    // reads only the first `CONNECTION_LIST_LIMIT` rows by name — which is the
    // same 5,000 — so the second half is stored and invisible, and every warm
    // popover silently under-counts for names sorting after the cut. On a branch
    // whose standard is to state what is not there, that was the one cap nothing
    // said. The refusal now names the real ceiling instead of offering a
    // workaround that does not work.
    return fail(
      `That export has ${dataRows.length.toLocaleString("en-US")} connections and this app holds ${MAX_ROWS.toLocaleString("en-US")}. Splitting the file does not help — the extra rows would be stored and never shown. Trim the export to your ${MAX_ROWS.toLocaleString("en-US")} most useful connections and upload that.`,
      413,
    );
  }

  const width = Math.max(headerCells.length, ...dataRows.map((r) => r.length));
  const body: ConnectionsUploadResponse = {
    filename,
    headers: Array.from({ length: width }, (_, i) => cellText(headerCells[i] ?? null)),
    rows: dataRows.map((r) => Array.from({ length: width }, (_, i) => cellText(r[i] ?? null))),
    headerRow: header.index + 1,
    headerReason: header.reason,
    headerUncertain: header.uncertain,
    encoding,
  };
  return NextResponse.json(body);
}
