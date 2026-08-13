"use client";

import { ArrowRight, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClass } from "@/components/ui/button";
import { fmtStamp } from "@/lib/format";
import {
  explainDisposition,
  isUndoable,
  type ImportBatchView,
  type ImportColumnReportView,
} from "@/lib/import/views";
import type { UndoActionResult } from "./actions";
import { runUndo, undoSummary } from "./run";
import { StepHeader, StepShell, useHydrated } from "./step-shell";
import { useWrites } from "./use-writes";

/**
 * Step 4 — the per-column account, and the one gesture that takes it all back.
 *
 * The report is the whole of G13. An import that silently drops a column is how
 * somebody stops trusting the feature altogether: they edited Disposition in
 * Excel, nothing happened, and nothing said why. So every column the file carried
 * gets a line — imported, left alone because the system owns it, left alone
 * because a person had chosen that status, not mapped, or not a column this app
 * knows — with a count and up to three examples.
 *
 * A report with no lines is itself stated. "No rows" on a page whose job is to
 * account for the file would otherwise read as all-clear and mean the opposite
 * (matrix row 15).
 */

const DISPOSITION_TONE = {
  imported: "ok",
  "read-only": "info",
  locked: "warn",
  unmapped: "neutral",
  "unknown-column": "neutral",
  cleared: "ok",
} as const;

const DISPOSITION_LABEL = {
  imported: "Imported",
  "read-only": "Set by the system",
  locked: "Your choice kept",
  unmapped: "Not mapped",
  "unknown-column": "Not a column here",
  cleared: "Cleared",
} as const;

type UndoOk = Extract<UndoActionResult, { ok: true }>;

export default function ReportStep({
  batchId,
  batch,
  report,
}: {
  batchId: string;
  batch: ImportBatchView;
  report: ImportColumnReportView[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { pending, writes, run } = useWrites();
  const [undone, setUndone] = React.useState<UndoOk | null>(null);

  const total = batch.stagedCount || batch.rowCount;
  const undoable = isUndoable(batch);

  const title =
    batch.state === "rolled_back"
      ? "Import undone"
      : batch.state === "failed"
        ? "Import stopped"
        : "Import finished";

  return (
    <StepShell step="report" ready={hydrated} writes={writes} pending={pending}>
      <StepHeader
        title={title}
        filename={batch.filename || "Pasted rows"}
        step={4}
        detail={
          <>
            {batch.committedCount.toLocaleString("en-US")} of {total.toLocaleString("en-US")} rows
            settled
            {batch.committedAt ? <>, {fmtStamp(batch.committedAt)}</> : null}.
          </>
        }
        actions={
          <Link href="/pipeline" className={buttonClass({ variant: "secondary", size: "sm" })}>
            Open the pipeline <ArrowRight aria-hidden="true" className="size-3" />
          </Link>
        }
      />

      <div className="mx-auto max-w-2xl px-4 py-4 sm:px-6">
        {/* The undo, while the SERVER's window is open. The button is a courtesy:
            `app_import_undo` reads `undo_expires_at` off the row and refuses on its
            own, so a stale tab and a wrong client clock get the same answer
            (matrix row 32). */}
        {batch.state === "rolled_back" ? (
          <p
            data-testid="undo-state"
            className="rounded-lg border border-border bg-raised p-3 text-xs text-text-2"
          >
            Everything this import wrote has been put back.
            {undone ? null : (
              <>
                {" "}
                Rows that had been edited since the import were left as they are. An undo never
                overwrites work done after it.
              </>
            )}
          </p>
        ) : undoable ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-raised p-3">
            <Button
              variant="secondary"
              disabled={!hydrated || pending > 0}
              data-testid="undo-import"
              onClick={() =>
                void runUndo({
                  batchId,
                  run,
                  onResult: setUndone,
                  onDone: () => router.refresh(),
                })
              }
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
              {pending > 0 ? "Undoing" : "Undo this import"}
            </Button>
            <p className="min-w-0 text-2xs text-muted">
              Removes the rows it added and puts the rows it changed back. Available until{" "}
              {fmtStamp(batch.undoExpiresAt)}.
            </p>
          </div>
        ) : null}

        {/* What the undo did AND what it declined to do. Silence about the second
            is the whole of matrix row 33: an undo that quietly leaves rows behind
            reads as one that failed, and one that quietly reverts an edit somebody
            made afterwards is worse. Stated even when the number is zero. */}
        {undone ? (
          <p
            role="status"
            data-testid="undo-report"
            className="mt-3 min-w-0 break-words rounded-lg border border-border bg-surface p-3 text-xs text-text-2"
          >
            {undoSummary(undone)}
          </p>
        ) : null}

        <section className="mt-4">
          <h2 className="text-xs font-semibold text-text">Every column in your file</h2>
          {report.length === 0 ? (
            <p data-testid="report-empty" className="mt-1.5 text-2xs text-muted">
              No columns to account for: nothing from this file was imported, so there is nothing
              that landed and nothing that was left behind.
            </p>
          ) : (
            <ul data-testid="report-columns" className="mt-1.5 space-y-1.5">
              {report.map((row) => (
                <li
                  key={`${row.column}-${row.disposition}`}
                  data-testid={`report-${row.disposition}-${row.column}`}
                  className="min-w-0 rounded-lg border border-border bg-surface p-3"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 break-words text-xs font-medium text-text">
                      {row.column}
                    </span>
                    <Badge tone={DISPOSITION_TONE[row.disposition] ?? "neutral"}>
                      {DISPOSITION_LABEL[row.disposition] ?? row.disposition}
                    </Badge>
                  </div>
                  <p className="mt-0.5 min-w-0 break-words text-2xs text-muted">
                    {explainDisposition(row)}
                  </p>
                  {row.sample.length > 0 ? (
                    <ul className="mt-1.5 flex min-w-0 flex-wrap gap-1">
                      {row.sample.map((sample, i) => (
                        <li
                          key={`${sample}-${i}`}
                          title={sample}
                          className="min-w-0 max-w-full truncate rounded border border-border
                                     bg-raised px-1.5 py-0.5 text-2xs text-text-2"
                        >
                          {sample}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </StepShell>
  );
}
