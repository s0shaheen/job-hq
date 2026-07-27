import { Check, Filter, Inbox, ListChecks, SearchX } from "lucide-react";
import { Button, EmptyState, buttonClass } from "hq-webapp";

/**
 * The component's docstring names three flavours and says why collapsing them
 * is how a working system looks broken. All four cards below are lifted from the
 * app's own call sites — queue/triage-queue.tsx, pipeline/page.tsx,
 * jobs/jobs-grid.tsx and companies/companies-grid.tsx.
 *
 * Note which ones carry an action and which do not: "you finished" is a reward
 * and needs no door, "nothing matches" needs an escape hatch, and "nothing yet"
 * needs an explanation with somewhere to go.
 */

/** You finished. A reward, and it should read like one. */
export function Finished() {
  return (
    <EmptyState
      icon={<Check aria-hidden="true" className="size-8" />}
      title="Triaged all 19 — nice."
      body="The queue is clear. New roles arrive with the next sweep."
    />
  );
}

/** Nothing matches — the user's own filters did this, so hand back the undo. */
export function NothingMatches() {
  return (
    <EmptyState
      icon={<SearchX aria-hidden="true" className="size-8" />}
      title="Nothing matches these filters"
      body="Your filters hide all 412 postings in this set."
      action={<Button variant="primary">Clear filters</Button>}
    />
  );
}

/** Nothing yet — an explanation, and a door. An explanation alone is half of one. */
export function NothingYet() {
  return (
    <EmptyState
      icon={<ListChecks aria-hidden="true" className="size-8" />}
      title="No applications yet"
      body="Applications appear here when you mark a role interesting. Emailed status updates land in the spreadsheet today; the pipeline reads them once the capture writes here too."
      action={
        <a href="#queue" className={buttonClass({ variant: "primary" })}>
          Go to triage
        </a>
      }
    />
  );
}

/**
 * A setting gated everything out — kept apart from "nothing found", because one
 * is a quiet day and the other is a knob the user can widen. Saying "nothing to
 * triage" here is how a working system convinces somebody it is dead.
 */
export function ASettingFilteredEverything() {
  return (
    <EmptyState
      icon={<Filter aria-hidden="true" className="size-8" />}
      title="Your pay floor filtered everything out"
      body="That setting removed 104 of the 136 postings found. For example: Associate Product Manager at Fifth Third Bank — pays below your floor (under 150k)."
      action={
        <a href="#compMin" className={buttonClass({ variant: "primary" })}>
          Adjust your pay floor
        </a>
      }
    />
  );
}
