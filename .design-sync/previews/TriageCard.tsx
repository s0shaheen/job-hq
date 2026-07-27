import { TriageCard } from "hq-webapp";

/**
 * Rows and mismatch copy ported from the app's own fixture set
 * (lib/data/fixtures.ts) and from `mismatchFor` in queue/triage-queue.tsx — the
 * function that actually writes the warning line this card renders.
 *
 * The fixture set is deliberately awkward: a posting with no compensation, a
 * very long title and company, a role with no stated years. Those are the cards
 * worth looking at, so they are the cards here.
 */

type Job = React.ComponentProps<typeof TriageCard>["job"];

function job(seed: Partial<Job> & Pick<Job, "company" | "title">): Job {
  return {
    url: "https://boards.greenhouse.io/example",
    posted: "2026-07-19",
    industry: null,
    compRange: null,
    minYoe: null,
    workModel: null,
    location: null,
    remote: false,
    roleFocus: null,
    skills: [],
    ...seed,
  };
}

/** Everything stated — the shape a well-tagged posting arrives in. */
export function Default() {
  return (
    <TriageCard
      job={job({
        company: "Ramp",
        title: "Product Manager, Core Platform",
        industry: "Fintech — spend management",
        location: "New York, NY",
        workModel: "Hybrid",
        compRange: "$165,000 - $210,000",
        minYoe: 3,
        roleFocus: "Ledger, billing and money movement",
        skills: ["Payments", "Platform / APIs", "SQL", "Experimentation"],
        posted: "2026-07-19",
      })}
    />
  );
}

/**
 * No stated pay. The tile still renders — an absent tile reads as a narrower
 * posting, "Not listed" reads as a question to answer first.
 */
export function CompensationNotListed() {
  return (
    <TriageCard
      job={job({
        company: "Chime",
        title: "Associate Product Manager",
        industry: "Consumer fintech",
        location: "San Francisco, CA",
        workModel: "Hybrid",
        minYoe: 2,
        roleFocus: "Member onboarding and activation",
        skills: ["Growth", "Onboarding", "A/B testing"],
        posted: "2026-07-17",
      })}
      mismatch="Compensation is not listed — worth checking before you invest time."
    />
  );
}

/** Flagged, never auto-rejected: the gap is named and the decision stays yours. */
export function AboveYourYearsLimit() {
  return (
    <TriageCard
      job={job({
        company: "Databricks",
        title: "Principal Product Manager",
        industry: "Data platform",
        location: "San Francisco, CA",
        workModel: "Hybrid",
        compRange: "$220,000 - $290,000",
        minYoe: 8,
        roleFocus: "Lakehouse governance and sharing",
        skills: ["Data platform", "Governance", "Enterprise"],
        posted: "2026-07-18",
      })}
      mismatch="Asks for 8+ years — 4 above your limit of 4."
    />
  );
}

/**
 * The layout stress case: an unbroken company name and a title long enough to
 * wrap twice. Neither may paint past the card edge, where the page's
 * overflow-x:hidden clips it out of reach.
 */
export function LongTitleAndCompany() {
  return (
    <TriageCard
      job={job({
        company: "Northwestern Mutual Investment Services",
        title: "Senior Product Manager, Enterprise Data Platform & Reporting Infrastructure",
        industry: "Financial services",
        location: "Chicago, IL",
        workModel: "Hybrid — 3 days onsite",
        compRange: "$150,000 - $195,000",
        minYoe: 4,
        roleFocus: "Internal data platform and regulatory reporting",
        skills: ["Data platform", "Reporting", "Stakeholder management", "SQL", "Governance"],
        posted: "2026-07-16",
      })}
    />
  );
}

/** Remote, no stated years, no focus or skills yet — the sparse end of the set. */
export function RemoteAndUntagged() {
  return (
    <TriageCard
      job={job({
        company: "Mercury",
        title: "Product Manager, Banking",
        industry: "Business banking",
        location: "Remote (US)",
        workModel: "Remote (US)",
        compRange: "$160,000 - $200,000",
        remote: true,
        posted: "2026-07-15",
      })}
    />
  );
}
