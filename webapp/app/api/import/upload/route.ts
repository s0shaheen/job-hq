import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDataSource, isConfigured } from "@/lib/data/get-source";
import { isDemoMode } from "@/lib/data/source";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { hasContent } from "@/app/(app)/import/prepare";
import {
  MAX_ROWS,
  MAX_UPLOAD_BYTES,
  cellText,
  isBlankCell,
  readDelimited,
  readWorkbook,
  sniffFormat,
  tooLarge,
  tooLargeInflated,
  type Cell,
} from "@/lib/import/read";

/**
 * POST /api/import/upload — bytes in, a batch id out.
 *
 * ## Why a Route Handler and not a server action
 *
 * Verified in the installed Next 15.5.20:
 * `node_modules/next/dist/server/app-render/action-handler.js` defaults a server
 * action's `bodySizeLimit` to 1 MB and throws `ApiError(413)` past it. A
 * 2,000-row xlsx is comfortably over that, and the error surfaces as a generic
 * failure with nothing a person can act on. A route handler owns its own limits,
 * which it can then explain.
 *
 * ## What it does, in order, and why the order matters
 *
 * 1. **Auth, answered here.** Middleware resolves a missing session by
 *    redirecting to /login; a 307 preserves the method, `fetch` follows it, and
 *    `POST /login` answers 405. The user is then told "the server returned 405"
 *    while their session quietly expired (matrix row 37).
 * 2. **The size cap, before the body is read.** `Content-Length` first, so a
 *    40 MB file is refused without being buffered. A request that declares no
 *    length is refused too, because reading it to find out how big it is is the
 *    thing the cap exists to prevent. Re-checked on the real bytes afterwards,
 *    since the header is a claim and the multipart envelope is not the file.
 * 3. **The format, from the magic bytes.** `.xls`, a password-protected
 *    workbook and an Apple Numbers file all fail deep inside a parser with
 *    something unreadable. Each is caught by name and told what to do instead
 *    (matrix row 41).
 * 4. **The INFLATED cap, before the workbook is opened** — read from the zip's
 *    central directory. This is the zip-bomb guard, and it is the one that has to
 *    come before the parse: a bomb is small on the wire and enormous once open,
 *    and the row cap below cannot help because it counts rows that already exist
 *    in memory.
 * 5. **The row cap, AFTER parsing and before staging.** Said plainly because the
 *    other order is impossible: nothing can count the rows in a workbook without
 *    opening it. What bounds the parse is step 4, not this.
 * 6. **Stage, in chunks of 1,000** — `app_import_stage`'s own `MAX_CHUNK`, so a
 *    chunk that works against the fixture works against Postgres.
 *
 * Nothing here writes a MAPPING. The suggestion is deterministic and recomputed
 * from the staged rows whenever the mapping screen renders, so there is one
 * answer to "which column is Company" rather than a stored guess and a live one
 * that can disagree after a reload.
 *
 * Every failure answers `{ error: "<a sentence a person can act on>" }` and the
 * form renders that sentence verbatim. "Payload too large" tells nobody anything.
 */

export const runtime = "nodejs"; // read-excel-file/node and node:crypto
export const dynamic = "force-dynamic";

/** `app_import_stage`'s MAX_CHUNK. Named here so the two cannot drift silently. */
const STAGE_CHUNK = 1000;

/** Bound on a pasted body. Rows are capped separately; this bounds the string. */
const MAX_PASTE_BYTES = 4 * 1024 * 1024;

const DEMO_EXPIRED_COOKIE = "hq_demo_session";

function fail(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Is there still a session?
 *
 * The demo cookie is honoured as well as the real check, for the reason
 * `get-source.ts` gives for `hq_demo_fail`: an E2E drives the real UI and needs
 * to change what the SERVER does mid-journey, and a cookie is the only channel it
 * has. Without it the 401 branch above would be unreachable in the only mode the
 * suite can run — an untestable branch is an untested one.
 */
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

/** One source row's cells, keyed by column index. See `prepare.ts` for why. */
function rawOf(cells: readonly Cell[]): Record<string, string> {
  const raw: Record<string, string> = {};
  for (let i = 0; i < cells.length; i += 1) {
    const text = cellText(cells[i] ?? null);
    // An omitted key is a cell the file left empty. Storing "" instead would put
    // 60 empty strings on every row of a wide sheet for no added meaning.
    if (text !== "") raw[String(i)] = text;
  }
  return raw;
}

type Parsed = {
  rows: Cell[][];
  sourceKind: "xlsx" | "csv" | "paste";
  filename: string;
  bytes: Uint8Array;
};

/**
 * A workbook's single sheet with data in it — or a named refusal.
 *
 * Multi-sheet workbooks are refused rather than guessed at, and that is the
 * honest end of §4.2's "sheet chooser": a chooser is UI nobody has built, and
 * silently importing sheet 1 of 3 is how somebody's Archive tab becomes 400 live
 * applications. Sheets with nothing in them do not count, so the ordinary
 * "Sheet2 and Sheet3 are empty" workbook still works.
 */
function pickSheet(
  sheets: { name: string; rows: Cell[][] }[],
): { rows: Cell[][] } | { error: string } {
  const withData = sheets.filter((s) => hasContent(s.rows));
  if (withData.length === 0) {
    return { error: "Every sheet in that workbook is empty — there are no rows to import." };
  }
  if (withData.length > 1) {
    const names = withData.map((s) => `"${s.name}"`).join(", ");
    return {
      error:
        `That workbook has ${withData.length} sheets with data in them (${names}), and importing ` +
        `the wrong one is not something you could undo by eye. Copy the sheet you want into its ` +
        `own file — or save it as a .csv — and upload that.`,
    };
  }
  return { rows: withData[0].rows };
}

export async function POST(request: Request): Promise<NextResponse> {
  // An unconfigured deployment must look broken rather than answer 200 with
  // invented behaviour (`get-source.ts`'s NotConfiguredError, same rule).
  if (!isConfigured()) return fail("This deployment is not configured.", 503);
  if (!(await hasSession())) {
    return fail("Your session expired. Sign in again and upload the file once more.", 401);
  }

  // `.get()` answers null for an absent header and `Number(null)` is 0 — finite,
  // non-negative, and straight past the check below. So a chunked request, which
  // is exactly the one that declines to say how big it is, skipped the pre-read
  // cap entirely while this code claimed to refuse it. Checked as a STRING first.
  const declaredHeader = request.headers.get("content-length");
  const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader.trim() || "x");
  if (!Number.isFinite(declared) || declared < 0) {
    // 411, not 413: the request is not too large, it refuses to say. Reading it
    // to find out is exactly what the cap exists to prevent, so it is refused
    // with the reason rather than buffered "just this once".
    return fail(
      "That upload did not say how big it is, so it was not read. Choose the file again — or, if this came from a script, send a Content-Length header.",
      411,
    );
  }
  const overWire = tooLarge({ bytes: declared });
  if (overWire) return fail(overWire, 413);

  const contentType = request.headers.get("content-type") ?? "";
  let parsed: Parsed;

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail("That upload could not be read. Choose the file again.", 400);
    }
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return fail("No file came through. Choose a .xlsx or .csv and try again.", 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Checked again on the real bytes: `Content-Length` covers the whole
    // multipart envelope, and a proxy that rewrote the body would have made the
    // header a claim rather than a measurement.
    const overBytes = tooLarge({ bytes: bytes.length });
    if (overBytes) return fail(overBytes, 413);

    const filename = typeof file.name === "string" && file.name ? file.name : "upload.csv";
    const sniff = sniffFormat(filename, bytes);
    if (sniff.kind === "rejected") return fail(sniff.message, 415);

    if (sniff.kind === "xlsx") {
      // Before the inflate, from the zip's own central directory. The wire cap
      // bounds the bytes and not the work: a million near-identical rows is a few
      // MB compressed and hundreds of MB open, and the row cap below cannot help
      // because by the time it counts rows the memory is already spent.
      const overInflated = tooLargeInflated(bytes);
      if (overInflated) return fail(overInflated, 413);

      let sheets;
      try {
        sheets = await readWorkbook(bytes);
      } catch {
        // A zip that passed the marker check and still will not open. Named as a
        // file problem rather than surfaced as a 500, which reads as our bug.
        return fail(
          "That .xlsx could not be opened. Re-save it from Excel or Google Sheets (File → Save As → .xlsx) and try again.",
          415,
        );
      }
      const picked = pickSheet(sheets);
      if ("error" in picked) return fail(picked.error, 415);
      parsed = { rows: picked.rows, sourceKind: "xlsx", filename, bytes };
    } else {
      parsed = { rows: readDelimited(bytes).rows, sourceKind: "csv", filename, bytes };
    }
  } else {
    const text = await request.text();
    if (text.length > MAX_PASTE_BYTES) {
      return fail(
        "That paste is too big to read in one go. Save it as a .csv and upload the file instead.",
        413,
      );
    }
    let body: { paste?: unknown };
    try {
      body = JSON.parse(text || "{}") as { paste?: unknown };
    } catch {
      return fail("The request body was not JSON. Send `{ \"paste\": \"…\" }`.", 400);
    }
    if (typeof body.paste !== "string" || body.paste.trim() === "") {
      return fail("Nothing was pasted. Copy the rows out of your spreadsheet and paste them in.", 400);
    }
    parsed = {
      rows: readDelimited(body.paste).rows,
      sourceKind: "paste",
      filename: "Pasted rows",
      bytes: new TextEncoder().encode(body.paste),
    };
  }

  // 1-based numbering over what the reader returned, with the blank rows dropped
  // and their numbers left as gaps. Deleting rows in Excel leaves lines behind
  // that are blank or hold a lone comma; counted as rows they become empty
  // applications nobody asked for. Renumbering after the drop would be worse than
  // the blanks: "row 37" in the report has to be the row 37 the person can see.
  //
  // True of a workbook, and NOT true of a csv or a paste: `readDelimited` parses
  // with papaparse's `skipEmptyLines: "greedy"`, which drops both an empty line
  // and one holding a lone comma before anything here counts — so on that path the
  // rows after a blank shift up and the gap is gone. Measured and pinned in
  // `tests/unit/import-upload-route.test.ts` rather than described here as if it
  // were uniform.
  const numbered = parsed.rows
    .map((cells, i) => ({ rowNumber: i + 1, cells }))
    .filter((r) => r.cells.some((c) => !isBlankCell(c)));

  if (numbered.length === 0) {
    return fail("There are no rows in that — every line is empty.", 400);
  }
  const overRows = tooLarge({ rows: numbered.length });
  if (overRows) return fail(overRows, 413);

  const contentHash = createHash("sha256").update(parsed.bytes).digest("hex");

  // Minted by the CLIENT and reused by every retry of the same upload, so a
  // request whose response was lost lands on the batch it already created rather
  // than a second copy of it. A caller that sends none cannot replay, and gets a
  // fresh key rather than a refusal.
  const sent = request.headers.get("x-hq-idempotency-key");
  const idempotencyKey = sent && sent.length <= 200 ? sent : crypto.randomUUID();

  const source = await getDataSource();
  const created = await source.createImport({
    filename: parsed.filename,
    sourceKind: parsed.sourceKind,
    contentHash,
    rowCount: numbered.length,
    idempotencyKey,
  });
  if (!created.ok) {
    if (created.kind === "auth") {
      return fail("Your session expired. Sign in again and upload the file once more.", 401);
    }
    return fail(created.kind === "conflict" ? "That import was already started." : created.message, 400);
  }

  const batchId = created.batch.id;
  for (let at = 0; at < numbered.length; at += STAGE_CHUNK) {
    const chunk = numbered.slice(at, at + STAGE_CHUNK);
    const staged = await source.stageImportRows({
      batchId,
      rows: chunk.map((r) => ({ rowNumber: r.rowNumber, raw: rawOf(r.cells) })),
    });
    if (!staged.ok) {
      if (staged.kind === "auth") {
        return fail("Your session expired. Sign in again and upload the file once more.", 401);
      }
      // The batch exists and holds what landed. Say so and where it is, rather
      // than leaving a half-staged import for somebody to find in the list.
      return fail(
        `Only part of that file was stored (${staged.message}). Open the import from the list and upload the file again — the rows already stored will not be duplicated.`,
        502,
      );
    }
  }

  return NextResponse.json({ batchId, rows: numbered.length, idempotencyKey });
}

/** Stated, so a GET gets an explanation rather than Next's bare 405. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "Use POST.",
      contract: {
        POST: "multipart/form-data with a `file`, or JSON `{ paste: string }`",
        headers: { "x-hq-idempotency-key": "optional; reuse it to retry safely" },
        returns: { batchId: "string", rows: "number" },
        limits: { bytes: MAX_UPLOAD_BYTES, rows: MAX_ROWS },
      },
    },
    { status: 405 },
  );
}
