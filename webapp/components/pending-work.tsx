"use client";

import { CloudOff, LogIn, RefreshCw } from "lucide-react";
import * as React from "react";
import { setTriageAction } from "@/app/(app)/queue/actions";
import { Button } from "@/components/ui/button";
import {
  dequeue,
  listPending,
  OUTBOX_EVENT,
  remark,
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
 * Replay is automatic on reconnect and safe to repeat, because every queued
 * gesture carries the idempotency key it was created with.
 */

const RETRY_MS = 15_000;

export function PendingWork() {
  const [pending, setPending] = React.useState<PendingGesture[]>([]);
  const [online, setOnline] = React.useState(true);
  const [flushing, setFlushing] = React.useState(false);

  // Read from storage only after mount. The server has no localStorage, so
  // rendering the banner during SSR would be a guaranteed hydration mismatch —
  // the exact silent failure resilience.spec.ts exists to catch.
  React.useEffect(() => {
    const sync = () => setPending(listPending());
    sync();
    setOnline(navigator.onLine);
    window.addEventListener(OUTBOX_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(OUTBOX_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

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

  const flush = React.useCallback(async () => {
    const items = listPending();
    if (items.length === 0 || flushing) return;
    setFlushing(true);
    try {
      for (const g of items) {
        try {
          const result = await setTriageAction(g.input);
          if (result.ok || (!result.ok && result.kind === "conflict")) {
            // Delivered, or superseded by a newer decision elsewhere. Either
            // way it is no longer pending — a conflict means the server has a
            // value, which is what the queue existed to achieve.
            dequeue(g.id);
            continue;
          }
          if (result.kind === "auth") {
            // Still signed out. Stop: every remaining gesture will fail the
            // same way, and hammering the endpoint helps nobody.
            remark("auth");
            return;
          }
          // A genuine rejection. Drop it rather than retrying forever; the
          // decision is recoverable by re-triaging, an infinite loop is not.
          dequeue(g.id);
        } catch {
          // Still unreachable. Leave the rest queued and try again later.
          remark("offline");
          return;
        }
      }
    } finally {
      setFlushing(false);
      setPending(listPending());
    }
  }, [flushing]);

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

  if (pending.length === 0) return null;

  const needsAuth = pending.some((g) => g.reason === "auth");
  const n = pending.length;
  const noun = n === 1 ? "decision" : "decisions";

  return (
    <div
      data-testid="pending-work"
      data-reason={needsAuth ? "auth" : "offline"}
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
            <strong className="font-semibold">Your session expired.</strong> {n} {noun} are
            saved on this device. Sign in and they&rsquo;ll be applied.
          </>
        ) : (
          <>
            <strong className="font-semibold">
              {online ? "Couldn't reach the server." : "You're offline."}
            </strong>{" "}
            {n} {noun} are saved on this device and will sync automatically.
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
            {flushing ? "Syncing…" : "Retry now"}
          </Button>
        )}
      </div>
    </div>
  );
}
