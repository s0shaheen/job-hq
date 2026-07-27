"use client";

import * as React from "react";

/**
 * The write discipline every step of this wizard shares: one at a time, bounded,
 * and counted where a test can see it.
 *
 * Three separate failures are answered here, all three of them already paid for
 * on other surfaces:
 *
 *   * **An unbounded call freezes the screen** (matrix row 135). A server action
 *     that never answers leaves "Working…" on forever AND leaves every control
 *     disabled — one dead request, one dead surface. The bound does not cancel
 *     the request; a write that lands late still lands, and its idempotency key
 *     is what makes that safe.
 *   * **A gesture arriving mid-write is silently dropped** (matrix row 115). The
 *     first version of the pipeline's queue bailed on "busy", and a second
 *     gesture milliseconds later vanished. Serializing keeps every gesture, in
 *     order.
 *   * **"Wait until nothing is pending" is an unsound test gate** (matrix rows 21
 *     and 117). `pending === 0` is true both BEFORE a write starts and after it
 *     ends, so a check landing in the window between a click and its commit
 *     passes instantly and reloads into the gap — cancelling the write and
 *     reporting it as lost. `writes` only ever goes up: read it, act, wait for it
 *     to pass. It counts every outcome, not just successes, because a refused
 *     write is finished too and a counter that skipped those would hang.
 *
 * The pipeline keeps its own private copy of this shape. It was not extracted
 * into a shared hook as part of this phase: that surface is shipped and tested,
 * and rewriting its write path to serve a new one is a change with no test of its
 * own behind it.
 */

/** Generous on purpose: a cold function on a phone connection is genuinely slow.
 *  The point is that the bound EXISTS, not that it is tight. */
export const WRITE_TIMEOUT_MS = 15_000;

/** Reject if `p` has not settled in `ms`. The request itself is not cancelled. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Runs one server call, bounded and in turn. Throws when the bound is reached. */
export type Bounded = <T>(send: () => Promise<T>) => Promise<T>;

export type Writes = {
  /** Queued or in flight. Drives "Working…" and disables the controls. */
  pending: number;
  /** Monotonic count of FINISHED calls — published to the DOM for tests. */
  writes: number;
  run: Bounded;
};

export function useWrites(): Writes {
  const [pending, setPending] = React.useState(0);
  const [writes, setWrites] = React.useState(0);
  const tail = React.useRef<Promise<unknown>>(Promise.resolve());

  const run = React.useCallback(<T,>(send: () => Promise<T>): Promise<T> => {
    setPending((n) => n + 1);
    const settle = async (): Promise<T> => {
      try {
        return await withTimeout(send(), WRITE_TIMEOUT_MS);
      } finally {
        setPending((n) => Math.max(0, n - 1));
        setWrites((n) => n + 1);
      }
    };
    // Chained on BOTH settle paths, so one rejection cannot wedge the queue.
    const next = tail.current.then(settle, settle);
    tail.current = next.catch(() => undefined);
    return next;
  }, []);

  return { pending, writes, run };
}
