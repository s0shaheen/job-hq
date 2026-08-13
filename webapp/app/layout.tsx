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
 * LIGHT MODE ONLY (DEC-014, issue #240 — owner design ruling). Dark mode is
 * removed, not hidden: there is no `.dark` token block, no theme preference,
 * and no pre-paint bootstrap script resolving one. `globals.css` declares
 * `color-scheme: light`, which is what keeps a dark OS from restyling form
 * controls on its own; `tests/e2e/theme.spec.ts` asserts a dark OS renders
 * exactly what a light one does.
 *
 * Two stored values from the dark era can still exist and are deliberately
 * never read, which is how they degrade without erroring: the `hq-theme`
 * localStorage key on any device that used the old control, and the
 * `profiles.display_theme` column (0025) until a migration retires it.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read HERE and not in the (app) layout: these are attributes on `<html>`,
  // and `<html>` belongs to the root layout. A nested layout cannot set them,
  // and a wrapper `<div>` would leave every portal — toasts, dropdown menus,
  // dialogs, all of which render into `document.body` — outside the scale the
  // person chose, which is the one place large type matters most.
  const prefs = await shellDisplayPrefs();
  const attrs = displayAttributes(prefs);

  return (
    <html
      lang="en"
      // `undefined` for every default, so an account that has changed nothing
      // renders markup byte-identical to what it rendered before 0025 — which
      // is what keeps every committed visual baseline valid.
      data-type-scale={attrs["data-type-scale"]}
      data-density={attrs["data-density"]}
    >
      <body>{children}</body>
    </html>
  );
}
