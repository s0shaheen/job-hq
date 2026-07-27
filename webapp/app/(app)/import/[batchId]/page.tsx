import { notFound } from "next/navigation";
import { getDataSource } from "@/lib/data/get-source";
import { MAPPABLE_FIELDS } from "@/lib/import/map-columns";
import { importStep } from "@/lib/import/views";
import CommitStep from "../commit-step";
import MapStep from "../map-step";
import PreviewStep from "../preview-step";
import ReportStep from "../report-step";
import { grid, headerGuess, mapModel, previewRows, NO_HEADER_ROW } from "../prepare";

export const metadata = { title: "Import — Job Search HQ" };
export const dynamic = "force-dynamic";

/**
 * One batch, rendered as whichever step it is on.
 *
 * **The step is derived on the server, from `import_batches.state`, on every
 * request.** Nothing about which step you are on, which column you picked, or
 * which rows you skipped lives in the browser — so a reload at any point in the
 * wizard renders the same screen with the same answers, and closing the tab
 * mid-import loses nothing (matrix row 44, and the half of G12 that says
 * "resumable").
 *
 * The consequence worth stating: an in-progress FORM is still a form. Reloading
 * while half-way through changing a mapping shows the mapping the server holds,
 * not the edits nobody has saved. That is the same contract every form in this app
 * has, and it is the opposite of losing a step.
 */
export default async function ImportBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  const source = await getDataSource();
  const found = await source.importBatch(batchId);
  // A batch belonging to somebody else resolves to nothing, never to a row —
  // `importBatch` is scoped to the caller, so "not yours" and "not there" are one
  // answer here on purpose.
  if (!found) notFound();

  const { batch, rows } = found;
  const step = importStep(batch);
  const filename = batch.filename || "Pasted rows";

  if (step === "map") {
    const saved = batch.mapping.headers.length > 0 ? batch.mapping : null;
    const guess = headerGuess(grid(rows));
    // A saved answer wins over the guess; the guess is what a first visit sees.
    const savedIndex = saved ? saved.headerRowIndex : null;
    const headerRowIndex =
      savedIndex !== null && savedIndex !== NO_HEADER_ROW ? savedIndex : guess.headerRowIndex;

    return (
      <MapStep
        batchId={batchId}
        filename={filename}
        expectedUpdatedAt={batch.updatedAt}
        fields={[...MAPPABLE_FIELDS]}
        // BOTH models, computed here rather than fetched on toggle: "the first row
        // is data" has to answer instantly, and the samples and status vocabulary
        // it shows are different data. A round trip per keystroke on a control this
        // cheap would make the honest answer feel expensive.
        withHeader={mapModel(rows, headerRowIndex)}
        noHeader={mapModel(rows, NO_HEADER_ROW)}
        headerReason={guess.reason}
        headerUncertain={guess.uncertain}
        initialNoHeader={savedIndex === NO_HEADER_ROW}
        savedColumnMap={saved ? saved.columnMap : null}
        savedStatusMap={saved ? saved.statusMap : null}
      />
    );
  }

  if (step === "preview") {
    const preview = previewRows(rows, batch.mapping.headerRowIndex);
    return (
      <PreviewStep
        batchId={batchId}
        filename={filename}
        rows={preview.rows}
        headerRowsSkipped={preview.skipped}
        roundTrip={batch.mapping.roundTrip}
      />
    );
  }

  if (step === "commit") {
    // Deliberately no rows: the loop needs `remaining`, which comes back from each
    // chunk, and shipping 2,000 rows to a screen that renders a progress bar is
    // payload nobody looks at.
    return <CommitStep batchId={batchId} batch={batch} />;
  }

  // `importReport` is a read from this app's point of view, so it renders here
  // rather than being fetched after mount — a report that arrives a frame late
  // reads as an empty report. (In Postgres the function also refreshes the
  // `imported`/`read-only` rows it returns, which is idempotent.)
  const report = await source.importReport(batchId);
  return <ReportStep batchId={batchId} batch={batch} report={report} />;
}
