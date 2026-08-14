import { redirect } from "next/navigation";
import { getDataSource } from "@/lib/data/get-source";
import { draftFromPreset } from "@/lib/profile/presets";
import { clampStep, decodeDraft, DRAFT_PARAM, LAST_STEP } from "@/lib/profile/draft";
import Wizard from "./wizard";

export const metadata = { title: "Set up your search" };
export const dynamic = "force-dynamic";

/**
 * `/onboarding/[step]` — the two-step Search Profile wizard.
 *
 * OUTSIDE the `(app)` route group, deliberately. The onboarding guard lives in
 * that group's layout, so a wizard inside it would redirect to itself forever;
 * putting it here makes the loop structurally impossible rather than avoided by
 * a path check somebody can get wrong. It also means no sidebar, which is
 * right: there is nowhere else to go until this is finished.
 *
 * THE STEP IS A SERVER FACT. It comes from the route segment, so
 * `data-step` cannot advance before a navigation really happened and cannot be
 * reset by a component remounting — matrix row 164, where an import wizard
 * gated on a client counter that unmounted with the step that incremented it,
 * and all four journey tests failed identically with the write path gutted.
 *
 * The draft rides in `?d=`, base64url JSON. Refresh, Back and a pasted link all
 * work because there is nowhere else for the answers to live (row 87).
 */
export default async function OnboardingStep({
  params,
  searchParams,
}: {
  params: Promise<{ step: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { step: rawStep } = await params;
  const sp = await searchParams;
  const step = clampStep(rawStep);
  // An out-of-range or non-numeric step is a real address that renders a real
  // page, not a 404 — the same rule the grid follows for a malformed filter.
  if (String(step) !== rawStep) {
    const q = typeof sp[DRAFT_PARAM] === "string" ? `?${DRAFT_PARAM}=${sp[DRAFT_PARAM]}` : "";
    redirect(`/onboarding/${step}${q}`);
  }

  const src = await getDataSource();
  const profile = await src.profile();

  // Somebody who has already finished has no business here — but they may have
  // arrived from a bookmark, so it is a redirect to the editable page rather
  // than an error. The wizard and /settings edit the same object.
  if (profile.criteria && !sp[DRAFT_PARAM]) redirect("/settings");

  const draft = decodeDraft(typeof sp[DRAFT_PARAM] === "string" ? sp[DRAFT_PARAM] : null);

  return (
    <main
      className="min-h-dvh bg-bg"
      data-step={step}
      data-last-step={LAST_STEP}
      data-onboarded={profile.criteria ? "yes" : "no"}
    >
      <Wizard
        step={step}
        // The raw parameter, not just the decoded object: the client keeps the
        // URL in step with what has been typed, and it needs the exact string
        // already there to know whether a change came from an edit or from the
        // user pressing Back.
        rawDraft={typeof sp[DRAFT_PARAM] === "string" ? sp[DRAFT_PARAM] : ""}
        // A fresh wizard opens EMPTY, not on a preset.
        //
        // It used to open on the product-management preset, because
        // `BASE_CRITERIA.role_family` was "product manager" with an empty
        // title list and the old step-1 radios then read as "Product
        // management selected" over a list matching nothing. With the radios
        // gone the honest starting state is a blank role box: the owner's
        // second complaint was that step one framed the whole app around two
        // professions, and a pre-filled "product manager" is that framing
        // with the radios taken off. `BASE_CRITERIA` itself is the unset
        // baseline since RM-40 Step 4, and `other` states the same emptiness
        // explicitly — belt and braces that agree.
        draft={draft ?? profile.criteria ?? draftFromPreset("other")}
        version={profile.updatedAt}
      />
    </main>
  );
}
