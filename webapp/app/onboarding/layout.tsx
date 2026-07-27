import { Toaster } from "@/components/ui/toaster";

/**
 * The wizard's own shell: no sidebar, no nav, no queue count.
 *
 * Deliberately not the `(app)` layout. That group carries the onboarding
 * REDIRECT, so a wizard inside it would send itself to itself — and the usual
 * fix, an exception for paths starting `/onboarding`, is a path check somebody
 * eventually gets wrong on a rename. Living outside the group makes the loop
 * impossible rather than avoided.
 *
 * The absence of navigation is also the right product answer: there is nowhere
 * else to go until this is finished, and a sidebar full of links to pages that
 * will redirect straight back is worse than no sidebar.
 *
 * The Toaster comes along because the save can fail and a failure with no
 * surface is a button that does nothing.
 */
export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Toaster />
    </>
  );
}
