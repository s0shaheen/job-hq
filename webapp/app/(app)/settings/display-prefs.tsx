"use client";

import * as React from "react";

/**
 * The display preferences, as a real control rather than a deferral note.
 *
 * These are the two knobs spec §D's personas turn on: Dad reads large type on
 * every surface, and a comfortable row height goes with it. The MECHANISM shipped
 * with the pipeline (`<html data-type-scale>` / `data-density`, applied from the
 * `hq_display` cookie before first paint), and for a while nothing in the UI set
 * the cookie — which was recorded as "deferred, no `profiles` read exists". That
 * reasoning was wrong and worth correcting: a cookie toggle needs no profile read
 * at all. It writes the cookie and reloads.
 *
 * Deliberately NOT a server action. There is nothing to authorize, nothing to
 * audit and nothing another device needs to agree about — it is this browser's
 * eyesight. Writing it client-side keeps it working on a deployment with no
 * database, which is also where the demo runs.
 *
 * The reload is the honest part: the values are applied by an inline script in
 * `<head>` so they land before first paint, and the tokens they change are read by
 * every rendered element. Re-rendering in place would leave server-rendered markup
 * measured against the old scale. A reload is one frame of cost for a setting a
 * person changes about twice.
 *
 * When PHASE-PROFILE lands a real `profiles` write, this becomes its client half:
 * the cookie stays (it is what the pre-paint script can read) and the profile
 * becomes the durable copy that re-issues it on sign-in from another device.
 */

const COOKIE = "hq_display";
const YEAR = 60 * 60 * 24 * 365;

function readCookie(): Set<string> {
  if (typeof document === "undefined") return new Set();
  const m = /(?:^|;\s*)hq_display=([^;]*)/.exec(document.cookie);
  if (!m) return new Set();
  return new Set(decodeURIComponent(m[1]).split(",").filter(Boolean));
}

export function DisplayPrefs() {
  // Read on mount, not during render: the cookie is a browser fact the server
  // does not have, and reading it in render is a hydration mismatch.
  const [prefs, setPrefs] = React.useState<Set<string> | null>(null);
  React.useEffect(() => setPrefs(readCookie()), []);

  function toggle(flag: "large" | "comfortable") {
    const next = new Set(prefs ?? readCookie());
    if (next.has(flag)) next.delete(flag);
    else next.add(flag);
    // `SameSite=Lax`, path-wide, no `Secure` so it works on localhost too. Not
    // HttpOnly by construction — the pre-paint script has to read it.
    document.cookie = `${COOKIE}=${encodeURIComponent([...next].join(","))}; Path=/; Max-Age=${YEAR}; SameSite=Lax`;
    window.location.reload();
  }

  const rows: { flag: "large" | "comfortable"; label: string; body: string }[] = [
    {
      flag: "large",
      label: "Larger text",
      body: "Scales every type size across the app. Applies before the page paints, so nothing reflows.",
    },
    {
      flag: "comfortable",
      label: "Roomier rows",
      body: "More vertical space in the pipeline's rows. The jobs grid keeps its own per-view setting.",
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
        How this app looks on this device. Kept out of shared links on purpose — a link you
        send should not impose your eyesight on whoever opens it.
      </p>

      <div className="mt-3 space-y-3">
        {rows.map((r) => {
          const on = prefs?.has(r.flag) ?? false;
          return (
            <div key={r.flag} className="flex items-start justify-between gap-3">
              <label htmlFor={`display-${r.flag}`} className="min-w-0">
                <span className="block text-sm font-medium text-text">{r.label}</span>
                <span className="block text-xs text-muted">{r.body}</span>
              </label>
              <input
                id={`display-${r.flag}`}
                data-testid={`display-${r.flag}`}
                type="checkbox"
                // Uncontrolled until the cookie has been read, so the server HTML
                // and the first client render agree.
                checked={on}
                disabled={prefs === null}
                onChange={() => toggle(r.flag)}
                className="mt-1 size-4 shrink-0 accent-[var(--accent)]
                           focus-visible:outline-2 focus-visible:outline-offset-2
                           focus-visible:outline-ring"
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
