import type { Metadata } from "next";
import "./globals.css";
import { displayAttributes } from "@/lib/display/prefs";
import { shellDisplayPrefs } from "@/lib/display/server";

export const metadata: Metadata = {
  title: "Job Search HQ",
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
 * and this script resolves the `system` case — while still honouring a
 * `localStorage` choice, which is what a browser with no session has and what
 * `tests/e2e/theme.spec.ts` drives. Precedence, stated once: localStorage, then
 * the profile, then the OS. The Display popover writes both halves, so another
 * device gets the right palette from the server rather than a flash.
 */
const THEME_BOOTSTRAP = `
try {
  var root = document.documentElement;
  var stored = localStorage.getItem("hq-theme");
  /* The profile's answer, read back off the element the server rendered rather
     than interpolated into this string a second time — one source for the
     value, and nothing user-controlled inside a script tag. */
  var pref = stored || root.getAttribute("data-theme-pref") || "system";
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
