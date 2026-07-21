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
