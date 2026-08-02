"use client";

import * as React from "react";
import type { DisplayPrefsView } from "@/lib/data/source";
import { setDisplayPrefsAction } from "./actions";

/**
 * The display preferences, backed by `profiles` rather than by a cookie.
 *
 * WHAT CHANGED, AND WHY THE OLD REASONING WAS WRONG. This control used to write
 * the `hq_display` cookie and reload, and argued for that: "nothing to
 * authorize, nothing to audit and nothing another device needs to agree about —
 * it is this browser's eyesight." The last clause is the one that does not
 * survive contact with the person it is for. Somebody who needs 16px type needs
 * it on their phone too, and a browser-local preference means every new device
 * starts unreadable to exactly the user it exists for. Migration 0025 moves the
 * value onto the profile; this is its client half.
 *
 * The values arrive as PROPS from the server, which is the other half of the
 * change: the page renders the current state in its HTML, so there is no
 * read-on-mount and no moment where the checkboxes are blank or disabled while
 * a cookie is parsed.
 *
 * THE RELOAD STAYS, and its original justification is unchanged and still
 * correct: the type scale and density are `<html>` attributes read by every
 * rendered element, and server-rendered markup measured against the old scale
 * would need the whole tree re-measured to catch up. A reload is one frame of
 * cost for a setting a person changes about twice. The server action
 * revalidates the root layout first, so the reload paints the new attributes
 * rather than a cached document.
 *
 * AUTOSAVE, per 06 §A: no Save button, the write goes out on the gesture. The
 * checkbox is disabled for the round trip rather than optimistically flipped,
 * because the visible confirmation of THIS setting is the whole page changing
 * size — an optimistic tick followed by a reload that undoes it would be a
 * worse lie than a half-second wait.
 *
 * This is deliberately NOT the designed control. The Display popover (06, and
 * doc 07 §3's Jobs chrome) lands with the Jobs surface build from the owner's
 * design and will consume exactly the same `displayPrefs` contract; keeping
 * this one working — same markup, same test ids — is what stops the setting
 * being unreachable in between.
 */

type Flag = "large" | "comfortable";

/**
 * The bound every other write in this app already carries — `profile-form.tsx`,
 * `pipeline-table.tsx`, `use-writes.ts`, `wizard.tsx`, `review.tsx` all declare
 * the same 15s and the same reason (matrix row 135): an UNBOUNDED action
 * strands the control disabled forever with no way back.
 *
 * Autosave made that failure worse here than anywhere else, not better. There
 * is no Save button to press again, so a checkbox that never re-enables is the
 * whole setting gone until the person reloads a page that gives them no hint
 * they should.
 */
const WRITE_TIMEOUT_MS = 15_000;

/** Reject nothing, resolve to a sentinel. `profile-form.tsx`'s shape. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function DisplayPrefs({ prefs }: { prefs: DisplayPrefsView }) {
  // The gesture in flight, optimistically. Without it the tick VISIBLY SNAPS
  // BACK: `checked` is derived from a server prop that cannot change until the
  // reload, so React re-renders the box unchecked the instant the click is
  // handled and the person watches their own gesture undo itself for the length
  // of a round trip. Cleared on failure, which is rows 8 and 9's rule — a failed
  // write reverts the optimistic state rather than leaving a phantom.
  const [pending, setPending] = React.useState<{ flag: Flag; on: boolean } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // One key per GESTURE, held across retries of that same gesture, which is
  // `profile-form.tsx`'s rule stated for a control that has no Save button: a
  // write that timed out may still land, and the person's only way to find out
  // is to click again. A fresh uuid on the retry would make that second click a
  // second write. A different gesture (the other knob, or the same knob back
  // the other way) is a different intent and mints its own.
  const idem = React.useRef<{ gesture: string; key: string } | null>(null);
  function keyFor(gesture: string): string {
    if (idem.current?.gesture !== gesture) {
      idem.current = { gesture, key: crypto.randomUUID() };
    }
    return idem.current.key;
  }

  function isOn(flag: Flag): boolean {
    if (pending?.flag === flag) return pending.on;
    return flag === "large" ? prefs.typeScale === "large" : prefs.density === "comfortable";
  }

  async function toggle(flag: Flag) {
    if (pending) return;
    const next = !isOn(flag);
    setPending({ flag, on: next });
    setError(null);

    let result: Awaited<ReturnType<typeof setDisplayPrefsAction>> | { timedOut: true };
    try {
      result = await withTimeout(
        setDisplayPrefsAction({
          ...(flag === "large"
            ? { typeScale: next ? "large" : "default" }
            : { density: next ? "comfortable" : "dense" }),
          // One knob per call, so the OTHER one is never restated — two tabs (or
          // this tab and a phone) turning different knobs cannot revert each other.
          idempotencyKey: keyFor(`${flag}:${next}`),
          expectedUpdatedAt: prefs.updatedAt,
        }),
        WRITE_TIMEOUT_MS,
      );
    } catch {
      // A server action REJECTS when the network is gone, and an unhandled
      // rejection here left `pending` set forever: the checkbox stayed disabled
      // with nothing on screen saying why. This is the offline path, and the
      // rule for it is the app's rule everywhere — the write is refused, the
      // control comes back, and nothing is queued to replay later.
      setPending(null);
      setError("Couldn't save that. Check your connection and try again.");
      return;
    }

    if ("timedOut" in result) {
      // The key is deliberately NOT rotated, so clicking again replays rather
      // than writing twice.
      setPending(null);
      setError("That took too long. Try again, it will not save twice.");
      return;
    }

    if (result.ok || result.kind === "conflict") {
      // A conflict is not an error to a person here: another device already
      // moved this, and the honest response is to show what it set. Reloading
      // does exactly that, because the server is where the value lives now.
      window.location.reload();
      return;
    }
    setPending(null);
    setError(
      result.kind === "auth" ? "Your session expired. Sign in again." : "Couldn't save that.",
    );
  }

  const rows: {
    flag: Flag;
    label: string;
    body: string;
  }[] = [
    {
      flag: "large",
      label: "Larger text",
      body: "Scales every type size in the app. Applied before the page paints, so nothing jumps.",
    },
    {
      flag: "comfortable",
      label: "Roomier rows",
      body: "More vertical space in the pipeline. The jobs grid keeps its own setting per view.",
    },
  ];

  return (
    <section
      id="display"
      aria-labelledby="display-heading"
      className="rounded-lg border border-border bg-surface p-4"
    >
      <h2 id="display-heading" className="text-sm font-semibold">
        Display
      </h2>
      <p className="mt-1 text-sm text-muted">
        How this app looks, on every device you sign in from. Kept out of shared
        links, so a link you send does not impose your eyesight on whoever opens it.
      </p>

      <div className="mt-3 space-y-3">
        {rows.map((r) => (
          <div key={r.flag} className="flex items-start justify-between gap-3">
            <label htmlFor={`display-${r.flag}`} className="min-w-0">
              <span className="block text-sm font-medium text-text">{r.label}</span>
              <span className="block text-xs text-muted">{r.body}</span>
            </label>
            <input
              id={`display-${r.flag}`}
              data-testid={`display-${r.flag}`}
              type="checkbox"
              // Controlled from the SERVER's value once settled, so the
              // checkbox and the rendered page cannot disagree: both come from
              // one read. `isOn` layers the in-flight gesture on top of it.
              checked={isOn(r.flag)}
              disabled={pending !== null}
              onChange={() => toggle(r.flag)}
              className="mt-1 size-4 shrink-0 accent-[var(--accent)]
                         focus-visible:outline-2 focus-visible:outline-offset-2
                         focus-visible:outline-ring"
            />
          </div>
        ))}
      </div>

      {error ? (
        <p role="status" data-testid="display-error" className="mt-3 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
