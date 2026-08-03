import { Suspense } from "react";
import Link from "next/link";
import { getDataSource } from "@/lib/data/get-source";
import { draftFromPreset } from "@/lib/profile/presets";
import ProfileForm from "./profile-form";
import { ProfileSkeleton } from "./profile-skeleton";
import { SectionHeading, SettingsShell } from "./settings-shell";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/**
 * /settings — Profile & search, the first section of the Settings rail.
 *
 * This page used to BE Settings: one `max-w-2xl` column holding a Display card,
 * an answers link and the profile form. `Settings.dc.html` makes it one of five
 * sections behind a 200px rail, so Display moved to Preferences and the three
 * other sections became their own routes. What did NOT move is this one, and
 * that is deliberate — see `sections.ts`.
 *
 * The anchors are unchanged and they are still the contract: every `id` on a
 * section is a `reasonSetting()` output (plans/README C11, "do not invent a
 * second id set"), and `routing.spec.ts` derives the list from that function so
 * a new reason kind fails the suite until its section lands here. A rail that
 * moved Profile & search to `/settings/profile` would have broken all six of
 * those deep links in one commit.
 *
 * `data-profile-version` is the SERVER's copy of `profiles.updated_at`. Tests
 * wait on it changing rather than on a client counter, because a counter lives
 * in a component that can unmount and a monotonic value that resets is worse
 * than none (matrix rows 117 and 164). It doubles as the conflict token the
 * form sends back.
 */
export default function SettingsProfilePage() {
  return (
    // The shell is outside the boundary on purpose: the rail is the thing a
    // person navigates with, and making it wait on a profile read would blank
    // the one control that still works while that read is slow.
    <SettingsShell active="profile">
      <Suspense fallback={<ProfileSkeleton />}>
        <ProfileSection />
      </Suspense>
    </SettingsShell>
  );
}

async function ProfileSection() {
  const src = await getDataSource();
  const profile = await src.profile();

  return (
    <div
      className="min-w-0"
      data-profile-version={profile.updatedAt ?? ""}
      data-onboarded={profile.criteria ? "yes" : "no"}
    >
      <SectionHeading
        title="Profile & search"
        // The design's sentence, verbatim. It states this section's save
        // semantics (explicit, not autosave) and the re-gate rule in one
        // breath, which is the pair 06 §A requires every section to state.
        saveNote="Saved with Save changes. Changes apply to new roles only; roles you've already decided keep their decisions."
      />

      {/* Deliberately a link rather than a section: these ids are the
          why-popover's contract, and sixteen policy topics in that namespace
          would be sixteen anchors nothing links to. The design's IA puts
          Answers under Autopilot, which has no route yet (ADD-003), so the
          door stays here rather than becoming unreachable in between. */}
      <section
        id="answers"
        aria-labelledby="answers-heading"
        className="mt-6 scroll-mt-20 rounded-lg border border-border bg-surface p-4"
      >
        {/* `h2`, matching the profile form's own `Section` headings below it
            rather than nesting under the section title. No axe run in this repo
            can catch a heading regression — every call filters to wcag2a/2aa and
            serious|critical, and `heading-order` is best-practice/moderate — so
            the level here is reasoned rather than measured. The document reads
            h1 Settings, then a flat run of h2 sections, of which this card is
            one; an h3 here would put a deeper heading before its own siblings. */}
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

      <ProfileForm
        // Mostly unreachable: the onboarding guard sends an un-onboarded user
        // to the wizard. `other` rather than a job family, so a page reached
        // some other way does not propose a product-management search to
        // somebody who never asked for one; it renders the warning above the
        // role box instead, which says what is missing.
        initial={profile.criteria ?? draftFromPreset("other")}
        version={profile.updatedAt}
      />
    </div>
  );
}
