"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import {
  conflictCells,
  isFullyResolved,
  writableColumnLabel,
  type ConflictChoice,
} from "@/lib/import/round-trip";
import {
  explainMatchKind,
  matchKindLabel,
  type ImportMatchKind,
} from "@/lib/import/views";
import { cn } from "@/lib/utils";
import {
  previewImportAction,
  resolveImportRowAction,
  setImportRowsIncludedAction,
} from "./actions";
import type { PreviewRow } from "./prepare";
import { runCommit } from "./run";
import { StepHeader, StepShell, useHydrated } from "./step-shell";
import { useWrites } from "./use-writes";

/**
 * Step 2 — what committing would do, row by row, before anything is written.
 *
 * Everything on this screen is a decision the user can still take back, which is
 * the whole reason it exists. Three properties are load-bearing:
 *
 *   1. **Virtualized** (`@tanstack/react-virtual`). A 2,000-row preview that put
 *      2,000 rows in the DOM would make the tab unusable on a phone at the exact
 *      moment somebody is being asked to check it.
 *   2. **Every row is individually excludable.** The veto has to be per row,
 *      because "I want 39 of these 40" is the ordinary case and re-editing the
 *      spreadsheet to express it is not a workflow.
 *   3. **Commit is refused while any conflict is unresolved, and says why.** The
 *      DATABASE is what enforces that (`app_import_commit_chunk` raises while one
 *      exists, and the fixture reproduces it) — a UI-only guard is one bad deploy
 *      away from writing anyway. This button exists so nobody clicks something
 *      that will fail, not to be the rule (AC 23).
 *
 * The bucket counts are computed HERE over the INCLUDED rows rather than taken
 * from `previewImport`'s own counts, and that is deliberate: the server counts
 * every staged row, including the header row and the ones the user has skipped.
 * A card reading "41 will be added" over a list of 40 is the kind of small lie
 * that costs a person their trust in the whole feature.
 */

/** A row's resting height, before the measurer gets a real one. */
const ROW_PX = 68;

/**
 * Does this row carry a conflict at all.
 *
 * A named function rather than an inline `!== "none"` in the JSX: the copy lint
 * reads every string literal inside a JSX expression as words somebody will see,
 * and `conflictState`'s values are engine vocabulary that never reaches a screen.
 */
function isConflicted(row: PreviewRow) {
  return row.conflictState !== "none";
}

/** Buckets in the order a person should read them: additions, then the caveats. */
const BUCKET_ORDER: ImportMatchKind[] = [
  "new",
  "unkeyable",
  "matches-existing",
  "round-trip",
  "suggestion",
  "duplicate-in-file",
];

export default function PreviewStep({
  batchId,
  filename,
  rows: initial,
  headerRowsSkipped,
  roundTrip,
}: {
  batchId: string;
  filename: string;
  rows: PreviewRow[];
  /** Rows at or above the header row. Never imported; stated rather than hidden. */
  headerRowsSkipped: number;
  roundTrip: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { pending, writes, run } = useWrites();
  const [rows, setRows] = React.useState(initial);
  // Re-seeded whenever the server sends a new list — after a re-check, or after
  // a resolve that changed what a row would do.
  React.useEffect(() => {
    setRows(initial);
  }, [initial]);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    overscan: 10,
    // Sized before the scroll element mounts, so the server (and the first client
    // render, identically — no hydration mismatch) emits a real viewport of rows
    // instead of an empty list that pops in after hydration. The jobs grid records
    // the same reason, including that an empty rowgroup is its own axe violation.
    initialRect: { width: 1024, height: 600 },
  });

  const included = React.useMemo(() => rows.filter((r) => r.included), [rows]);
  const buckets = React.useMemo(() => {
    const counts = new Map<ImportMatchKind, number>();
    for (const row of included) counts.set(row.matchKind, (counts.get(row.matchKind) ?? 0) + 1);
    return BUCKET_ORDER.filter((k) => counts.has(k)).map((k) => ({ kind: k, count: counts.get(k)! }));
  }, [included]);
  const unresolved = React.useMemo(
    () => included.filter((r) => r.conflictState === "unresolved"),
    [included],
  );

  const patch = (rowNumber: number, next: Partial<PreviewRow>) =>
    setRows((current) => current.map((r) => (r.rowNumber === rowNumber ? { ...r, ...next } : r)));

  const toggleIncluded = async (row: PreviewRow) => {
    const included = !row.included;
    patch(row.rowNumber, { included });
    let result;
    try {
      result = await run(() =>
        setImportRowsIncludedAction({ batchId, rowNumbers: [row.rowNumber], included }),
      );
    } catch {
      // Reverted, never left showing a state the server does not hold (matrix
      // row 8: a failed write must not leave a phantom on screen).
      patch(row.rowNumber, { included: row.included });
      toast.error("That did not save. The server did not answer.", {
        action: { label: "Retry", onClick: () => void toggleIncluded(row) },
      });
      return;
    }
    if (!result.ok) {
      patch(row.rowNumber, { included: row.included });
      toast.error(result.kind === "auth" ? "Your session expired" : "That did not save.", {
        description: result.message,
      });
    }
  };

  const recheck = async () => {
    try {
      const result = await run(() => previewImportAction(batchId));
      if (!result.ok) {
        toast.error(result.kind === "auth" ? "Your session expired" : "The re-check failed.", {
          description: result.message,
        });
        return;
      }
    } catch {
      toast.error("The re-check stopped waiting for the server.");
      return;
    }
    router.refresh();
  };

  const commit = () => {
    void runCommit({
      batchId,
      run,
      // ONE chunk, then hand over. The batch's state decides the step, so the
      // refresh renders whichever comes next — the commit screen if rows remain
      // (it owns the loop and the progress bar), the report if they do not.
      // Looping from here and refreshing as it went would mount the commit screen
      // mid-flight and start a second loop over the same batch.
      once: true,
      onDone: () => router.refresh(),
      onProgressDone: () => router.refresh(),
    });
  };

  const busy = pending > 0;
  const nothingToDo = included.length === 0;

  return (
    <StepShell step="preview" ready={hydrated} writes={writes} pending={pending}>
      <StepHeader
        title="What this would do"
        filename={filename}
        step={2}
        detail={
          <>
            {included.length.toLocaleString("en-US")} of {rows.length.toLocaleString("en-US")}{" "}
            {rows.length === 1 ? "row" : "rows"} will be imported
            {headerRowsSkipped > 0 ? (
              <>
                {" "}
                ({headerRowsSkipped === 1 ? "1 row" : `${headerRowsSkipped} rows`} at the top of the
                file {headerRowsSkipped === 1 ? "holds" : "hold"} the column names and{" "}
                {headerRowsSkipped === 1 ? "is" : "are"} not imported)
              </>
            ) : null}
            . Nothing has been written yet.
          </>
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            disabled={!hydrated || busy}
            onClick={() => void recheck()}
            data-testid="preview-recheck"
          >
            <RefreshCw aria-hidden="true" className="size-3.5" /> Re-check
          </Button>
        }
      />

      <div className="min-w-0 px-4 py-4 sm:px-6">
        {roundTrip ? (
          <p className="mb-3 rounded-lg border border-border bg-raised p-3 text-xs text-text-2">
            This file came from this app. Rows
            are matched by the tracking columns the export added, so your Excel edits go back to the
            rows they came from. Everything the system owns (company, title, URL, tags) is compared
            and reported, never overwritten.
          </p>
        ) : null}

        {/* Per bucket: the label, the count, and what will happen. `suggestion` is
            the one worth reading twice — it says the system cannot PROVE two rows
            are the same job, which is the honest description of a weak key. */}
        <ul data-testid="preview-buckets" className="grid gap-2 sm:grid-cols-2">
          {buckets.map(({ kind, count }) => (
            <li
              key={kind}
              data-testid={`bucket-${kind}`}
              className="min-w-0 rounded-lg border border-border bg-surface p-3"
            >
              <p className="min-w-0 break-words text-xs font-medium text-text">
                <span className="tabular">{count.toLocaleString("en-US")}</span>{" "}
                {matchKindLabel(kind)}
              </p>
              <p className="mt-0.5 min-w-0 break-words text-2xs text-muted">
                {explainMatchKind(kind)}
              </p>
            </li>
          ))}
        </ul>

        {unresolved.length > 0 ? (
          <p
            role="alert"
            data-testid="preview-conflict-warning"
            className="mt-3 flex items-start gap-1.5 rounded-lg border border-warn-subtle
                       bg-warn-subtle/40 p-3 text-xs text-text"
          >
            <AlertTriangle aria-hidden="true" className="mt-px size-4 shrink-0 text-warn" />
            <span className="min-w-0 break-words">
              {unresolved.length === 1
                ? "1 row was edited by somebody else after your file was exported"
                : `${unresolved.length} rows were edited by somebody else after your file was exported`}
              . Each one is marked below: open it, say which value wins per cell, and this import
              can go ahead. Nothing will be written until they are all answered.
            </span>
          </p>
        ) : null}

        {/* The list scrolls INSIDE this box. A list that scrolled the page would
            put the Commit button 2,000 rows away. */}
        <div
          ref={scrollRef}
          data-testid="preview-rows"
          className="mt-3 max-h-[60vh] min-w-0 overflow-y-auto rounded-lg border border-border bg-surface"
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              const conflicted = isConflicted(row);
              return (
                <div
                  key={row.rowNumber}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  // `top`, never `translateY`: a transform makes the row a
                  // containing block, which silently breaks anything sticky or
                  // portalled inside it (matrix row 48's lesson).
                  style={{ position: "absolute", top: item.start, left: 0, right: 0 }}
                  className={cn(
                    "min-w-0 border-b border-border px-3 py-2",
                    // Exclusion is a row state, shown by the checkbox and a
                    // neutral surface change. Opacity would also dim every word
                    // inside the row, which the design explicitly forbids.
                    row.included ? "" : "bg-raised",
                  )}
                  data-testid={`preview-row-${row.rowNumber}`}
                >
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <div className="min-w-0 grow basis-48">
                      <p className="min-w-0 break-words text-xs font-medium text-text">
                        <span className="tabular mr-1.5 text-2xs text-muted">
                          {row.rowNumber}
                        </span>
                        {row.company || <span className="text-warn">no company</span>}
                      </p>
                      <p className="min-w-0 break-words text-2xs text-text-2">
                        {row.title || <span className="text-warn">no job title</span>}
                        {row.status ? <>, {row.status}</> : null}
                      </p>
                      {row.notice ? (
                        <p className="mt-0.5 min-w-0 break-words text-2xs text-muted">
                          {row.notice}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <Badge
                        tone={
                          row.matchKind === "suggestion"
                            ? "warn"
                            : row.matchKind === "duplicate-in-file"
                              ? "neutral"
                              : row.matchKind === "matches-existing" || row.matchKind === "round-trip"
                                ? "info"
                                : "accent"
                        }
                        title={explainMatchKind(row.matchKind)}
                      >
                        {matchKindLabel(row.matchKind)}
                      </Badge>
                      {conflicted ? (
                        <ConflictDialog
                          batchId={batchId}
                          row={row}
                          disabled={!hydrated || busy}
                          run={run}
                          onResolved={(choices) =>
                            patch(row.rowNumber, { conflictState: "resolved", choices })
                          }
                        />
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!hydrated || busy}
                        onClick={() => void toggleIncluded(row)}
                        data-testid={`preview-skip-${row.rowNumber}`}
                      >
                        {row.included ? "Skip" : "Include"}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={!hydrated || busy || unresolved.length > 0 || nothingToDo}
            onClick={commit}
            data-testid="preview-commit"
          >
            {busy ? "Importing" : `Import ${included.length.toLocaleString("en-US")}`}
          </Button>
          {/* The reason, out loud, next to the disabled button. */}
          {unresolved.length > 0 ? (
            <p role="status" data-testid="preview-commit-blocked" className="min-w-0 text-2xs text-warn">
              {unresolved.length === 1
                ? "1 row still needs an answer"
                : `${unresolved.length} rows still need an answer`}{" "}
              before anything can be imported. Importing now would overwrite an edit somebody else
              made.
            </p>
          ) : nothingToDo ? (
            <p role="status" className="min-w-0 text-2xs text-warn">
              Every row is skipped, so there is nothing to import. Include at least one.
            </p>
          ) : null}
        </div>
      </div>
    </StepShell>
  );
}

/**
 * One conflicted round-trip row, cell by cell — in a Radix `Dialog`.
 *
 * Radix owns the focus trap, the restore target, `aria-modal`, Escape and the
 * scroll lock; every one of those is invisible when it works and a keyboard dead
 * end when it does not (matrix row 119). The choices themselves are native radio
 * inputs rather than a custom widget: two mutually exclusive options with a group
 * label is exactly what a radio group is for, and nothing bespoke does it better.
 */
function ConflictDialog({
  batchId,
  row,
  disabled,
  run,
  onResolved,
}: {
  batchId: string;
  row: PreviewRow;
  disabled?: boolean;
  run: <T>(send: () => Promise<T>) => Promise<T>;
  onResolved: (choices: Record<string, ConflictChoice>) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [choices, setChoices] = React.useState<Record<string, ConflictChoice>>(
    () => ({ ...row.choices }) as Record<string, ConflictChoice>,
  );
  const [saving, setSaving] = React.useState(false);
  const cells = conflictCells(row.conflict);
  const complete = isFullyResolved(row.conflict, choices);
  const resolved = row.conflictState === "resolved";

  const save = async () => {
    setSaving(true);
    let result;
    try {
      result = await run(() =>
        resolveImportRowAction({ batchId, rowNumber: row.rowNumber, choices }),
      );
    } catch {
      setSaving(false);
      toast.error("That answer did not save. The server did not answer.", {
        action: { label: "Retry", onClick: () => void save() },
      });
      return;
    }
    setSaving(false);
    if (!result.ok) {
      toast.error(result.kind === "auth" ? "Your session expired" : "That answer did not save.", {
        description: result.message,
      });
      return;
    }
    onResolved(choices);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        disabled={disabled}
        data-testid={`preview-resolve-${row.rowNumber}`}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs font-medium",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          resolved
            ? "border-border bg-raised text-text-2"
            : "border-warn-subtle bg-warn-subtle text-warn",
        )}
      >
        {resolved ? "Answered" : "Needs you"}
      </DialogTrigger>
      <DialogContent
        title={`Row ${row.rowNumber} changed on both sides`}
        description={`${row.company || "This row"}: pick which value wins for each field. Everything you leave as "what it says now" is left exactly as it is.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              // Disabled until every cell is answered. `isFullyResolved` is the
              // same function the commit gate uses, so the two cannot disagree.
              disabled={!complete || saving}
              onClick={() => void save()}
              data-testid={`resolve-save-${row.rowNumber}`}
            >
              {saving ? "Saving" : "Save answers"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {cells.map((cell) => (
            <fieldset key={cell.column} className="min-w-0">
              <legend className="text-xs font-medium text-text">
                {writableColumnLabel(cell.column)}
              </legend>
              <div className="mt-1 space-y-1">
                {(["mine", "theirs"] as const).map((side) => (
                  <label
                    key={side}
                    className="flex min-w-0 items-start gap-2 rounded-md border border-border
                               bg-raised px-2 py-1.5 text-2xs"
                  >
                    <input
                      type="radio"
                      name={`${row.rowNumber}-${cell.column}`}
                      value={side}
                      checked={choices[cell.column] === side}
                      data-testid={`resolve-${row.rowNumber}-${cell.column}-${side}`}
                      onChange={() =>
                        setChoices((current) => ({ ...current, [cell.column]: side }))
                      }
                      className="mt-0.5 size-3.5 shrink-0"
                    />
                    <span className="min-w-0 break-words">
                      <span className="font-medium text-text">
                        {side === "mine" ? "What it says now" : "What your file says"}
                      </span>
                      <span className="block text-text-2">
                        {(side === "mine" ? cell.mine : cell.theirs) || "(empty)"}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
