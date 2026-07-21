import { getDataSource } from "@/lib/data/get-source";
import type { DataSource } from "@/lib/data/source";
import type { ApplicationView, JobView } from "@/lib/data/view-models";
import { APPLICATION_COLUMNS, JOB_COLUMNS, type Column } from "@/lib/export/columns";
import { toCsv } from "@/lib/export/delimited";
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
};

function fail(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
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
  if (req.format === "xlsx") {
    const buf = await buildXlsx(rows, spec.columns, { sheetName: sheetNameFor(dataset) });
    return { body: new Uint8Array(buf), rows: rows.length };
  }
  return { body: toCsv(rows, spec.columns), rows: rows.length };
}

export async function POST(request: Request): Promise<Response> {
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
    // Never a stack trace to the browser; the toast says the export failed and
    // offers a retry, and the detail stays in the server log.
    console.error("export failed", err);
    return fail("Could not build the file. Please try again.", 500);
  }
}
