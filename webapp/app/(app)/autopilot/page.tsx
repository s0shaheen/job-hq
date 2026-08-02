import Link from "next/link";
import { buttonClass, EmptyState, PageHeader } from "@/components/ds";

// Bare, like every other page: the root layout's title template glues the
// product name on (`%s, Job Search HQ`), and a pipe is banned glue anyway.
export const metadata = { title: "Autopilot" };

/**
 * /autopilot — a nav destination with no surface behind it yet (03 section 6;
 * step 5 of the 07 section 5 cutover order, and auto-submit stays off until
 * the log and the notifications work).
 *
 * The three things named in the copy are the surface's three tabs — Review,
 * Answers, Rules — not a rhetorical triple. 02 section 3.3.6 bans the rule of
 * three as a reflex; a list has the length its content has, and this one has
 * three because the room has three tabs.
 */
export default function AutopilotPage() {
  return (
    <div className="min-w-0 p-4 md:p-6">
      <PageHeader title="Autopilot" />
      <EmptyState title="Staged applications, your saved answers, and the rules that govern them will live here.">
        <Link href="/settings/answers" className={buttonClass({ variant: "primary" })}>
          Go to your answers
        </Link>
      </EmptyState>
    </div>
  );
}
