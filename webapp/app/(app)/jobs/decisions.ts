"use client";

/**
 * The Jobs write path, lifted out of the chrome that used to hold it.
 *
 * 07 §1 is the governing rule for the whole redesign: writes go only through
 * the existing RPC layer, carrying idempotency keys; optimistic with undo;
 * conflicts reverted. **The redesign changes what controls look like, never
 * how they write.** This module is shared verbatim by /jobs and /queue, so the
 * two surfaces cannot drift apart.
 *
 * Two rules, and they are the same rules the pipeline and companies surfaces
 * already prove:
 *
 *   1. Every gesture is optimistic with an honest failure path. A conflict
 *      reverts EVERYTHING — the batch is atomic in the store, so the screen
 *      must be too, including the rows that would have succeeded alone.
 *   2. An undeliverable decision REFUSES AND REVERTS, visibly (DEC-011). No
 *      queue, no localStorage, no "saved on this device": a write that did not
 *      reach the store leaves the screen exactly as it was and says so, rather
 *      than claiming a durability the path does not have. The localStorage
 *      outbox that once held these gestures was removed by #222; the toast is
 *      the only handle the person still has on a refused gesture, which is why
 *      the error branch carries Retry.
 *
 * The caller owns the WORDS. `decide()` takes its toast label as a parameter
 * rather than building one, because the label is dictionary vocabulary (02 §6)
 * and the dictionary lives at the surface, not in the write path.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { BulkTriageInput, BulkWriteResult } from "@/lib/data/source";
import type { JobView, Triage } from "@/lib/data/view-models";
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
  /**
   * Called whenever the write came back as nothing and the screen must revert
   * — offline, expired session, conflict, or a plain rejection. The surface
   * restores whatever it snapshotted (its selection, typically); the row
   * patches are restored here, since this module owns them.
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
   * The ONE undo for a delivered batch: the inverse batch, fresh idempotency
   * key, guarded by the updatedAt values the delivery returned. The data layer
   * applies one triage per call, so a selection whose rows had MIXED prior
   * values partitions by prior (triage, wake date) — almost always one group,
   * since an undecided set is all-"" by definition.
   */
  const undoBulk = React.useCallback(
    async (written: JobView[], priors: JobView[]) => {
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
          // DEC-011: the undo is a write like any other — refused, never
          // queued. The rows keep their decided state, because reading as
          // "undone" a write the server never heard would be the screen lying
          // about the store.
          toast.error("Couldn't undo. The server didn't answer.", {
            description: "Reload to see where the decision landed.",
          });
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
   * lands first; every failure reverts EVERY row, since the store applied
   * none of them — showing some rows decided while the store holds nothing is
   * the half-applied screen the transaction exists to rule out.
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

      const input: BulkTriageInput = {
        postingKeys: targets.map((j) => j.key),
        triage,
        snoozeUntil,
        idempotencyKey: crypto.randomUUID(),
        expectedUpdatedAt: targets.map((j) => j.updatedAt),
      };

      /** Refuse and revert, visibly (DEC-011). Nothing is queued anywhere. */
      const refuse = (say: () => void) => {
        restorePatches(patchSnapshot);
        options.onRevert?.();
        busyRef.current = false;
        setBusy(false);
        say();
      };

      let result: BulkWriteResult;
      try {
        result = await setTriageBulkAction(input);
      } catch {
        // The thrown-action branch: offline, or a server that never answered.
        refuse(() =>
          toast.error("Couldn't save that. You may be offline.", {
            description: "Nothing was changed. Try again when you're back.",
          }),
        );
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
            onClick: () => void undoBulk(written, priors),
          },
          duration: UNDO_MS,
        });
        return;
      }

      // All-or-nothing came back as nothing: every row reverts, including the
      // ones that would have succeeded alone.
      restorePatches(patchSnapshot);
      options.onRevert?.();
      if (result.kind === "auth") {
        // No Retry: replaying into a dead session refuses the same way, and
        // nothing holds the gesture, so the honest offer is the way back in.
        toast.error("Couldn't save that. Your session expired.", {
          description: "Sign in and try again.",
        });
        return;
      }
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
    [patchRows, restorePatches, undoBulk, router],
  );

  return { effRows, patchRows, busy, decide };
}
