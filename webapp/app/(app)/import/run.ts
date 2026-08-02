"use client";

import { toast } from "sonner";
import type { ImportBatchView } from "@/lib/import/views";
import {
  commitImportChunkAction,
  undoImportAction,
  type CommitActionResult,
  type UndoActionResult,
} from "./actions";
import type { Bounded } from "./use-writes";

/**
 * The commit loop and the undo, in one place because both are driven from two
 * screens.
 *
 * The Commit button on the review screen runs the first chunk; the commit screen
 * runs the rest, including after a reload. Two copies of the loop would be two
 * places for the retry rule to rot, and the retry rule is the subtle part:
 *
 * **A retry reuses the SAME idempotency key; a NEW chunk mints a new one.**
 * Minting a fresh key per retry is what makes a request whose response was lost —
 * the bound above, a dropped connection, a deploy mid-flight — apply a SECOND
 * time (matrix row 136). A new chunk is a different command and must not replay
 * the previous one's stored answer.
 */

/**
 * Rows per transaction.
 *
 * 200, not 2,000: one transaction over a whole file invites a statement timeout
 * and gives nothing back when it hits one. Chunks always make progress, and
 * `committedCount` is the cursor a reload resumes from.
 */
export const COMMIT_CHUNK = 200;

const AUTH_TITLE = "Your session expired";

type CommitOk = Extract<CommitActionResult, { ok: true }>;
type UndoOk = Extract<UndoActionResult, { ok: true }>;

export type CommitOptions = {
  batchId: string;
  /** Bounded, serialized, counted — see `use-writes.ts`. */
  run: Bounded;
  /** Called after every chunk, so the bar can move. */
  onProgress?: (result: CommitOk) => void;
  /** Called once the batch has nothing pending. The caller refreshes here. */
  onDone?: (result: CommitOk) => void;
  /**
   * Stop after one chunk that leaves rows pending.
   *
   * The review screen's Import button uses this: it commits the first chunk and
   * then refreshes, and the batch — now `committing` — renders the commit screen,
   * which owns the rest of the loop and the progress bar. Running the whole loop
   * from the review screen and refreshing as it went would mount the commit screen
   * mid-flight, and its own resume would then be a SECOND loop over the same
   * batch.
   */
  once?: boolean;
  /** `once` only: rows are still pending, and the caller should hand over. */
  onProgressDone?: (result: CommitOk) => void;
  /** Internal: the key of a chunk being retried. Never passed by a first call. */
  key?: string;
};

export async function runCommit(options: CommitOptions): Promise<void> {
  let key = options.key ?? crypto.randomUUID();

  for (;;) {
    let result: CommitActionResult;
    try {
      result = await options.run(() =>
        commitImportChunkAction({
          batchId: options.batchId,
          limit: COMMIT_CHUNK,
          idempotencyKey: key,
        }),
      );
    } catch {
      toast.error("The import stopped waiting for the server.", {
        description:
          "Whatever had already been imported stays imported. Picking it up again carries on from there.",
        // The SAME key: this chunk may well have landed and lost its answer.
        action: { label: "Keep importing", onClick: () => void runCommit({ ...options, key }) },
      });
      return;
    }

    if (!result.ok) {
      toast.error(result.kind === "auth" ? AUTH_TITLE : "The import stopped.", {
        description: result.message,
        action: { label: "Try again", onClick: () => void runCommit({ ...options, key }) },
      });
      return;
    }

    options.onProgress?.(result);
    if (result.remaining === 0) {
      importedToast(result, options);
      options.onDone?.(result);
      return;
    }
    if (options.once) {
      options.onProgressDone?.(result);
      return;
    }
    // A different chunk is a different command.
    key = crypto.randomUUID();
  }
}

/** "Imported 40" — with Undo, mirroring the queue's decision toast. */
function importedToast(result: CommitOk, options: CommitOptions): void {
  const bits: string[] = [];
  if (result.created > 0) bits.push(`${result.created} added`);
  if (result.updated > 0) bits.push(`${result.updated} updated`);
  if (result.skipped > 0) bits.push(`${result.skipped} skipped`);
  if (result.failed > 0) bits.push(`${result.failed} failed`);

  toast.success(bits.length > 0 ? `Imported: ${bits.join(", ")}` : "Nothing left to import", {
    description:
      "The report below says what happened to every column. You can undo the whole import for 24 hours.",
    // Longer than the default: this is the one toast whose action a person may
    // want to think about before pressing.
    duration: 12_000,
    action: {
      label: "Undo",
      onClick: () => void runUndo({ batchId: options.batchId, run: options.run }),
    },
  });
}

export type UndoOptions = {
  batchId: string;
  run: Bounded;
  /** Lets a screen render the summary in place, not only in a toast. */
  onResult?: (result: UndoOk) => void;
  onDone?: () => void;
  key?: string;
};

export async function runUndo(options: UndoOptions): Promise<void> {
  const key = options.key ?? crypto.randomUUID();
  let result: UndoActionResult;
  try {
    result = await options.run(() =>
      undoImportAction({ batchId: options.batchId, idempotencyKey: key }),
    );
  } catch {
    toast.error("The undo stopped waiting for the server.", {
      description: "Nothing else was changed. Trying again is safe.",
      // The same key, so an undo whose answer was lost is not performed twice.
      action: { label: "Try again", onClick: () => void runUndo({ ...options, key }) },
    });
    return;
  }

  if (!result.ok) {
    toast.error(result.kind === "auth" ? AUTH_TITLE : "That import was not undone.", {
      description: result.message,
      action: { label: "Try again", onClick: () => void runUndo({ ...options, key }) },
    });
    return;
  }

  options.onResult?.(result);
  toast.success("Import undone", { description: undoSummary(result), duration: 12_000 });
  options.onDone?.();
}

/**
 * What the undo did — and, load-bearing, **what it declined to do**.
 *
 * `kept` is a row somebody edited after the import landed, and reverting it would
 * throw away work nobody asked to lose. `notesKept` is the imported notes on rows
 * that survived, which stay because `application_notes` is append-only and undoing
 * an import is not a licence to delete history.
 *
 * Both are stated even when they are zero. Silence there is the whole of matrix
 * row 33: an undo that quietly leaves rows behind reads as an undo that failed,
 * and an undo that quietly deletes an edit is worse.
 */
export function undoSummary(result: UndoOk): string {
  const parts: string[] = [];
  parts.push(
    result.deleted === 1 ? "1 imported row removed" : `${result.deleted} imported rows removed`,
  );
  if (result.reverted > 0) {
    parts.push(
      result.reverted === 1 ? "1 row put back as it was" : `${result.reverted} rows put back as they were`,
    );
  }
  let text = `${parts.join(", ")}.`;

  if (result.kept > 0) {
    const ids = result.keptIds.length > 0 ? ` (${result.keptIds.map((id) => `#${id}`).join(", ")})` : "";
    text +=
      ` ${result.kept === 1 ? "1 row was" : `${result.kept} rows were`} left exactly as they are${ids}` +
      ". They changed after the import, and putting them back would throw away that change.";
  } else {
    text += " Nothing was left behind: no imported row had been touched since.";
  }

  if (result.notesKept > 0) {
    text += ` ${result.notesKept === 1 ? "1 imported note stays" : `${result.notesKept} imported notes stay`} in the history. Notes are only ever added, never deleted.`;
  }
  return text;
}

/** The batch as the caller last saw it, for a screen that renders a progress bar. */
export type ProgressBatch = Pick<
  ImportBatchView,
  "committedCount" | "stagedCount" | "rowCount" | "state"
>;
