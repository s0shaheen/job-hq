import { ArrowRight, Upload } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { getDataSource } from "@/lib/data/get-source";
import { fmtStamp } from "@/lib/format";
import { MAX_ROWS, MAX_UPLOAD_BYTES } from "@/lib/import/read";
import { importProgress, isUndoable, type ImportBatchView } from "@/lib/import/views";
import { stateCopy } from "./fields";
import UploadPanel from "./upload-panel";

export const metadata = { title: "Import — Job Search HQ" };
export const dynamic = "force-dynamic";

/**
 * The import landing: a file picker, a paste box, and what has been imported
 * before.
 *
 * The list is not decoration. An import is the one gesture in this app that
 * cannot be one call — it parses into Postgres and reads back, so closing the tab
 * loses nothing — which means a half-finished import is a real thing a person can
 * leave behind. If nothing showed them, "part-imported" would be indistinguishable
 * from "finished", which is the failure the `committing` state exists to name.
 */
export default async function ImportLandingPage() {
  const batches = await (await getDataSource()).imports();

  return (
    <div className="min-w-0">
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h1 className="min-w-0 break-words text-lg font-semibold">Import</h1>
        </div>
        <p className="text-xs text-muted">
          Bring a spreadsheet of applications in — yours, or one somebody else keeps for you.
        </p>
      </header>

      <UploadPanel maxBytes={MAX_UPLOAD_BYTES} maxRows={MAX_ROWS}>
        <section className="mt-6">
          <h2 className="text-xs font-semibold text-text">Recent imports</h2>
          {batches.length === 0 ? (
            /* Names what to do rather than stating an absence. "No imports" is
               true and useless; the two things a person can act on are the file
               picker above and the fact that nothing has been written yet
               (matrix rows 15 and 117). */
            <p
              data-testid="import-empty"
              className="mt-1.5 rounded-lg border border-border border-dashed bg-surface px-3 py-4 text-xs text-muted"
            >
              Nothing has been imported on this account yet. Choose a .xlsx or .csv above — or
              paste the rows straight out of a spreadsheet — and the next screen asks which column
              is which. Nothing is written until you have seen what every row would do.
            </p>
          ) : (
            <ul className="mt-1.5 divide-y divide-border rounded-lg border border-border bg-surface">
              {batches.map((batch) => (
                <li key={batch.id} className="min-w-0">
                  <BatchRow batch={batch} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </UploadPanel>
    </div>
  );
}

function BatchRow({ batch }: { batch: ImportBatchView }) {
  const copy = stateCopy(batch.state);
  const progress = importProgress(batch);
  const total = batch.stagedCount || batch.rowCount;

  return (
    <Link
      href={`/import/${batch.id}`}
      data-testid={`import-batch-${batch.id}`}
      className="block px-3 py-2.5 hover:bg-raised focus-visible:outline-2
                 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Upload aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
        <span className="min-w-0 break-words text-xs font-medium text-text">
          {batch.filename || "Pasted rows"}
        </span>
        <Badge
          tone={
            batch.state === "committed"
              ? "ok"
              : batch.state === "failed"
                ? "danger"
                : batch.state === "committing"
                  ? "warn"
                  : "neutral"
          }
          data-testid={`import-state-${batch.id}`}
        >
          {copy.label}
        </Badge>
        <ArrowRight aria-hidden="true" className="size-3 shrink-0 text-muted" />
      </div>
      <p className="mt-0.5 min-w-0 break-words text-2xs text-muted">
        <span className="tabular">
          {/* "in the file", spelled out: this counts the header row too, so a
              40-application spreadsheet reads as 41 and somebody comparing it
              against their own sheet deserves to know which number this is. */}
          {total.toLocaleString("en-US")} {total === 1 ? "row" : "rows"} in the file
          {batch.committedCount > 0 && batch.state !== "committed"
            ? ` · ${Math.round(progress * 100)}% settled`
            : ""}
        </span>
        {batch.createdAt ? <> · {fmtStamp(batch.createdAt)}</> : null}
        {copy.hint ? <> · {copy.hint}</> : null}
        {isUndoable(batch) ? <> · can still be undone</> : null}
      </p>
    </Link>
  );
}
