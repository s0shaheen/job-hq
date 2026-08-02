"use client";

/**
 * The Jobs write path, lifted out of the chrome that used to hold it.
 *
 * 07 §1 is the governing rule for the whole redesign: writes go only through
 * the existing RPC layer, carrying idempotency keys; optimistic with undo;
 * deferrals kept, conflicts reverted. **The redesign changes what controls look
 * like, never how they write.** So this module is a MOVE, not a rewrite — every
 * branch below came from the original grid and behaves identically. It lives here
 * so the new table can reuse it verbatim instead of growing a second copy, and
 * so that when the old grid is deleted at cutover the machinery survives the
 * deletion of its first host.
 *
 * Two rules carried over from the queue, because they are the same rules:
 *
 *   1. Every gesture is optimistic with an honest failure path. A conflict
 *      reverts EVERYTHING — the batch is atomic in the store, so the screen
 *      must be too, including the rows that would have succeeded alone.
 *   2. An undeliverable decision is HELD in the outbox, never silently dropped.
 *      The outbox speaks single-row gestures, so a deferred batch rides as N
 *      entries under derived keys; the flush delivers them row by row, which
 *      forfeits atomicity but not the decisions. The atomic path needed the
 *      server, and the server is the thing we could not reach.
 *
 * The caller owns the WORDS. `decide()` takes its toast label as a parameter
 * rather than building one, because the label is dictionary vocabulary (02 §6)
 * and the dictionary lives at the surface, not in the write path.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setTriageAction } from "@/app/(app)/queue/actions";
import type { BulkTriageInput, BulkWriteResult, WriteResult } from "@/lib/data/source";
import type { JobView, Triage } from "@/lib/data/view-models";
import { dequeue, enqueue, takeDelivered } from "@/lib/outbox";
import { setTriageBulkAction } from "./bulk-actions";

/** Same window as the queue's — one undo vocabulary everywhere. */
export const UNDO_MS = 8000;

/** How far ahead "Later" parks a row. The queue's number, unchanged. */
export const SNOOZE_DAYS = 3;

export type DecideOptions = {
  /** The rows this gesture acts on, in display order. */
  targets: JobView[];
  /** Wake date for a "Later" decision; ignored for every other value. */
  snooze?: string;
  /** The toast headline. Dictionary words, supplied by the surface (02 §6). */
  label: string;
  /** Undo labels for the deferred (outbox) path, one per target. */
  undoLabel: (job: JobView) => string;
  /**
   * Called when the write came back as nothing and the screen must revert.
   * The surface restores whatever it snapshotted (its selection, typically);
   * the row patches are restored here, since this module owns them.
   */
  onRevert?: () => void;
};

export type DecisionsApi = {
  /** The server rows with the optimistic overlay applied. */
  effRows: JobView[];
  /** Apply an optimistic (or server-returned) version of some rows. */
  patchRows: (next: JobView[]) => void;
  /** True while a batch is in flight. Disables the controls; not a spinner. */
  busy: boolean;
  decide: (triage: Triage, options: DecideOptions) => Promise<void>;
};

export function useDecisions(rows: JobView[]): DecisionsApi {
  const router = useRouter();

  // Optimistic overlay. The server list stays the base (so router.refresh()
  // keeps working for saved-view flows); a write patches rows by key on top of
  // it. The fresher version wins on merge: after a refresh the server may
  // already hold what a patch was holding — or newer, from another device —
  // and an optimistic overlay must never beat a fresher read.
  const [patches, setPatches] = React.useState<ReadonlyMap<string, JobView>>(new Map());
  const patchesRef = React.useRef(patches);
  patchesRef.current = patches;

  const effRows = React.useMemo(() => {
    if (patches.size === 0) return rows;
    return rows.map((r) => {
      const p = patches.get(r.key);
      if (!p) return r;
      if (r.updatedAt !== null && p.updatedAt !== null && r.updatedAt > p.updatedAt) return r;
      return p;
    });
  }, [rows, patches]);

  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false);

  const patchRows = React.useCallback((next: JobView[]) => {
    setPatches((p) => {
      const merged = new Map(p);
      for (const r of next) merged.set(r.key, r);
      return merged;
    });
  }, []);

  /** Put back exactly what a key held before the gesture — including "no patch
   *  at all", which deleting alone would get wrong for a row an earlier gesture
   *  had already patched. */
  const restorePatches = React.useCallback(
    (snapshot: ReadonlyArray<readonly [string, JobView | undefined]>) => {
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

  /**
   * Undo one row the background flush delivered while its toast was up — the
   * queue's undoDelivered, except this restores the row's PRIOR triage (a bulk
   * gesture over the whole table may start from any value, not just "").
   */
  const undoDeliveredRow = React.useCallback(
    async (written: JobView, prior: JobView, undoLabel: (j: JobView) => string) => {
      const input = {
        postingKey: written.key,
        triage: prior.triage,
        snoozeUntil: prior.triage === "snoozed" ? (prior.snoozeUntil ?? null) : null,
        idempotencyKey: crypto.randomUUID(),
        expectedUpdatedAt: written.updatedAt,
      };
      let undo: WriteResult;
      try {
        undo = await setTriageAction(input);
      } catch {
        // The undo never reached the server: hold it, don't drop it.
        const idem = crypto.randomUUID();
        enqueue({
          id: idem,
          input: { ...input, idempotencyKey: idem },
          label: `Undo ${undoLabel(written)}`,
          queuedAt: Date.now(),
          reason: "offline",
        });
        patchRows([{ ...written, triage: prior.triage, snoozeUntil: input.snoozeUntil }]);
        return;
      }
      if (undo.ok) {
        patchRows([undo.job]);
        return;
      }
      if (undo.kind === "auth") {
        toast.error("Couldn't undo because your session expired.", {
          description: "Sign in and try again.",
        });
      } else if (undo.kind === "conflict") {
        toast.warning("Couldn't undo because this was changed somewhere else.");
      } else {
        toast.error("Couldn't undo that.", { description: undo.message });
      }
    },
    [patchRows],
  );

  /**
   * The ONE undo for a delivered batch: the inverse batch, fresh idempotency
   * key, guarded by the updatedAt values the delivery returned. The data layer
   * applies one triage per call, so a selection whose rows had MIXED prior
   * values partitions by prior (triage, wake date) — almost always one group,
   * since an undecided set is all-"" by definition.
   */
  const undoBulk = React.useCallback(
    async (written: JobView[], priors: JobView[], undoLabel: (j: JobView) => string) => {
      type Group = { triage: Triage; snoozeUntil: string | null; written: JobView[] };
      const groups = new Map<string, Group>();
      for (let i = 0; i < written.length; i++) {
        const p = priors[i];
        const snoozeUntil = p.triage === "snoozed" ? (p.snoozeUntil ?? null) : null;
        const gk = `${p.triage}|${snoozeUntil ?? ""}`;
        let g = groups.get(gk);
        if (!g) groups.set(gk, (g = { triage: p.triage, snoozeUntil, written: [] }));
        g.written.push(written[i]);
      }
      for (const g of groups.values()) {
        let res: BulkWriteResult;
        try {
          res = await setTriageBulkAction({
            postingKeys: g.written.map((w) => w.key),
            triage: g.triage,
            snoozeUntil: g.snoozeUntil,
            idempotencyKey: crypto.randomUUID(),
            expectedUpdatedAt: g.written.map((w) => w.updatedAt),
          });
        } catch {
          // Offline mid-undo: same doctrine as the queue — the undo is a
          // decision, it goes to the outbox and the rows read as undone.
          for (const w of g.written) {
            const idem = crypto.randomUUID();
            enqueue({
              id: idem,
              input: {
                postingKey: w.key,
                triage: g.triage,
                snoozeUntil: g.snoozeUntil,
                idempotencyKey: idem,
                expectedUpdatedAt: w.updatedAt,
              },
              label: `Undo ${undoLabel(w)}`,
              queuedAt: Date.now(),
              reason: "offline",
            });
          }
          patchRows(
            g.written.map((w) => ({ ...w, triage: g.triage, snoozeUntil: g.snoozeUntil })),
          );
          continue;
        }
        if (res.ok) {
          patchRows(res.jobs);
          continue;
        }
        if (res.kind === "auth") {
          toast.error("Couldn't undo because your session expired.", {
            description: "Sign in and try again.",
          });
        } else if (res.kind === "conflict") {
          toast.warning("Couldn't undo because this was changed somewhere else.");
          router.refresh();
        } else {
          toast.error("Couldn't undo that.", { description: res.message });
        }
      }
    },
    [patchRows, router],
  );

  /**
   * One decision, N rows, one transaction, one undo. The optimistic update
   * lands first; the failure branches mirror the queue's because they are the
   * same failures — with one difference the atomicity contract forces: a
   * conflict reverts EVERY row, since the store applied none of them.
   */
  const decide = React.useCallback(
    async (triage: Triage, options: DecideOptions): Promise<void> => {
      if (busyRef.current) return;
      const targets = options.targets;
      if (targets.length === 0) return;
      busyRef.current = true;
      setBusy(true);

      const priors = targets.map((j) => ({ ...j }));
      const patchSnapshot = targets.map((j) => [j.key, patchesRef.current.get(j.key)] as const);
      const snoozeUntil = triage === "snoozed" ? (options.snooze ?? null) : null;
      patchRows(targets.map((j) => ({ ...j, triage, snoozeUntil })));

      const idem = crypto.randomUUID();
      const input: BulkTriageInput = {
        postingKeys: targets.map((j) => j.key),
        triage,
        snoozeUntil,
        idempotencyKey: idem,
        expectedUpdatedAt: targets.map((j) => j.updatedAt),
      };

      /** Hold, don't discard (the queue's rule). */
      const defer = (reason: "offline" | "auth") => {
        for (let i = 0; i < targets.length; i++) {
          enqueue({
            id: `${idem}:${i}`,
            input: {
              postingKey: targets[i].key,
              triage,
              snoozeUntil,
              idempotencyKey: `${idem}:${i}`,
              expectedUpdatedAt: targets[i].updatedAt,
            },
            label: options.undoLabel(targets[i]),
            queuedAt: Date.now(),
            reason,
          });
        }
        busyRef.current = false;
        setBusy(false);
        toast(options.label, {
          description:
            reason === "auth"
              ? "Saved on this device. Sign in to apply it."
              : "Saved on this device. It'll sync when you're back online.",
          action: {
            label: "Undo",
            onClick: () => {
              // Row by row, the queue's three-way branch: still local (drop
              // it), delivered behind our back (compensating write), or gone
              // without a trace (say so — restoring the row would lie).
              let lost = 0;
              for (let i = 0; i < targets.length; i++) {
                if (dequeue(`${idem}:${i}`)) {
                  restorePatches([patchSnapshot[i]]);
                  continue;
                }
                const w = takeDelivered(`${idem}:${i}`);
                if (w) void undoDeliveredRow(w, priors[i], options.undoLabel);
                else lost++;
              }
              if (lost > 0) {
                toast.error(
                  lost === targets.length
                    ? "Couldn't undo that."
                    : `Couldn't undo ${lost} of them.`,
                  {
                    description:
                      "The decision already left this device. Reload to see where it landed.",
                  },
                );
              }
            },
          },
          duration: UNDO_MS,
        });
      };

      let result: BulkWriteResult;
      try {
        result = await setTriageBulkAction(input);
      } catch {
        defer("offline");
        return;
      }
      if (!result.ok && result.kind === "auth") {
        defer("auth");
        return;
      }
      busyRef.current = false;
      setBusy(false);

      if (result.ok) {
        // The server's rows, not the optimistic guesses: their updatedAt is
        // what makes the undo batch conflict-checkable.
        patchRows(result.jobs);
        const written = result.jobs;
        toast(options.label, {
          action: {
            label: "Undo",
            onClick: () => void undoBulk(written, priors, options.undoLabel),
          },
          duration: UNDO_MS,
        });
        return;
      }

      // All-or-nothing came back as nothing: every row reverts, including the
      // ones that would have succeeded alone — showing them decided while the
      // store holds nothing is the half-applied screen the transaction exists
      // to rule out.
      restorePatches(patchSnapshot);
      options.onRevert?.();
      if (result.kind === "conflict") {
        toast.warning("Changed on another device. Nothing was applied. Showing the latest.");
        router.refresh();
        return;
      }
      toast.error("Couldn't save that.", {
        description: result.message,
        action: { label: "Retry", onClick: () => void decide(triage, options) },
      });
    },
    [patchRows, restorePatches, undoBulk, undoDeliveredRow, router],
  );

  return { effRows, patchRows, busy, decide };
}
