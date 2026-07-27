"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { importProgress, type ImportBatchView } from "@/lib/import/views";
import { COMMIT_CHUNK, runCommit } from "./run";
import { StepHeader, StepShell, useHydrated } from "./step-shell";
import { useWrites } from "./use-writes";

/**
 * Step 3 — the chunk loop, and the screen a reload lands on.
 *
 * This step exists because of a failure rather than for the progress bar: a
 * commit that died half-way (tab closed, laptop shut, request timed out) leaves a
 * batch that has written some of its rows, and a batch like that must not be
 * indistinguishable from a finished one. `import_batches.state` stays `committing`
 * until nothing is pending, `importStep` sends that state here, and this screen
 * picks the loop up from `committedCount` — the resume cursor — rather than
 * starting over.
 *
 * Resuming automatically is the honest behaviour: nothing else in the system will
 * ever finish this batch, and a person who has already pressed Import should not
 * have to press it again to get the rows they asked for. What the copy must not do
 * is promise that it continues with the tab shut, because it does not.
 */
export default function CommitStep({
  batchId,
  batch,
}: {
  batchId: string;
  batch: ImportBatchView;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { pending, writes, run } = useWrites();

  const total = batch.stagedCount || batch.rowCount;
  const [settled, setSettled] = React.useState(batch.committedCount);
  const [fraction, setFraction] = React.useState(() => importProgress(batch));
  const [tally, setTally] = React.useState({ created: 0, updated: 0, skipped: 0, failed: 0 });

  /**
   * One loop per mount.
   *
   * A ref rather than a dependency-free effect: React runs effects twice in
   * development, and two loops over one batch would each ask for the next chunk of
   * pending rows. The rows themselves are safe — a committed row is no longer
   * pending, and each chunk carries its own idempotency key — but the progress
   * would jump around and the work would be pointless.
   */
  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void runCommit({
      batchId,
      run,
      onProgress: (result) => {
        setSettled(result.batch.committedCount);
        setFraction(importProgress(result.batch));
        setTally((current) => ({
          created: current.created + result.created,
          updated: current.updated + result.updated,
          skipped: current.skipped + result.skipped,
          failed: current.failed + result.failed,
        }));
      },
      // The batch's own state decides the step, so a refresh is what moves the
      // wizard on to the report.
      onDone: () => router.refresh(),
    });
  }, [batchId, router, run]);

  const percent = Math.round(fraction * 100);

  return (
    <StepShell step="commit" ready={hydrated} writes={writes} pending={pending}>
      <StepHeader
        title="Importing"
        filename={batch.filename || "Pasted rows"}
        step={3}
        detail={
          <>
            {COMMIT_CHUNK} rows at a time, each batch on its own. Closing this tab stops it where
            it is — nothing is half-written, and opening this import again carries on from the
            same place.
          </>
        }
      />

      <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6">
        <p className="tabular text-sm font-medium text-text" data-testid="commit-progress">
          {settled.toLocaleString("en-US")} of {total.toLocaleString("en-US")} rows · {percent}%
        </p>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={settled}
          aria-label="Rows imported"
          className="mt-2 h-2 w-full overflow-hidden rounded-full bg-raised"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-200 motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          {(
            [
              ["Added", tally.created],
              ["Updated", tally.updated],
              ["Skipped", tally.skipped],
              ["Failed", tally.failed],
            ] as const
          ).map(([label, n]) => (
            <div key={label} className="min-w-0 rounded-lg border border-border bg-surface p-2">
              <dt className="text-2xs text-muted">{label}</dt>
              <dd className="tabular text-sm font-medium text-text">{n.toLocaleString("en-US")}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-3 text-2xs text-muted">
          {/* The counts above are THIS visit's chunks, and saying so is the
              difference between a number that looks wrong and one that is
              explained: a resumed import has already written rows that no longer
              pass through this screen. The report at the end counts them all. */}
          These are the rows imported since this screen opened. The report at the end covers the
          whole file.
        </p>
      </div>
    </StepShell>
  );
}
