import { entitlementRefusal, refuseUnlessEntitled } from "@/lib/auth/api-guard";
import { getDataSource } from "@/lib/data/get-source";
import { METERS } from "@/lib/limits/bounds";
import { isDemoMode, type DataSource } from "@/lib/data/source";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import type { ApplicationView, JobView } from "@/lib/data/view-models";
import { APPLICATION_COLUMNS, JOB_COLUMNS, type Column } from "@/lib/export/columns";
import { toCsv } from "@/lib/export/delimited";
import { ROUND_TRIP_COLUMNS } from "@/lib/import/round-trip";
import {
  contentTypeFor,
  exportFilename,
  parseExportRequest,
  sheetNameFor,
  type ExportDataset,
  type ExportRequest,
} from "@/lib/export/scope";
import { buildXlsx } from "@/lib/export/xlsx";

/**
 * File generation, server-side.
 *
 * The client sends which rows it wants, never the rows themselves. That is not
 * ceremony: the server re-reads every row through the same data source the page
 * uses, so an export is subject to exactly the same row-level security as the
 * screen. A client that posted its own row payload could export anything it
 * could fabricate, and the file would look identical.
 *
 * It also keeps the XLSX writer out of the browser bundle, which is the
 * difference between a fast first paint and shipping a zip library to someone
 * who only ever wanted to triage.
 */

export const runtime = "nodejs"; // write-excel-file/node uses node:stream
export const dynamic = "force-dynamic";

/** How each dataset is fetched, keyed and shaped. */
type Spec<T> = {
  all: (s: DataSource) => Promise<T[]>;
  /** What the screen is currently showing, when the client sent no keys. */
  view: (s: DataSource) => Promise<T[]>;
  key: (row: T) => string;
  columns: Column<T>[];
  /**
   * The same columns plus `hq_id`/`hq_version`, when the request asks for a file
   * it can import back. Absent for a dataset that has no such thing, and the
   * request parser refuses the flag there rather than letting this fall back.
   */
  roundTripColumns?: Column<T>[];
};

const JOBS: Spec<JobView> = {
  all: (s) => s.jobs(),
  view: (s) => s.queue({ limit: 999 }),
  key: (j) => j.key,
  columns: JOB_COLUMNS,
};

const APPLICATIONS: Spec<ApplicationView> = {
  all: (s) => s.applications(),
  // The pipeline shows every application; view and all coincide until the
  // grid phase adds filters, and the dialog says so rather than implying a
  // distinction that does not exist.
  view: (s) => s.applications(),
  key: (a) => String(a.id),
  columns: APPLICATION_COLUMNS,
  roundTripColumns: ROUND_TRIP_COLUMNS,
};

function fail(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Is there still a session? Mirrors the check in the triage server action.
 *
 * Demo mode has no auth to expire, and an unconfigured deployment never reaches
 * here — middleware sends it to /setup.
 */
async function hasSession(): Promise<boolean> {
  if (isDemoMode() || !getSupabaseEnv()) return true;
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return Boolean(data?.claims);
}

async function rowsFor<T>(
  spec: Spec<T>,
  req: ExportRequest,
  src: DataSource,
): Promise<T[]> {
  if (req.keys === null) {
    return req.scope === "all" ? spec.all(src) : spec.view(src);
  }
  // Explicit keys: resolve against everything readable, then emit in the order
  // the client asked for so the file matches the order on screen.
  const byKey = new Map((await spec.all(src)).map((r) => [spec.key(r), r]));
  return req.keys.map((k) => byKey.get(k)).filter((r): r is T => r !== undefined);
}

async function build<T>(
  spec: Spec<T>,
  req: ExportRequest,
  src: DataSource,
  dataset: ExportDataset,
): Promise<{ body: BodyInit; rows: number }> {
  const rows = await rowsFor(spec, req, src);
  // `?? spec.columns` is unreachable rather than a fallback: `parseExportRequest`
  // refuses `roundTrip` for any dataset without these, so a request that reaches
  // here asking for them has them.
  const columns = req.roundTrip ? (spec.roundTripColumns ?? spec.columns) : spec.columns;
  if (req.format === "xlsx") {
    const buf = await buildXlsx(rows, columns, { sheetName: sheetNameFor(dataset) });
    return { body: new Uint8Array(buf), rows: rows.length };
  }
  return { body: toCsv(rows, columns), rows: rows.length };
}

export async function POST(request: Request): Promise<Response> {
  // Answer the auth question here rather than letting middleware do it.
  //
  // Middleware resolves a missing session by redirecting to /login. For a page
  // navigation that is right; for this fetch it is a dead end — a 307 preserves
  // the method, `fetch` follows it automatically, `POST /login` answers 405, and
  // the user is told "The server returned 405" while their session quietly
  // expired. A JSON 401 lets the dialog say something true.
  if (!(await hasSession())) {
    return fail("Your session expired. Sign in again to export.", 401);
  }

  // The entitlement gate (0027). Answered HERE for the same reason auth is: this
  // is a fetch, and middleware's redirect to the holding page would reach it as
  // `POST /pending`. A 403 with a sentence is what the caller can act on.
  const notEntitled = await refuseUnlessEntitled();
  if (notEntitled) return notEntitled;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("Malformed request body.", 400);
  }

  const parsed = parseExportRequest(raw);
  if (!parsed.ok) return fail(parsed.error, 400);
  const req = parsed.request;

  try {
    const src = await getDataSource();

    // THE PER-USER BOUND (#261), charged before a single row is read.
    //
    // This route is the cheapest amplification in the product and it had no
    // bound of any kind: a ~100-byte POST regenerates the caller's entire
    // dataset — up to 999 rows through `s.queue({ limit: 999 })`, and for
    // `xlsx` through a zip writer — as often as it is asked, with no payload
    // cap in front of it either. Auth and entitlement both answer "may you",
    // never "how often".
    //
    // Charged HERE rather than inside an RPC because there is no command here:
    // an export writes nothing. `chargeRateBound` is the seam for exactly this
    // — server-side work a signed-in caller can ask for that no `app_*` RPC
    // covers — so the mechanism reaches route handlers and server actions, not
    // only RPCs.
    const charged = await src.chargeRateBound(METERS.exportBuild);
    if (!charged.ok) {
      if (charged.kind === "auth") {
        return fail("Your session expired. Sign in again to export.", 401);
      }
      // 429 for the bound, and the same 429 shape the warm route uses; anything
      // else is a refusal we could not evaluate, which is not permission.
      return fail(charged.message, charged.kind === "rate-limited" ? 429 : 503);
    }

    const { body, rows } = await (req.dataset === "jobs"
      ? build(JOBS, req, src, "jobs")
      : build(APPLICATIONS, req, src, "applications"));

    const filename = exportFilename(req.dataset, req.format, new Date().toISOString().slice(0, 10));

    return new Response(body, {
      headers: {
        "Content-Type": contentTypeFor(req.format),
        "Content-Disposition": `attachment; filename="${filename}"`,
        // Exports are personal data and are cheap to regenerate. Caching one
        // risks handing a stale — or another user's — file back from a proxy.
        "Cache-Control": "no-store",
        // Lets the dialog report what it actually downloaded instead of what
        // it predicted, which is the whole point of stating the scope.
        "X-HQ-Rows": String(rows),
      },
    });
  } catch (err) {
    // A refusal is not a failure: `getDataSource()` throws for an account that is
    // not turned on, and reporting that as a 500 tells the dialog to retry
    // forever and files a false alarm in the log.
    const refused = entitlementRefusal(err);
    if (refused) return refused;
    // Never a stack trace to the browser; the toast says the export failed and
    // offers a retry, and the detail stays in the server log.
    console.error("export failed", err);
    return fail("Could not build the file. Please try again.", 500);
  }
}
