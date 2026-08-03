import type { Metadata } from "next";
import "./globals.css";
import { displayAttributes } from "@/lib/display/prefs";
import { shellDisplayPrefs } from "@/lib/display/server";

export const metadata: Metadata = {
  // A template, so no page has to glue the product name onto its own title
  // with a separator glyph. Every child sets a plain name ("Today"); the
  // comma is the one separator the copy spec allows between adjacent pieces
  // of text.
  title: { default: "Job Search HQ", template: "%s, Job Search HQ" },
  description: "The human surface for the family job-search system",
  robots: { index: false, follow: false },
};

/**
 * Applies the theme before first paint.
 *
 * The dark palette is class-driven (`.dark`) rather than media-driven, so that
 * an explicit user choice can beat the OS. That only works if something
 * actually sets the class — and for a while nothing did, so every visitor on a
 * dark OS silently got the light theme while the CSS comment claimed
 * otherwise. The token tests passed because they set the class by hand.
 *
 * This runs synchronously in <head>, before the body paints, so the correct
 * theme is the first thing rendered rather than a flash of the wrong one. It
 * is inline and dependency-free for the same reason: an external script would
 * paint first and correct itself afterwards.
 *
 * TYPE SCALE AND DENSITY ARE NO LONGER HERE. They used to be read out of the
 * `hq_display` cookie by this same script; migration 0025 moved them onto
 * `profiles`, and the attributes are now rendered on `<html>` below, on the
 * SERVER — which puts them in the first byte of the document rather than in the
 * first script that runs against it. `lib/display/server.ts` states the whole
 * argument.
 *
 * Theme is the one knob that cannot make that trip completely, and the reason
 * is not laziness: `system` means "ask the operating system", and a server
 * cannot. So an explicit stored preference is rendered as a class by the server
 * and this script resolves the `system` case, while still honouring a
 * `localStorage` choice — which is what a browser with no account has, and what
 * `tests/e2e/theme.spec.ts` drives.
 *
 * ── PRECEDENCE: THE PROFILE, THEN localStorage, THEN THE OS ────────────────
 *
 * That order used to be the other way round, and the reversal is a fix, not a
 * preference. `localStorage` outranking the profile was harmless only while
 * NOTHING in this app wrote `hq-theme` — which was true until Settings gained
 * the theme control, at which point every device that has ever used the control
 * carries a value and the dormant precedence became the normal case.
 *
 * What it did, in full: choose Light on a laptop and Dark on a phone, and the
 * laptop's server render is correctly `<html class="dark">` from the profile,
 * this script then reads `"light"` out of `localStorage`, wins, and strips the
 * class. The laptop paints dark and snaps to light ON EVERY PAGE LOAD — the
 * exact flash this mechanism exists to prevent — and it is pinned there
 * permanently, because no setting the person can reach changes which value
 * wins. The account preference is the shared, cross-device answer; the device
 * copy exists to make the FIRST paint right, not to overrule the account.
 *
 * SETTINGS → PREFERENCES still writes both halves — the profile through
 * `setDisplayPrefsAction`, and `localStorage` on the device that made the
 * choice — so a device that has never signed in, or is rendering before its
 * profile read lands, still paints the right palette. Writing both remains
 * correct; what changed is which one wins when they disagree.
 *
 * THE RESIDUAL, STATED. `system` is the absence of a choice, so the server
 * deliberately renders no `data-theme-pref` for it (see the attribute below) —
 * and that is indistinguishable from a signed-out browser or a profile read
 * that failed open. So a stale explicit `hq-theme` on device B is NOT cleared
 * by choosing `system` on device A: B keeps its local answer. Closing that
 * needs the server to distinguish "explicitly system" from "no answer", which
 * is a column, which is a migration. Recorded as DEV-018; the control clears
 * the key on the device where `system` is chosen, which is the half that can be
 * fixed without one.
 *
 * This comment previously credited the Display popover with writing both
 * halves, and the popover has no theme control: `DisplayPopover.d.ts` carries
 * columns, density, type size and keyboard hints, and nothing else.
 */
const THEME_BOOTSTRAP = `
try {
  var root = document.documentElement;
  var stored = localStorage.getItem("hq-theme");
  /* The profile's answer, read back off the element the server rendered rather
     than interpolated into this string a second time — one source for the
     value, and nothing user-controlled inside a script tag. */
  var pref = root.getAttribute("data-theme-pref") || stored || "system";
  var dark = pref === "dark" ? true
    : pref === "light" ? false
    : window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
} catch (e) {
  /* Private mode can throw on localStorage. A theme is never worth a blank
     page, so fall through and keep the default light palette. */
}
`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read HERE and not in the (app) layout: these are attributes on `<html>`,
  // and `<html>` belongs to the root layout. A nested layout cannot set them,
  // and a wrapper `<div>` would leave every portal — toasts, dropdown menus,
  // dialogs, all of which render into `document.body` — outside the scale the
  // person chose, which is the one place large type matters most.
  const prefs = await shellDisplayPrefs();
  const attrs = displayAttributes(prefs);

  return (
    // suppressHydrationWarning: the script above mutates <html> before React
    // hydrates, so the client class legitimately differs from the server's.
    <html
      lang="en"
      // `undefined` for every default, so an account that has changed nothing
      // renders markup byte-identical to what it rendered before 0025 — which
      // is what keeps every committed visual baseline valid.
      data-type-scale={attrs["data-type-scale"]}
      data-density={attrs["data-density"]}
      // Read by the script above. Rendered only when the person made a choice:
      // `system` IS the absence of one, and an attribute stating it would be a
      // value nothing reads differently from its own absence.
      data-theme-pref={prefs.theme === "system" ? undefined : prefs.theme}
      className={prefs.theme === "dark" ? "dark" : undefined}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
