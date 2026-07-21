import type { TriageInput } from "@/lib/data/source";
import type { JobView } from "@/lib/data/view-models";

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
 *
 * The invariant this module owes the banner above it: NO decision disappears
 * without the user being told. A gesture leaves the pending queue exactly one
 * of two ways — delivered, or moved into a failed notice the user can see and
 * dismiss. Anything else is the banner promising "will sync automatically"
 * about work that is already gone.
 */

const KEY = "hq.outbox.v1";
const FAILED_KEY = "hq.outbox.failed.v1";
/** A bound, like every queue in this system. Past this the tab is not coming back. */
const MAX = 200;
/** Notices are bounded too; past this the oldest fall off first. */
const MAX_FAILED = 50;

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

export type FailureKind = "rejected" | "conflict" | "corrupt" | "evicted";

/**
 * A decision that will never be delivered, kept as a notice until dismissed.
 *
 * Dequeuing a rejected or conflicted gesture and moving on made the banner
 * vanish, which the user reads as "delivered" — the decision was gone and
 * nothing on screen admitted it.
 */
export type FailedGesture = {
  id: string;
  label: string;
  kind: FailureKind;
  /** Display-ready; the banner renders it verbatim after the label. */
  message: string;
  failedAt: number;
};

/** Same-tab change notification — the `storage` event only fires cross-tab. */
export const OUTBOX_EVENT = "hq:outbox";

/**
 * In-session fallback for when localStorage refuses a write (quota, Safari
 * private mode). A comment here used to claim "the in-memory path still works"
 * while no such path existed: read() re-read localStorage, so a swallowed
 * QuotaExceededError meant the toast said "Saved on this device" and nothing
 * was saved anywhere. Non-null only while storage is refusing writes; the next
 * write that lands clears it. Durability across a reload is still lost in this
 * state — storageDegraded() exists so the banner can say exactly that instead
 * of promising a sync the tab may not live to perform.
 */
let memoryPending: PendingGesture[] | null = null;
let memoryFailed: FailedGesture[] | null = null;

export function storageDegraded(): boolean {
  return memoryPending !== null || memoryFailed !== null;
}

/**
 * Storage is shared with whatever the user's browser, an extension, or an
 * older build did to it. One malformed entry used to throw inside the replay
 * loop on every pass, so every valid decision queued behind it was never
 * delivered — under a banner promising it would sync. Anything failing this
 * check is quarantined into a notice instead of being allowed to block others.
 */
function isPendingGesture(v: unknown): v is PendingGesture {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  if (typeof g.id !== "string" || g.id === "") return false;
  if (typeof g.label !== "string") return false;
  if (typeof g.queuedAt !== "number") return false;
  if (g.reason !== "offline" && g.reason !== "auth") return false;
  if (typeof g.input !== "object" || g.input === null) return false;
  const input = g.input as Record<string, unknown>;
  return (
    typeof input.postingKey === "string" &&
    typeof input.triage === "string" &&
    typeof input.idempotencyKey === "string"
  );
}

function isFailedGesture(v: unknown): v is FailedGesture {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.id === "string" &&
    typeof f.label === "string" &&
    typeof f.message === "string" &&
    typeof f.failedAt === "number" &&
    (f.kind === "rejected" || f.kind === "conflict" || f.kind === "corrupt" || f.kind === "evicted")
  );
}

function parse(key: string): unknown[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readFailed(): FailedGesture[] {
  if (typeof window === "undefined") return [];
  const stored = parse(FAILED_KEY).filter(isFailedGesture);
  if (memoryFailed) {
    const ids = new Set(stored.map((f) => f.id));
    return [...stored, ...memoryFailed.filter((f) => !ids.has(f.id))];
  }
  return stored;
}

function persistFailed(items: FailedGesture[]): void {
  if (typeof window === "undefined") return;
  const kept = items.slice(-MAX_FAILED);
  try {
    window.localStorage.setItem(FAILED_KEY, JSON.stringify(kept));
    memoryFailed = null;
  } catch {
    memoryFailed = kept;
  }
  window.dispatchEvent(new Event(OUTBOX_EVENT));
}

function appendFailed(notices: FailedGesture[]): void {
  if (notices.length === 0) return;
  const ids = new Set(notices.map((n) => n.id));
  persistFailed([...readFailed().filter((f) => !ids.has(f.id)), ...notices]);
}

/**
 * Guards the quarantine path against re-entering itself.
 *
 * `appendFailed` dispatches OUTBOX_EVENT synchronously, and the banner's
 * listener answers it by calling `listPending()` — which lands back here. While
 * the poison was still in storage that recursion had no floor: each pass
 * appended another notice and dispatched again, unwinding only when the JS
 * stack ran out, after ~1000 nested parses of the whole outbox. It fired on
 * every page load until the entry happened to be healed. The first fix for a
 * poison entry replaced a throw with a frozen tab, which is worse.
 */
let quarantining = false;

function read(): PendingGesture[] {
  if (typeof window === "undefined") return [];
  const entries = parse(KEY);
  const stored = entries.filter(isPendingGesture);
  // Memory-only entries ride along so a quota failure earlier in the session
  // cannot hide a decision from the flush.
  const extras = memoryPending ? memoryPending.filter((g) => !stored.some((s) => s.id === g.id)) : [];
  const merged = [...stored, ...extras];

  if (stored.length !== entries.length && !quarantining) {
    quarantining = true;
    try {
      // Heal FIRST, notify second. Reversed, the listener woken by the notice
      // re-reads storage that still contains the poison and quarantines it
      // again, forever.
      persist(merged);
      // Quarantine, don't discard quietly: whatever the entry has become, it
      // was a decision the user made, and it must leave a trace they can see.
      appendFailed(
        entries
          .filter((e) => !isPendingGesture(e))
          .map((e) => {
            const g = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
            return {
              id: typeof g.id === "string" && g.id !== "" ? g.id : crypto.randomUUID(),
              label: typeof g.label === "string" && g.label !== "" ? g.label : "A saved decision",
              kind: "corrupt" as const,
              message: "Corrupted in storage; it can't be sent. Make the call again from the queue.",
              failedAt: Date.now(),
            };
          }),
      );
    } finally {
      quarantining = false;
    }
  }
  return merged;
}

function persist(items: PendingGesture[]): void {
  if (typeof window === "undefined") return;
  let kept = items;
  if (items.length > MAX) {
    // The bound stands, but eviction is not silent: `slice(-MAX)` alone meant
    // the 201st decision pushed the oldest out with no trace anywhere.
    const evicted = items.slice(0, items.length - MAX);
    kept = items.slice(items.length - MAX);
    appendFailed(
      evicted.map((g) => ({
        id: g.id,
        label: g.label,
        kind: "evicted" as const,
        message: "Dropped because the offline queue hit its limit of 200. Make the call again from the queue.",
        failedAt: Date.now(),
      })),
    );
  }
  try {
    window.localStorage.setItem(KEY, JSON.stringify(kept));
    memoryPending = null;
  } catch {
    // Quota exceeded or storage disabled (Safari private mode). Hold the
    // decisions in this tab so the flush can still deliver them this session;
    // the banner reports the lost durability via storageDegraded(). Losing
    // durability is better than losing the app — losing the decision in
    // silence, as the old swallow-and-continue did, was never acceptable.
    memoryPending = kept;
  }
  window.dispatchEvent(new Event(OUTBOX_EVENT));
}

export function listPending(): PendingGesture[] {
  return read();
}

/**
 * Returns whether the gesture landed in durable storage. False means it is
 * held in memory only — alive for this tab, gone when the tab closes — so the
 * caller can stop short of promising "saved on this device".
 */
export function enqueue(gesture: PendingGesture): boolean {
  const items = read().filter((g) => g.id !== gesture.id);
  items.push(gesture);
  persist(items);
  return memoryPending === null;
}

/**
 * Returns whether the gesture was still pending. False means it had already
 * left the queue — delivered by the flush, or failed — and a caller undoing a
 * decision must treat that as "nothing was undone" rather than success: the
 * server may already hold the decision (see takeDelivered).
 */
export function dequeue(id: string): boolean {
  const items = read();
  const rest = items.filter((g) => g.id !== id);
  if (rest.length === items.length) return false;
  persist(rest);
  return true;
}

export function clearOutbox(): void {
  persist([]);
}

/**
 * Marks every queued gesture with a new reason. Used when the cause changes
 * under us — the network comes back but the session is what was actually
 * broken — so the banner stops telling the user something untrue.
 */
export function remark(reason: PendingGesture["reason"]): void {
  persist(read().map((g) => ({ ...g, reason })));
}

export function listFailed(): FailedGesture[] {
  return readFailed();
}

/**
 * Moves a pending gesture into the failed notices. Notice first, removal
 * second: interrupted between the two, the worst case is a replayed delivery
 * (free, idempotency key) plus a duplicate notice (deduped by id) — never a
 * silent loss.
 */
export function markFailed(gesture: PendingGesture, kind: FailureKind, message: string): void {
  appendFailed([{ id: gesture.id, label: gesture.label, kind, message, failedAt: Date.now() }]);
  persist(read().filter((g) => g.id !== gesture.id));
}

export function clearFailed(): void {
  persistFailed([]);
}

/**
 * Results of deliveries performed by the background flush, so an Undo pressed
 * after auto-delivery can send a genuine compensating write — it needs the
 * delivered `updatedAt`, or the compensation itself conflicts. In memory only:
 * an Undo toast does not survive a reload, so neither must this. Bounded like
 * every other collection here.
 */
const delivered = new Map<string, JobView>();
const MAX_DELIVERED = 50;

export function recordDelivered(id: string, job: JobView): void {
  delivered.set(id, job);
  if (delivered.size > MAX_DELIVERED) {
    delivered.delete(delivered.keys().next().value as string);
  }
}

/** One take each: consuming it is claiming the undo. */
export function takeDelivered(id: string): JobView | null {
  const job = delivered.get(id) ?? null;
  if (job) delivered.delete(id);
  return job;
}
