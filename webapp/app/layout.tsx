import type { Metadata } from "next";
import "./globals.css";

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
 */
const THEME_BOOTSTRAP = `
try {
  var stored = localStorage.getItem("hq-theme");
  var dark = stored ? stored === "dark"
    : window.matchMedia("(prefers-color-scheme: dark)").matches;
  var root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
} catch (e) {
  /* Private mode can throw on localStorage. A theme is never worth a blank
     page, so fall through and keep the default light palette. */
}
try {
  /* Type scale and density, from a cookie, in the same before-paint window as
     the theme and for the same reason: applying them after hydration means the
     large-type user watches the page reflow on every navigation.

     A COOKIE rather than localStorage, unlike the theme — this is the channel a
     server can write. Today nothing does: the persona default belongs in
     'profiles', and no profile read exists in the data layer yet (that is
     PHASE-PROFILE's). So the mechanism ships, the values are settable, and the
     wizard that will set them is honestly still missing. Playwright drives both
     states through the same cookie.

     Unrecognised values are ignored rather than applied, so a stale or
     hand-edited cookie cannot leave the app in a state no CSS defines. */
  var m = document.cookie.match(/(?:^|;\\s*)hq_display=([^;]*)/);
  if (m) {
    var parts = decodeURIComponent(m[1]).split(",");
    var r = document.documentElement;
    if (parts.indexOf("large") !== -1) r.setAttribute("data-type-scale", "large");
    if (parts.indexOf("comfortable") !== -1) r.setAttribute("data-density", "comfortable");
  }
} catch (e) {
  /* Same rule: a display preference is never worth a blank page. */
}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the script above mutates <html> before React
    // hydrates, so the client class legitimately differs from the server's.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
