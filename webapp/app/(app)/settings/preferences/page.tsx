import { Suspense } from "react";
import { shellDisplayPrefs } from "@/lib/display/server";
import { PreferencesForm } from "../preferences-form";
import { PreferencesSkeleton } from "../preferences-skeleton";
import { SettingsShell } from "../settings-shell";

export const metadata = { title: "Preferences" };
export const dynamic = "force-dynamic";

/**
 * /settings/preferences — the second section of the rail.
 *
 * Four knobs, all of them already durable on `profiles` since migration 0025,
 * all of them written through the same `setDisplayPrefsAction` the retired
 * `display-prefs.tsx` used. This route is presentation over a frozen command.
 * (The mock's fifth knob, Theme, is removed — light mode only, DEC-014.)
 *
 * The Email block `Settings.dc.html` draws below these is NOT here, and
 * that is ADD-022: two of its three toggles (Status updates, Submission record)
 * govern capabilities the pilot does not have, so shipping the block as drawn
 * would put two controls on screen that nothing performs.
 *
 * Read through `shellDisplayPrefs`, not `src.displayPrefs()` directly: it is a
 * React `cache()`, so this is the SAME read the root layout already made for the
 * `<html>` attributes. One query, and — the part that matters — no way for the
 * control and the page it renders on to show two different answers.
 */
export default function SettingsPreferencesPage() {
  return (
    // The shell is outside the boundary for `/settings`'s reason: the rail is
    // the thing a person navigates with, and making it wait on this read would
    // blank the one control that still works while the read is slow.
    <SettingsShell active="preferences">
      <Suspense fallback={<PreferencesSkeleton />}>
        <PreferencesSection />
      </Suspense>
    </SettingsShell>
  );
}

async function PreferencesSection() {
  const prefs = await shellDisplayPrefs();

  return (
    // The version token, published for the same reason `/settings` publishes
    // the profile's: a test waiting on a client counter is waiting on state
    // that can unmount, and this one comes from the server.
    <div data-display-version={prefs.updatedAt ?? ""}>
      <PreferencesForm prefs={prefs} />
    </div>
  );
}
