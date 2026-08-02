"use client";

import { AlertTriangle, CloudOff, LogIn, RefreshCw } from "lucide-react";
import * as React from "react";
import { setTriageAction } from "@/app/(app)/queue/actions";
import { Button } from "@/components/ui/button";
import {
  clearFailed,
  dequeue,
  listFailed,
  listPending,
  markFailed,
  OUTBOX_EVENT,
  recordDelivered,
  remark,
  storageDegraded,
  type FailedGesture,
  type PendingGesture,
} from "@/lib/outbox";

/**
 * The banner for work that has been decided but not yet delivered.
 *
 * The rule it enforces: the user is never left believing something was saved
 * when it was not, and never has to redo a decision the app is already holding.
 * So the banner is only ever shown when there is genuinely something pending —
 * a permanent "you may be offline" strip is noise people learn to ignore, which
 * costs exactly the credibility it was meant to buy.
 *
 * The same rule runs in reverse for failures: a gesture that leaves the queue
 * without landing (rejected, or lost to a newer decision) becomes a notice
 * here, not silence. The banner disappearing reads as "delivered" — letting it
 * disappear over a discarded decision is the lie this component exists to
 * prevent.
 *
 * Replay is automatic on reconnect and safe to repeat, because every queued
 * gesture carries the idempotency key it was created with.
 */

const RETRY_MS = 15_000;

/**
 * How long a freshly queued gesture stays local before the flush may send it.
 * Matches UNDO_MS in triage-queue.tsx: while the Undo toast is live, the
 * decision must still be in the outbox so Undo is a genuine removal. Before
 * this hold existed, the 'online' event flushed inside the Undo window — the
 * Undo click dequeued nothing, the card came back on screen, and the server
 * kept the decision.
 */
const UNDO_HOLD_MS = 8_000;

export function PendingWork() {
  const [pending, setPending] = React.useState<PendingGesture[]>([]);
  const [failed, setFailed] = React.useState<FailedGesture[]>([]);
  const [degraded, setDegraded] = React.useState(false);
  const [online, setOnline] = React.useState(true);
  const [flushing, setFlushing] = React.useState(false);

  // Gestures enqueued during THIS page's lifetime, still inside the Undo
  // window of the toast that announced them. Entries already present at mount
  // are never held: no Undo toast survived the load, so there is nothing to
  // protect and sign-in/reopen delivery stays immediate.
  const held = React.useRef<Set<string>>(new Set());
  const known = React.useRef<Set<string>>(new Set());
  const seeded = React.useRef(false);
  const holdTimers = React.useRef<number[]>([]);
  // Reentrancy guard as a ref rather than state: a guard reading `flushing`
  // recreated `flush` on every toggle, and the hold timers below would call a
  // stale copy.
  const busy = React.useRef(false);

  const flush = React.useCallback(async () => {
    if (busy.current) return;
    // Anything inside its Undo window stays local; the hold timer set in
    // `sync` below re-runs the flush the moment the window closes.
    const items = listPending().filter((g) => !held.current.has(g.id));
    if (items.length === 0) return;
    busy.current = true;
    setFlushing(true);
    try {
      for (const g of items) {
        try {
          const result = await setTriageAction(g.input);
          if (result.ok) {
            // Kept so an Undo pressed after this background delivery can send
            // a real compensating write instead of silently no-opping.
            recordDelivered(g.id, result.job);
            dequeue(g.id);
            continue;
          }
          if (result.kind === "auth") {
            // Still signed out. Stop: every remaining gesture will fail the
            // same way, and hammering the endpoint helps nobody.
            remark("auth");
            return;
          }
          if (result.kind === "conflict") {
            // The server already holds a newer decision made elsewhere; this
            // held one lost. That is a resolution, not a retry case — but it
            // is not a delivery either, and clearing the banner with no trace
            // told the user their decision landed when it did not.
            markFailed(g, "conflict", "Changed on another device first; the newer decision was kept.");
            continue;
          }
          // A genuine rejection. Not retried — the decision is recoverable by
          // re-triaging, an infinite loop is not — but never dropped in
          // silence: it becomes a notice instead of a vanished banner.
          markFailed(g, "rejected", `The server refused it: ${result.message}`);
        } catch {
          // Still unreachable. Leave the rest queued and try again later.
          remark("offline");
          return;
        }
      }
    } finally {
      busy.current = false;
      setFlushing(false);
      setPending(listPending());
      setFailed(listFailed());
      setDegraded(storageDegraded());
    }
  }, []);

  // Read from storage only after mount. The server has no localStorage, so
  // rendering the banner during SSR would be a guaranteed hydration mismatch —
  // the exact silent failure resilience.spec.ts exists to catch.
  React.useEffect(() => {
    const sync = () => {
      const items = listPending();
      for (const g of items) {
        if (known.current.has(g.id)) continue;
        known.current.add(g.id);
        if (!seeded.current) continue;
        held.current.add(g.id);
        holdTimers.current.push(
          window.setTimeout(() => {
            held.current.delete(g.id);
            if (navigator.onLine) void flush();
          }, UNDO_HOLD_MS),
        );
      }
      seeded.current = true;
      setPending(items);
      setFailed(listFailed());
      setDegraded(storageDegraded());
    };
    sync();
    setOnline(navigator.onLine);
    window.addEventListener(OUTBOX_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(OUTBOX_EVENT, sync);
      window.removeEventListener("storage", sync);
      for (const t of holdTimers.current) window.clearTimeout(t);
    };
  }, [flush]);

  // Try once on mount, because the most common way a held gesture becomes
  // deliverable is a page load: signing back in ends on a fresh page, and so
  // does reopening a tab that was closed while offline. Waiting for the retry
  // timer there would leave someone staring at a banner telling them to fix
  // something they have already fixed.
  const mounted = React.useRef(false);
  React.useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    if (listPending().length > 0 && navigator.onLine) void flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  React.useEffect(() => {
    function goOnline() {
      setOnline(true);
      void flush();
    }
    function goOffline() {
      setOnline(false);
    }
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [flush]);

  // A periodic nudge, because `online` is unreliable: a laptop that wakes on a
  // captive-portal wifi reports online while nothing resolves, and some
  // browsers never fire the event at all.
  React.useEffect(() => {
    if (pending.length === 0) return;
    const t = setInterval(() => {
      if (navigator.onLine) void flush();
    }, RETRY_MS);
    return () => clearInterval(t);
  }, [pending.length, flush]);

  if (pending.length === 0 && failed.length === 0) return null;

  const needsAuth = pending.some((g) => g.reason === "auth");
  const n = pending.length;
  const noun = n === 1 ? "decision" : "decisions";

  return (
    <>
      {failed.length > 0 && (
        <div
          data-testid="failed-work"
          role="alert"
          className="flex flex-wrap items-start gap-x-3 gap-y-1.5 border-b border-danger/30 bg-danger-subtle
                     px-4 py-2 text-xs text-text sm:px-6"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-danger" />

          <div className="min-w-0 flex-1">
            <strong className="font-semibold">
              {failed.length === 1
                ? "1 decision wasn't applied."
                : `${failed.length} decisions weren't applied.`}
            </strong>
            <ul className="mt-0.5 space-y-0.5">
              {failed.map((f) => (
                <li key={f.id}>
                  <span className="font-medium">{f.label}</span>. {f.message}
                </li>
              ))}
            </ul>
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => clearFailed()}
            data-testid="failed-dismiss"
          >
            Dismiss
          </Button>
        </div>
      )}

      {pending.length > 0 && (
        <div
          data-testid="pending-work"
          data-reason={needsAuth ? "auth" : "offline"}
          data-durable={degraded ? "false" : "true"}
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-warn/30 bg-warn-subtle
                     px-4 py-2 text-xs text-text sm:px-6"
        >
          {needsAuth ? (
            <LogIn aria-hidden="true" className="size-3.5 shrink-0 text-warn" />
          ) : (
            <CloudOff aria-hidden="true" className="size-3.5 shrink-0 text-warn" />
          )}

          <span className="min-w-0">
            {needsAuth ? (
              <>
                Your session expired. {n} {noun}{" "}
                {degraded
                  ? "are held in this tab. Device storage is full, so keep it open. Sign in and they'll be applied."
                  : "are saved on this device. Sign in and they'll be applied."}
              </>
            ) : (
              <>
                {online ? "Couldn't reach the server." : "You're offline."}{" "}
                {n} {noun}{" "}
                {degraded
                  ? "are held in this tab. Device storage is full, so keep it open until they sync."
                  : "are saved on this device and will sync automatically."}
              </>
            )}
          </span>

          <div className="ml-auto flex shrink-0 gap-1.5">
            {needsAuth ? (
              <Button
                variant="secondary"
                size="sm"
                // A full navigation, not a router push: the point is to get a
                // fresh session cookie, and the outbox survives in localStorage.
                onClick={() => {
                  window.location.href = "/login";
                }}
              >
                Sign in
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void flush()}
                disabled={flushing}
                data-testid="pending-retry"
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                {flushing ? "Syncing" : "Retry now"}
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
