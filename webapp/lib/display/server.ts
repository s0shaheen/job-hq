import "server-only";

import { cache } from "react";
import { getDataSource, isConfigured } from "@/lib/data/get-source";
import type { DisplayPrefsView } from "@/lib/data/source";
import { DEFAULT_DISPLAY_PREFS } from "./prefs";

/**
 * The display preferences, for the root layout, before first paint.
 *
 * ── HOW THE FLASH IS AVOIDED, since the cookie this replaces existed for
 *    exactly that property ──────────────────────────────────────────────────
 *
 * `data-type-scale` and `data-density` are attributes on `<html>`, and `<html>`
 * is rendered by `app/layout.tsx` — on the SERVER. So the attributes ship in
 * the HTML document itself, correct on the first byte. There is no window in
 * which the page is painted at the wrong scale, because there is no moment when
 * the browser has markup without them.
 *
 * That is strictly better than what it replaces. The `hq_display` cookie was
 * read by a blocking inline script in `<head>`, which is fast enough to beat
 * FIRST PAINT and is still a script: it costs a `suppressHydrationWarning` on
 * `<html>` (the client legitimately differs from the server), it cannot be read
 * by any server component that wants to reason about the preference, and it is
 * per-browser, so signing in from a phone forgets that somebody needs 16px
 * type. Rendering the attributes means the server and the client agree by
 * construction.
 *
 * ── WHY IT IS SAFE TO PUT A DATABASE READ IN THE ROOT LAYOUT ───────────────
 *
 * `cache()` is React's per-REQUEST memo, so the settings page reading the same
 * values costs nothing extra. The read itself is one row by primary key on a
 * table the session can only see its own row of.
 *
 * It FAILS OPEN to the defaults, deliberately and for the same reason the
 * onboarding guard in `(app)/layout.tsx` does: this runs on every route,
 * including the ones nobody is signed in on and the ones a misconfigured
 * deployment serves. A preference is decoration; it must never be the thing
 * that turns a page into an error. The cost of failing open is one render at
 * the wrong density, which is what happened on every render before E5.
 *
 * `isConfigured()` first so an unconfigured deployment does not pay for a
 * `NotConfiguredError` on every request — that error is deliberate elsewhere
 * (serving fixtures as if they were real is the hole it closes) and there is
 * nothing here worth throwing over.
 */
export const shellDisplayPrefs = cache(async (): Promise<DisplayPrefsView> => {
  if (!isConfigured()) return { ...DEFAULT_DISPLAY_PREFS, updatedAt: null };
  try {
    const src = await getDataSource();
    return await src.displayPrefs();
  } catch {
    return { ...DEFAULT_DISPLAY_PREFS, updatedAt: null };
  }
});
