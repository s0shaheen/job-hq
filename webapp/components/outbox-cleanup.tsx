"use client";

import * as React from "react";

/**
 * Clears what the retired offline queue left in localStorage. #222 removed
 * `lib/outbox.ts` — the pre-DEC-011 localStorage mutation queue — and a browser
 * that last visited before the removal may still hold its keys.
 *
 * The decision for that leftover data is DROP, not flush, and it is deliberate:
 *
 *   - Flushing would keep a replay path alive — code that reads gestures out of
 *     localStorage and writes them to the store IS the offline mutation queue
 *     the contract forbids and this change removes. The issue's own acceptance
 *     criterion ("the code contains no localStorage mutation queue") rules the
 *     migration shim out, not just the steady state.
 *   - The pilot has no external users, and the old queue flushed within seconds
 *     of connectivity on every page load; a surviving unflushed entry requires
 *     a browser that went offline mid-session before the removal deployed and
 *     never came back until after it. The stranded-decision risk is theoretical;
 *     the forbidden-mechanism cost of a flusher is not.
 *   - The entries carry private user content (posting keys, decisions, labels
 *     with company names). With the code that owned them gone, leaving them to
 *     rot in localStorage indefinitely is a data-hygiene fault of its own —
 *     removal is the honest disposition.
 *
 * Renders nothing. Delete this component once the pilot's browsers have all
 * loaded a post-#222 build.
 */

const LEGACY_KEYS = ["hq.outbox.v1", "hq.outbox.failed.v1"] as const;

export function OutboxCleanup() {
  React.useEffect(() => {
    for (const key of LEGACY_KEYS) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Storage refusing a REMOVAL (disabled storage, teardown) leaves only
        // inert data behind; nothing reads these keys anymore.
      }
    }
  }, []);
  return null;
}
