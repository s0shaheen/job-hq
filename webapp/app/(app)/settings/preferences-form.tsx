"use client";

import * as React from "react";
import { Check } from "lucide-react";
import type { DisplayPrefsView } from "@/lib/data/source";
import {
  DENSITIES,
  LANDING_VIEW_OPTIONS,
  THEMES,
  TYPE_SCALES,
  type Density,
  type ThemeChoice,
  type TypeScale,
} from "@/lib/display/prefs";
import { setDisplayPrefsAction } from "./actions";

/**
 * Settings → Preferences: the five display knobs, autosaved.
 *
 * WHAT THIS REPLACES. `display-prefs.tsx` shipped two of the five as checkboxes
 * ("Larger text", "Roomier rows") on the old single-column `/settings`, because
 * only two were reachable at the time and the section rail did not exist.
 * `Settings.dc.html` draws all five: Density, Type size and Theme as 200px
 * selects, Landing view as a 200px select with its own help line, and Keyboard
 * hints as a switch with a title and a description. That file is gone and this
 * is what took its place; the write path underneath is byte for byte the same
 * `setDisplayPrefsAction`, so nothing about authorization, idempotency or the
 * version token changed.
 *
 * AUTOSAVE, per 06 §A, and the heading says so. Profile & search is the one
 * section with an explicit Save, and each section states which it is. The quiet
 * tick beside the heading is the design's confirmation; it is not a toast,
 * because a toast for a knob somebody turns twice a year is noise, and it is not
 * an animation, because the confirmation has to survive `prefers-reduced-motion`.
 *
 * THE RELOAD STAYS for density and type scale, and its original justification is
 * unchanged: both are `<html>` attributes read by every rendered element, and
 * server-rendered markup measured against the old scale would need the whole
 * tree re-measured to catch up. Theme is class-driven on the same element, so it
 * takes the same path. Keyboard hints and landing view do NOT reload — nothing
 * on this page is measured against them, and reloading for a value the page does
 * not render would be a flash with no purpose.
 */

/**
 * The bound every other write in this app already carries — `profile-form.tsx`,
 * `pipeline-table.tsx`, `use-writes.ts`, `wizard.tsx`, `review.tsx` all declare
 * the same 15s and the same reason (matrix row 135): an UNBOUNDED action strands
 * the control disabled forever with no way back.
 *
 * Autosave makes that failure worse here than anywhere else, not better. There
 * is no Save button to press again, so a control that never re-enables is the
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

/** One knob, named by the field it writes. Used for the in-flight state. */
type Knob = "density" | "typeScale" | "theme" | "landingView" | "keyboardHints";

/** The knobs whose value the document itself is rendered against. */
const REPAINTS: readonly Knob[] = ["density", "typeScale", "theme"];

/**
 * The key `app/layout.tsx`'s pre-paint bootstrap reads. One spelling, here.
 */
const THEME_KEY = "hq-theme";

/**
 * The theme's device half.
 *
 * `system` REMOVES the key rather than storing the string, and that is the
 * layout's own rule rather than a shortcut: `system` means "ask the operating
 * system", which is the ABSENCE of a choice. A stored `"system"` would be a
 * value nothing reads differently from its own absence, and — worse — it would
 * sit in the slot that outranks the profile, so choosing `system` on one device
 * would silently pin that device away from an explicit `dark` the account later
 * set from another one.
 *
 * Wrapped, because private mode throws on `localStorage`. A theme is never worth
 * a broken save: the profile half already landed, and the next load resolves it
 * from the server.
 */
function writeThemeLocal(theme: ThemeChoice): void {
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // no-op, deliberately: see above
  }
}

const selectClass =
  "h-8 w-50 max-w-full rounded-md border border-border-strong bg-surface px-2 text-sm text-text " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring " +
  "disabled:text-muted";

function Field({
  id,
  label,
  help,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-1">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      {children}
      {/* Help BELOW the field, never a placeholder standing in for a label
          (04 §4.5). */}
      {help ? (
        <span id={`${id}-help`} className="text-xs text-muted">
          {help}
        </span>
      ) : null}
    </div>
  );
}

export function PreferencesForm({ prefs }: { prefs: DisplayPrefsView }) {
  // The gesture in flight, optimistically. Without it the control VISIBLY SNAPS
  // BACK: every value is derived from a server prop that cannot change until the
  // round trip finishes, so React would re-render the old value the instant the
  // change was handled and the person would watch their own gesture undo itself.
  // Cleared on failure, which is matrix rows 8 and 9's rule: a failed write
  // reverts the optimistic state rather than leaving a phantom.
  const [pending, setPending] = React.useState<{ knob: Knob; value: unknown } | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /**
   * Visible is not interactive, and on THIS control the gap is wider than usual.
   *
   * The server renders all five knobs long before React attaches a handler, and
   * a `select` is the worst case: changing it before hydration moves the DOM
   * value and fires a change event nothing is listening for, so the option
   * really does look chosen and no write is ever sent. `profile-form.tsx` earned
   * this the hard way and states the general lesson; the specific one here was
   * measured on this branch, where the two-knob test passed alone and failed
   * under parallel load because the second gesture landed in that gap. An
   * `enabled` check cannot see it — the select is enabled in the server HTML
   * too — and only a flag set in an effect can.
   */
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => setHydrated(true), []);

  // One key per GESTURE, held across retries of that same gesture, which is
  // `profile-form.tsx`'s rule stated for a control that has no Save button: a
  // write that timed out may still land, and the person's only way to find out
  // is to try again. A fresh uuid on the retry would make that second attempt a
  // second write. A different gesture mints its own.
  const idem = React.useRef<{ gesture: string; key: string } | null>(null);
  function keyFor(gesture: string): string {
    if (idem.current?.gesture !== gesture) {
      idem.current = { gesture, key: crypto.randomUUID() };
    }
    return idem.current.key;
  }

  function current<T>(knob: Knob, stored: T): T {
    return pending?.knob === knob ? (pending.value as T) : stored;
  }

  async function write(knob: Knob, value: Density | TypeScale | ThemeChoice | string | boolean) {
    if (pending) return;
    setPending({ knob, value });
    setSaved(false);
    setError(null);

    let result: Awaited<ReturnType<typeof setDisplayPrefsAction>> | { timedOut: true };
    try {
      result = await withTimeout(
        setDisplayPrefsAction({
          // ONE knob per call, so the other four are never restated — two tabs,
          // or this tab and a phone, turning different knobs cannot revert each
          // other. Every field in `SetDisplayPrefsInput` is optional for exactly
          // this reason.
          [knob]: value,
          idempotencyKey: keyFor(`${knob}:${String(value)}`),
          expectedUpdatedAt: prefs.updatedAt,
        } as Parameters<typeof setDisplayPrefsAction>[0]),
        WRITE_TIMEOUT_MS,
      );
    } catch {
      // A server action REJECTS when the network is gone. This is the offline
      // path, and the rule for it is the app's rule everywhere: the write is
      // refused, the control comes back, and nothing is queued to replay later
      // (DEC-011).
      setPending(null);
      setError("Couldn't save that. Check your connection and try again.");
      return;
    }

    if ("timedOut" in result) {
      // The key is deliberately NOT rotated, so trying again replays rather than
      // writing twice.
      setPending(null);
      setError("That took too long. Try again, it will not save twice.");
      return;
    }

    if (result.ok || result.kind === "conflict") {
      // A conflict is not an error to a person here: another device already
      // moved this, and the honest response is to show what it set. A reload
      // does exactly that, because the server is where the value lives now.
      //
      // THE THEME'S DEVICE HALF, and ONLY on `ok`.
      //
      // `result.kind === "conflict"` means the server did NOT store this value:
      // another device's write won. Writing it to `localStorage` anyway would
      // put the LOSING value on this device, and then reload straight into it.
      // A reload is the right answer to a conflict precisely because the server
      // is the authority; caching the value the server just rejected would
      // contradict that in the same breath.
      //
      // Written AFTER the round trip, never before: `localStorage` is not a
      // cache of the profile, it is this device's answer for the first paint,
      // and setting it for a write that then failed would leave the device
      // disagreeing with the account with nothing on screen to explain it.
      if (result.ok && knob === "theme") writeThemeLocal(value as ThemeChoice);

      if (REPAINTS.includes(knob)) {
        window.location.reload();
        return;
      }
      setPending(null);
      setSaved(true);
      return;
    }
    setPending(null);
    setError(
      result.kind === "auth" ? "Your session expired. Sign in again." : "Couldn't save that.",
    );
  }

  const busy = pending !== null;
  const density = current<Density>("density", prefs.density);
  const typeScale = current<TypeScale>("typeScale", prefs.typeScale);
  const theme = current<ThemeChoice>("theme", prefs.theme);
  const landingView = current<string>("landingView", prefs.landingView || "queue");
  const hints = current<boolean>("keyboardHints", prefs.keyboardHints);

  return (
    <div
      data-testid="preferences-form"
      data-hydrated={hydrated ? "true" : "false"}
      className="min-w-0"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base leading-6 font-semibold text-text">Preferences</h2>
        {/* The design's tick. `role="status"` so it is announced once rather
            than being a visual-only confirmation, and it renders only after a
            write really landed — never on first paint, which would claim a save
            nobody made. */}
        {saved ? (
          <span
            role="status"
            data-testid="preferences-saved"
            className="inline-flex items-center gap-1 text-xs text-muted"
          >
            {/* Lucide, not the design's inline path, for `display-popover.tsx`'s
                reason: every mark in this repo comes from lucide-react, and an
                inlined SVG puts a literal `fill="none"` in front of the copy
                gate, which reads "none" as a value word wherever it appears. */}
            <Check aria-hidden className="size-3 stroke-[2.5]" />
            Saved
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-muted">Changes save as you make them.</p>

      <div className="mt-6 flex flex-col gap-4">
        <Field id="prefs-density" label="Density">
          <select
            id="prefs-density"
            data-testid="prefs-density"
            className={selectClass}
            value={density}
            disabled={busy}
            onChange={(e) => write("density", e.target.value as Density)}
          >
            {/* The labels are the design's; the values are the wire format.
                `lib/grid/display-prefs.ts` states why the two disagree: the 02
                dictionary owns what a person reads, the column owns what the
                stylesheet matches, and `dense` renders as "Compact". */}
            <option value={DENSITIES[1]}>Comfortable</option>
            <option value={DENSITIES[0]}>Compact</option>
          </select>
        </Field>

        <Field id="prefs-type-scale" label="Type size">
          <select
            id="prefs-type-scale"
            data-testid="prefs-type-scale"
            className={selectClass}
            value={typeScale}
            disabled={busy}
            onChange={(e) => write("typeScale", e.target.value as TypeScale)}
          >
            <option value={TYPE_SCALES[0]}>Default</option>
            <option value={TYPE_SCALES[1]}>Large</option>
          </select>
        </Field>

        <Field id="prefs-theme" label="Theme">
          <select
            id="prefs-theme"
            data-testid="prefs-theme"
            className={selectClass}
            value={theme}
            disabled={busy}
            onChange={(e) => write("theme", e.target.value as ThemeChoice)}
          >
            <option value={THEMES[0]}>Light</option>
            <option value={THEMES[1]}>Dark</option>
            {/* All three are the design's: `Settings.dc.html` draws exactly
                Light, Dark and System. An earlier version of this comment said
                System was an addition of ours and defended it at length, which
                was a false provenance claim sitting in a file full of true ones.
                It is also the shipped default — 0025's header explains why a
                stored `light` would silently overrule the operating system for
                every existing account. */}
            <option value={THEMES[2]}>System</option>
          </select>
        </Field>

        <Field
          id="prefs-landing-view"
          label="Landing view"
          help="The page that opens when you sign in."
        >
          <select
            id="prefs-landing-view"
            data-testid="prefs-landing-view"
            aria-describedby="prefs-landing-view-help"
            className={selectClass}
            value={landingView}
            disabled={busy}
            onChange={(e) => write("landingView", e.target.value)}
          >
            {LANDING_VIEW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>

        <div className="flex gap-3">
          {/* A real switch, not a styled div: `role="switch"` with
              `aria-checked`, reachable and operable from the keyboard because it
              is a `<button>`. The design draws a 32x18 track with a 14px knob. */}
          {/*
            TWO THINGS ABOUT THIS CONTROL ARE DELIBERATE AND NEITHER IS WHAT THE
            MOCK DRAWS.

            RADIUS. `Settings.dc.html` draws the track at `border-radius:999px`.
            04 §3.3 says "Controls: 6px radius" and lists exactly two exemptions,
            badges and avatars; a switch is neither. So the track is `rounded-md`
            (6px), the control radius, and the conflict is recorded as DEV-015
            rather than resolved by taste. It is emphatically NOT 12px: 12 would
            be a number chosen because the sweep tests `r > 12`, and 04 §7.2
            fails a wrong component radius independently of whether any detector
            noticed.

            TARGET SIZE. The drawn track is 32x18, and WCAG 2.2 SC 2.5.8 wants a
            24x24 minimum. Nothing in this repo enforces that — the axe runs all
            filter to wcag2a/2aa plus serious|critical — so the button is the
            HIT AREA at 32x24 and the track is a span inside it, drawn at the
            18px the design asks for. The visual is the design's; the thing a
            thumb has to find is a third taller.
          */}
          <button
            type="button"
            role="switch"
            id="prefs-keyboard-hints"
            data-testid="prefs-keyboard-hints"
            aria-checked={hints}
            aria-describedby="prefs-keyboard-hints-help"
            disabled={busy}
            onClick={() => write("keyboardHints", !hints)}
            className={
              "inline-flex h-6 w-8 shrink-0 items-center justify-center rounded-md " +
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            }
          >
            <span
              aria-hidden
              className={
                "inline-flex h-4.5 w-8 items-center rounded-md border p-px " +
                (hints
                  ? "justify-end border-accent bg-accent"
                  : "justify-start border-border-strong bg-border-strong")
              }
            >
              <span
                className={
                  // The knob stays fully round: it is a 14x14 square, which the
                  // radius rule exempts as a genuine circle rather than a pill.
                  "size-3.5 rounded-full " + (hints ? "bg-accent-fg" : "bg-surface")
                }
              />
            </span>
          </button>
          <div className="min-w-0 flex-1">
            <label htmlFor="prefs-keyboard-hints" className="text-sm font-medium text-text">
              Keyboard hints
            </label>
            <p id="prefs-keyboard-hints-help" className="text-xs text-muted">
              Shows shortcut keys next to actions and in menus.
            </p>
          </div>
        </div>
      </div>

      {error ? (
        <p role="status" data-testid="preferences-error" className="mt-4 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
