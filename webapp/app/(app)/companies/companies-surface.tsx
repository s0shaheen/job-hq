"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";
import type { BulkReviewResult, CompanyFlagsResult } from "@/lib/data/source";
import type { CompanyView, ReviewState } from "@/lib/data/view-models";
import CompaniesGrid from "./companies-grid";
import CoverageMeter from "./coverage-meter";
import ReviewBar from "./review-bar";
import SweepToggle from "./sweep-toggle";
import ViewSwitcher from "./view-switcher";
import { setCompanyFlagsAction, setCompanyReviewAction } from "./actions";

/**
 * The write layer over the universe grid: optimistic review decisions, one undo,
 * and the honest failure branches.
 *
 * It is a separate component from `companies-grid.tsx` on purpose. The grid owns
 * URL state, virtualization and selection — all of which are about *display* — and
 * this owns the gestures. Keeping them apart is what let the grid be written
 * without a store and lets this be read as "what happens when someone decides".
 *
 * Two rules carried over from the triage queue, because they are the same rules:
 *
 *   * **A conflict reverts EVERYTHING.** `app_set_company_review_bulk` is atomic,
 *     so if the store applied none of the batch, the screen must show none of it —
 *     leaving some rows looking decided while the database holds nothing is the
 *     half-applied screen the transaction exists to rule out. The rows come back;
 *     the HIGHLIGHT does not, because the optimistic patch moved them out of the
 *     working set and `pruneSelection` permanently drops keys a filter hides
 *     (matrix row 72, working as designed). Retry therefore lives on the toast,
 *     which carries the original targets — one click, from there.
 *   * **The server's rows win, not the optimistic guesses.** Their `updatedAt` is
 *     what makes the undo batch conflict-checkable (the stale-object lesson, N-wide).
 *
 * What is deliberately NOT ported from /jobs: the offline outbox. `lib/outbox.ts`
 * speaks single-POSTING triage gestures — its queue shape, its replay and its
 * "delivered" bookkeeping are all `TriageInput` — and widening it to a second
 * entity is its own change with its own failure modes, not a line in this file. So
 * an undeliverable review says so and reverts, which is honest, rather than
 * claiming a durability this path does not have. Recorded as a known gap.
 */

/** Same window as the queue's and /jobs' — one undo vocabulary everywhere. */
const UNDO_MS = 8000;

function verbLabel(state: ReviewState, rows: CompanyView[]): string {
  const who =
    rows.length === 1
      ? rows[0].name.trim() || rows[0].slug || "1 company"
      : `${rows.length} companies`;
  if (state === "approved") return `Added ${who} to your universe`;
  if (state === "dismissed") return `Passed on ${who}`;
  return `Moved ${who} back to review`;
}

export default function CompaniesSurface({ rows }: { rows: CompanyView[] }) {
  const router = useRouter();

  // Optimistic overlay. The server list stays the base (so router.refresh() keeps
  // working); a write patches rows by key on top of it. The FRESHER version wins on
  // merge: after a refresh the server may already hold what a patch was holding —
  // or newer, from another device — and an optimistic overlay must never beat a
  // fresher read.
  const [patches, setPatches] = React.useState<ReadonlyMap<string, CompanyView>>(new Map());
  const effRows = React.useMemo(() => {
    if (patches.size === 0) return rows;
    return rows.map((r) => {
      const p = patches.get(r.key);
      if (!p) return r;
      if (r.updatedAt !== null && p.updatedAt !== null && r.updatedAt > p.updatedAt) return r;
      return p;
    });
  }, [rows, patches]);

  const patchRows = React.useCallback((next: CompanyView[]) => {
    setPatches((p) => {
      const merged = new Map(p);
      for (const r of next) merged.set(r.key, r);
      return merged;
    });
  }, []);

  /** Put back exactly what a key held before the gesture — including "no patch at
   *  all", which deleting alone would get wrong for a row an earlier gesture had
   *  already patched. */
  const restorePatches = React.useCallback(
    (snapshot: ReadonlyArray<readonly [string, CompanyView | undefined]>) => {
      setPatches((p) => {
        const merged = new Map(p);
        for (const [k, v] of snapshot) {
          if (v === undefined) merged.delete(k);
          else merged.set(k, v);
        }
        return merged;
      });
    },
    [],
  );

  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false);
  const patchesRef = React.useRef(patches);
  patchesRef.current = patches;

  /** The last delivered batch, for the bar's Undo. Cleared once it is spent. */
  const [lastBatch, setLastBatch] = React.useState<{
    written: CompanyView[];
    priors: CompanyView[];
  } | null>(null);

  /**
   * The ONE undo for a delivered batch: the inverse batch, a fresh idempotency key,
   * guarded by the `updatedAt` values the delivery returned. Rows whose prior states
   * DIFFERED partition by prior state — almost always one group, since the review
   * set is all-proposed by definition.
   */
  const undoBatch = React.useCallback(
    async (written: CompanyView[], priors: CompanyView[]) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setLastBatch(null);

      const groups = new Map<ReviewState, { written: CompanyView[]; priors: CompanyView[] }>();
      for (let i = 0; i < written.length; i++) {
        const state = priors[i].reviewState;
        let g = groups.get(state);
        if (!g) groups.set(state, (g = { written: [], priors: [] }));
        g.written.push(written[i]);
        g.priors.push(priors[i]);
      }

      for (const [state, g] of groups) {
        let res: BulkReviewResult;
        try {
          res = await setCompanyReviewAction({
            companyIds: g.written.map((c) => c.id),
            reviewState: state,
            idempotencyKey: crypto.randomUUID(),
            expectedUpdatedAt: g.written.map((c) => c.updatedAt),
          });
        } catch {
          toast.error("Couldn't undo. The server didn't answer.", {
            description: "Reload to see where the decision landed.",
          });
          continue;
        }
        if (res.ok) {
          patchRows(res.companies);
          continue;
        }
        if (res.kind === "auth") {
          toast.error("Couldn't undo. Your session expired.", {
            description: "Sign in and try again.",
          });
        } else if (res.kind === "conflict") {
          toast.warning("Couldn't undo. This was changed somewhere else.");
          router.refresh();
        } else {
          toast.error("Couldn't undo that.", { description: res.message });
        }
      }

      busyRef.current = false;
      setBusy(false);
    },
    [patchRows, router],
  );

  /**
   * One review decision, N rows, one transaction, one undo.
   *
   * `targets` is passed in from the grid's own selected-rows array, which is
   * order-intersected against the visible leaves — so a row a filter or a search
   * just hid cannot ride along in the write. That is the second of
   * `selection.ts`'s two independent enforcements, and it is why this function
   * never reads the selection itself.
   */
  const decide = React.useCallback(
    async (targets: CompanyView[], state: ReviewState, clearSelection: () => void) => {
      if (busyRef.current || targets.length === 0) return;
      busyRef.current = true;
      setBusy(true);

      const priors = targets.map((c) => ({ ...c }));
      const patchSnapshot = targets.map((c) => [c.key, patchesRef.current.get(c.key)] as const);
      const enabled = state === "approved";
      patchRows(targets.map((c) => ({ ...c, reviewState: state, enabled })));

      let result: BulkReviewResult;
      try {
        result = await setCompanyReviewAction({
          companyIds: targets.map((c) => c.id),
          reviewState: state,
          idempotencyKey: crypto.randomUUID(),
          expectedUpdatedAt: targets.map((c) => c.updatedAt),
        });
      } catch {
        // No outbox on this path (see the module comment): an undeliverable review
        // reverts and says so, rather than claiming a durability it does not have.
        restorePatches(patchSnapshot);
        busyRef.current = false;
        setBusy(false);
        toast.error("Couldn't save that. You may be offline.", {
          description: "Nothing was changed. Try again when you're back.",
        });
        return;
      }

      busyRef.current = false;
      setBusy(false);

      if (result.ok) {
        // The server's rows, not the optimistic guesses.
        patchRows(result.companies);
        const written = result.companies;
        setLastBatch({ written, priors });
        clearSelection();
        // What the write ACTUALLY did. The first version of this copy promised
        // "the next scan will pull jobs from these" and "discovery won't propose
        // these again" — neither of which is wired: discovery is
        // `monitor/run.py`, it reads the Companies tab, and nothing on the Python
        // side reads `review_state` or `monitor` out of this table yet. A toast
        // that describes a consequence the system does not produce is the kind of
        // claim this repo spends its comments ruling out.
        toast(verbLabel(state, targets), {
          description:
            state === "approved"
              ? "Recorded here. Discovery honouring it comes later."
              : "Recorded, so it stays out of the review pile.",
          action: { label: "Undo", onClick: () => void undoBatch(written, priors) },
          duration: UNDO_MS,
        });
        return;
      }

      // All-or-nothing came back as nothing: every row reverts, including the ones
      // that would have succeeded alone. Retry rides on the toast rather than on the
      // selection — see the module comment.
      restorePatches(patchSnapshot);
      if (result.kind === "conflict") {
        toast.warning("Changed on another device. Nothing was applied; showing the latest.");
        router.refresh();
        return;
      }
      if (result.kind === "auth") {
        toast.error("Couldn't save that. Your session expired.", {
          description: "Sign in and try again.",
        });
        return;
      }
      toast.error("Couldn't save that.", {
        description: result.message,
        action: { label: "Retry", onClick: () => void decide(targets, state, clearSelection) },
      });
    },
    [patchRows, restorePatches, undoBatch, router],
  );

  /**
   * The per-row sweep flag — the ONE caller of `app_set_company_flags`.
   *
   * Single-row, single-flag, and the same contract as everything else on this
   * surface: an optimistic patch, the version token the row was read at, the
   * server's row winning on success, and a full revert on any failure. No undo
   * toast: the control is its own inverse, one click away and visible.
   *
   * The conflict branch takes the row the SERVER returned rather than reverting
   * blind — that is the stale-object lesson, and `setCompanyFlags` is the one
   * result shape that carries `current` for exactly this.
   */
  const toggleSweep = React.useCallback(
    async (company: CompanyView, next: boolean) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      const before = patchesRef.current.get(company.key);
      patchRows([{ ...company, enabled: next }]);

      let res: CompanyFlagsResult;
      try {
        res = await setCompanyFlagsAction({
          companyId: company.id,
          enabled: next,
          priority: company.priority,
          idempotencyKey: crypto.randomUUID(),
          expectedUpdatedAt: company.updatedAt,
        });
      } catch {
        restorePatches([[company.key, before]]);
        busyRef.current = false;
        setBusy(false);
        toast.error("Couldn't change that. You may be offline.", {
          description: "Nothing was changed. Try again when you're back.",
        });
        return;
      }

      busyRef.current = false;
      setBusy(false);

      if (res.ok) {
        patchRows([res.company]);
        return;
      }
      if (res.kind === "conflict") {
        // The server's row, not the one we optimistically drew and not the one we
        // read: a revert to the captured value would put the screen back to a
        // state the store has already moved past.
        patchRows([res.current]);
        toast.warning("Changed on another device. Showing the latest.");
        return;
      }
      restorePatches([[company.key, before]]);
      if (res.kind === "auth") {
        toast.error("Couldn't change that. Your session expired.", {
          description: "Sign in and try again.",
        });
        return;
      }
      toast.error("Couldn't change that.", { description: res.message });
    },
    [patchRows, restorePatches],
  );

  // The keyboard verbs. Bound here rather than in the grid because they are WRITES:
  // the grid's own handler owns movement and selection and knows nothing about the
  // store. Guards are the queue's, verbatim — a modal owns the keyboard, and typing
  // in a field is text (matrix rows 34 and 78).
  //
  // Fed by `onSelectionChange`, which fires on the EMPTY selection too. Reading the
  // selection out of the `bulkBar` render prop instead would leave this ref holding
  // the last non-empty set after a Clear, and the next `a` would decide rows the
  // user can no longer see highlighted.
  const selectedRef = React.useRef<{ rows: CompanyView[]; clear: () => void }>({
    rows: [],
    clear: () => {},
  });
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]',
        )
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const { rows: sel, clear } = selectedRef.current;
      // With nothing selected these keys stay inert. A stray keypress deciding the
      // row under the cursor would be a decision nobody made.
      if (sel.length === 0) return;
      const key = e.key.toLowerCase();
      if (key === "a") {
        e.preventDefault();
        void decide(sel, "approved", clear);
      } else if (key === "x") {
        e.preventDefault();
        void decide(sel, "dismissed", clear);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide]);

  return (
    <CompaniesGrid
      rows={effRows}
      toolbarExtras={({ set, sort }) => <ViewSwitcher set={set} sort={sort} />}
      aboveGrid={({ allRows }) => <CoverageMeter rows={allRows} />}
      sweepCell={(company) => (
        <SweepToggle company={company} busy={busy} onToggle={(c, next) => void toggleSweep(c, next)} />
      )}
      onSelectionChange={({ selected, clear }) => {
        selectedRef.current = { rows: selected, clear };
      }}
      bulkBar={({ selected, clear }) => (
        <ReviewBar
          count={selected.length}
          busy={busy}
          onUndo={
            lastBatch ? () => void undoBatch(lastBatch.written, lastBatch.priors) : undefined
          }
          onApprove={() => void decide(selected, "approved", clear)}
          onDismiss={() => void decide(selected, "dismissed", clear)}
          onClear={clear}
        />
      )}
    />
  );
}
