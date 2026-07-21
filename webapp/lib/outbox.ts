import type { TriageInput } from "@/lib/data/source";

/**
 * The outbox: decisions made but not yet delivered.
 *
 * Two failures put a gesture here, and neither is the user's fault — the
 * network dropped, or the session expired between opening the app and pressing
 * a key. In both cases the decision itself was valid. Discarding it and asking
 * someone to triage the same twenty roles again is the response that makes
 * people stop trusting an app; keeping it and delivering it later is the one
 * that makes the failure a non-event.
 *
 * It is safe to replay because every gesture already carries an idempotency
 * key: the server returns the first result for a repeated key rather than
 * applying it twice. That property is what turns "retry until it works" from a
 * duplicate-writes hazard into the obvious thing to do.
 *
 * Storage is localStorage rather than memory so that a refresh — or a browser
 * killing a backgrounded tab, which phones do constantly — does not lose them.
 */

const KEY = "hq.outbox.v1";
/** A bound, like every queue in this system. Past this the tab is not coming back. */
const MAX = 200;

export type PendingGesture = {
  /** The gesture's idempotency key; also its identity in this queue. */
  id: string;
  input: TriageInput;
  /** What to call it in the banner, e.g. "Passed on Ramp — Product Manager". */
  label: string;
  queuedAt: number;
  /** Why it is here. Drives which banner the user sees. */
  reason: "offline" | "auth";
};

function read(): PendingGesture[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Storage is shared with whatever the user's browser did to it. A corrupt
    // value must never take down the queue, so it is treated as empty.
    return Array.isArray(parsed) ? (parsed as PendingGesture[]) : [];
  } catch {
    return [];
  }
}

function write(items: PendingGesture[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(items.slice(-MAX)));
  } catch {
    // Quota exceeded or storage disabled (Safari private mode). The in-memory
    // path still works for this session; losing durability is better than
    // losing the app.
  }
  window.dispatchEvent(new Event(OUTBOX_EVENT));
}

/** Same-tab change notification — the `storage` event only fires cross-tab. */
export const OUTBOX_EVENT = "hq:outbox";

export function listPending(): PendingGesture[] {
  return read();
}

export function enqueue(gesture: PendingGesture): void {
  const items = read().filter((g) => g.id !== gesture.id);
  items.push(gesture);
  write(items);
}

export function dequeue(id: string): void {
  write(read().filter((g) => g.id !== id));
}

export function clearOutbox(): void {
  write([]);
}

/**
 * Marks every queued gesture with a new reason. Used when the cause changes
 * under us — the network comes back but the session is what was actually
 * broken — so the banner stops telling the user something untrue.
 */
export function remark(reason: PendingGesture["reason"]): void {
  write(read().map((g) => ({ ...g, reason })));
}
