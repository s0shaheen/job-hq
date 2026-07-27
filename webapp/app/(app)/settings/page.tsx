import { getDataSource } from "@/lib/data/get-source";
import { draftFromPreset } from "@/lib/profile/presets";
import { DisplayPrefs } from "./display-prefs";
import ProfileForm from "./profile-form";

export const metadata = { title: "Search profile — Job Search HQ" };
export const dynamic = "force-dynamic";

/**
 * /settings — the Search Profile, editable, with a dry run in front of the save.
 *
 * This page used to be a set of read-only cards whose only job was to give the
 * queue's "why was this filtered" popover somewhere to link to. The anchors are
 * unchanged and they are still the contract: every `id` on a section is a
 * `reasonSetting()` output (plans/README C11, "do not invent a second id set"),
 * and `routing.spec.ts` derives the list from that function so a new reason kind
 * fails the suite until its section lands here.
 *
 * `data-profile-version` is the SERVER's copy of `profiles.updated_at`. Tests
 * wait on it changing rather than on a client counter, because a counter lives
 * in a component that can unmount and a monotonic value that resets is worse
 * than none (matrix rows 117 and 164). It doubles as the conflict token the
 * form sends back.
 */
export default async function SettingsPage() {
  const src = await getDataSource();
  const profile = await src.profile();

  return (
    <div
      className="min-w-0"
      data-profile-version={profile.updatedAt ?? ""}
      data-onboarded={profile.criteria ? "yes" : "no"}
    >
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <h1 className="text-lg font-semibold">Search profile</h1>
        <p className="text-xs text-muted">
          What reaches your queue, and what gets skipped. Nothing takes effect
          until you save, and you can see what a change would do first.
        </p>
      </header>

      <div className="mx-auto max-w-2xl px-4 pt-5 sm:px-6">
        <DisplayPrefs />
      </div>

      <ProfileForm
        // Mostly unreachable: the onboarding guard sends an un-onboarded user
        // to the wizard. `other` rather than a job family, so a page reached
        // some other way does not propose a product-management search to
        // somebody who never asked for one — it renders the warning above the
        // role box instead, which says what is missing.
        initial={profile.criteria ?? draftFromPreset("other")}
        version={profile.updatedAt}
      />
    </div>
  );
}
