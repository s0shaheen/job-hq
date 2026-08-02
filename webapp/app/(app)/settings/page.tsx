import Link from "next/link";
import { getDataSource } from "@/lib/data/get-source";
import { shellDisplayPrefs } from "@/lib/display/server";
import { draftFromPreset } from "@/lib/profile/presets";
import { DisplayPrefs } from "./display-prefs";
import ProfileForm from "./profile-form";

export const metadata = { title: "Search profile" };
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
  // Through `shellDisplayPrefs`, not `src.displayPrefs()` directly: it is a
  // React `cache()`, so this is the SAME read the root layout already made for
  // the `<html>` attributes. One query, and — the part that matters — no way
  // for the control and the page it renders on to show two different answers.
  const display = await shellDisplayPrefs();

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

      <div className="mx-auto max-w-2xl space-y-3 px-4 pt-5 sm:px-6">
        <DisplayPrefs prefs={display} />
        {/* The other half of "settings", and deliberately a link rather than a
            section: these ids are the why-popover's contract, and sixteen policy
            topics in that namespace would be sixteen anchors nothing links to. */}
        <section
          id="answers"
          aria-labelledby="answers-heading"
          className="scroll-mt-20 rounded-lg border border-border bg-surface p-4"
        >
          <h2 id="answers-heading" className="text-sm font-semibold">
            Application answers
          </h2>
          <p className="mt-1 text-sm text-muted">
            What an application form can be filled in with: your situation, and every
            question you have answered once. This page decides which jobs reach you; that one
            decides what this app can say on your behalf.
          </p>
          <Link
            href="/settings/answers"
            data-testid="answers-link"
            className="mt-3 inline-block text-sm underline"
          >
            Edit your application answers
          </Link>
        </section>
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
