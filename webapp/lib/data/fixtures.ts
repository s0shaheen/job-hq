/**
 * Deterministic fixture data — powers demo mode and every test.
 *
 * Two rules make this useful rather than decorative:
 *
 *   1. **Fixed clock.** Everything is dated relative to FIXTURE_NOW, and
 *      nothing calls Date.now() at module scope. Tests freeze the browser
 *      clock to FIXTURE_NOW, so "2d ago" is "2d ago" forever and visual
 *      snapshots do not rot overnight.
 *   2. **Realistic and awkward.** The set deliberately includes the cases that
 *      break layouts and reveal lazy rendering: a posting with no compensation,
 *      a very long title, a company with a long name, a role with no stated
 *      years, a remote row with no city, and rows filtered for each distinct
 *      reason. A fixture set of tidy rows tests nothing.
 */
import type { ApplicationView, BotRunRow, ChannelHealthView, JobView } from "./view-models";

/** The instant every fixture date is relative to. Tests pin the clock here. */
export const FIXTURE_NOW = "2026-07-21T15:00:00.000Z";

function daysAgo(n: number): string {
  const t = new Date(FIXTURE_NOW).getTime() - n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function stampAgo(hours: number): string {
  return new Date(new Date(FIXTURE_NOW).getTime() - hours * 3_600_000).toISOString();
}

/**
 * The URL the board would have given us, per ATS family.
 *
 * It was `https://example.com/jobs/<key>` for every row, which was fine while
 * nothing read it — and stopped being fine the moment Prepare did.
 * `resolveApplyTarget` reads the BOARD TOKEN out of a Greenhouse URL, so a demo
 * of example.com links exercises the "this URL names no board" branch on every
 * row and the fetchable one on none. That is the shape the house rule is about:
 * a fake that answers a different question than production.
 *
 * The token is the company name with everything but letters and digits removed,
 * which is what a real Greenhouse slug looks like.
 */
function boardUrl(key: string, company: string): string {
  const dash = key.indexOf("-");
  const ats = dash > 0 ? key.slice(0, dash) : "";
  const id = dash > 0 ? key.slice(dash + 1) : key;
  const token = company.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (ats === "greenhouse") return `https://boards.greenhouse.io/${token}/jobs/${id}`;
  if (ats === "ashby") return `https://jobs.ashbyhq.com/${token}/${id}`;
  if (ats === "lever") return `https://jobs.lever.co/${token}/${id}`;
  return `https://example.com/jobs/${key}`;
}

type Seed = Partial<JobView> & Pick<JobView, "key" | "company" | "title">;

function job(seed: Seed): JobView {
  return {
    url: boardUrl(seed.key, seed.company),
    location: null,
    metro: null,
    market: "US",
    country: "United States",
    remote: false,
    workModel: null,
    compRange: null,
    compMinK: null,
    compMaxK: null,
    minYoe: null,
    seniority: null,
    industry: null,
    roleFocus: null,
    skills: [],
    posted: daysAgo(3),
    firstSeen: daysAgo(2),
    // Tagged by default: the set is mostly rows the engine has already
    // analysed, and an untagged default would make every fixture re-gate to
    // needs-info. The one deliberately-untagged row sets it back to null.
    taggedAt: stampAgo(30),
    status: "Seen",
    disposition: "qualified",
    dispositionReason: "",
    triage: "",
    snoozeUntil: null,
    // NOT SETTABLE ON A JOB SEED, and that is the point. In production a job's
    // domain is not a posting column at all: `SupabaseDataSource` resolves it from
    // the user's COMPANY universe by name key, so a posting whose employer is not in
    // that universe has no domain and renders a monogram. `FixtureDataSource` now
    // derives it the same way (`applyDomains`), which is why the seeds below no
    // longer carry one.
    //
    // The seeds used to hard-code `companyDomain: "plaid.com"`, `"mercury.com"`,
    // `"stripe.com"` and `"moderntreasury.com"` — none of those four companies is in
    // FIXTURE_COMPANIES, so the demo showed logos where production shows initials,
    // and the LogoAvatar is being built against the demo. Both branches stay
    // reachable through companies that exist on BOTH sides: `Ramp` and `Databricks`
    // carry a domain in the company universe (the logo.dev branch), `Fifth Third
    // Bank` is in the universe with no domain harvested yet, and everything else is
    // outside it — the three states, honestly (matrix row 15).
    companyDomain: null,
    updatedAt: stampAgo(5),
    ...seed,
  };
}

export const FIXTURE_JOBS: JobView[] = [
  job({
    key: "greenhouse-8814021", company: "Ramp", title: "Product Manager, Core Platform",
    location: "New York, NY", metro: "New York", workModel: "Hybrid",
    compRange: "$165,000 - $210,000", compMinK: 165, compMaxK: 210,
    minYoe: 3, seniority: "PM", industry: "Fintech, spend management",
    roleFocus: "Ledger, billing and money movement",
    skills: ["Payments", "Platform / APIs", "SQL", "Experimentation"],
    posted: daysAgo(2), firstSeen: daysAgo(1),
  }),
  job({
    key: "ashby-3f21a9c4", company: "Plaid", title: "Product Manager, Payments",
    location: "Remote (US)", remote: true, market: "Remote", workModel: "Remote (US)",
    compRange: "$170,000 - $205,000", compMinK: 170, compMaxK: 205,
    minYoe: 4, seniority: "PM", industry: "Fintech — data network",
    roleFocus: "Pay-by-bank and ACH rails",
    skills: ["Payments", "Partnerships", "API design"],
    posted: daysAgo(3), firstSeen: daysAgo(2),
  }),
  job({
    // no stated compensation — exercises "Not listed" everywhere
    key: "lever-77c1-4d0a", company: "Chime", title: "Associate Product Manager",
    location: "San Francisco, CA", metro: "San Francisco Bay Area", workModel: "Hybrid",
    minYoe: 2, seniority: "APM", industry: "Consumer fintech",
    roleFocus: "Member onboarding and activation",
    skills: ["Growth", "Onboarding", "A/B testing"],
    posted: daysAgo(4), firstSeen: daysAgo(3),
  }),
  job({
    // deliberately long title + long company: the layout must not overflow
    key: "greenhouse-9920117", company: "Northwestern Mutual Investment Services",
    title: "Senior Product Manager, Enterprise Data Platform & Reporting Infrastructure",
    location: "Chicago, IL", metro: "Chicago", workModel: "Hybrid, 3 days onsite",
    compRange: "$150,000 - $195,000", compMinK: 150, compMaxK: 195,
    minYoe: 4, seniority: "PM", industry: "Financial services",
    roleFocus: "Internal data platform and regulatory reporting",
    skills: ["Data platform", "Reporting", "Stakeholder management", "SQL", "Governance"],
    posted: daysAgo(5), firstSeen: daysAgo(4),
  }),
  job({
    // no stated YoE at all
    key: "smartrec-551209", company: "Mercury", title: "Product Manager, Banking",
    location: "Remote (US)", remote: true, market: "Remote", workModel: "Remote (US)",
    compRange: "$160,000 - $200,000", compMinK: 160, compMaxK: 200,
    seniority: "PM", industry: "Business banking",
    roleFocus: "Accounts, cards and treasury",
    skills: ["Banking", "Compliance", "Platform"],
    posted: daysAgo(6), firstSeen: daysAgo(5),
  }),
  job({
    key: "ashby-c7d9e001", company: "Brex", title: "Product Manager, Spend",
    location: "New York, NY", metro: "New York", workModel: "Hybrid",
    compRange: "$158,000 - $198,000", compMinK: 158, compMaxK: 198,
    minYoe: 3, seniority: "PM", industry: "Corporate cards",
    roleFocus: "Spend controls and approvals",
    skills: ["Fintech", "Workflow", "B2B"],
    posted: daysAgo(6), firstSeen: daysAgo(5),
  }),
  job({
    key: "greenhouse-1120044", company: "Modern Treasury", title: "Product Manager, Ledgers",
    location: "Remote (US)", remote: true, market: "Remote", workModel: "Remote",
    compRange: "$175,000 - $215,000", compMinK: 175, compMaxK: 215,
    minYoe: 4, seniority: "PM", industry: "Payment operations",
    roleFocus: "Double-entry ledger product",
    skills: ["Ledgers", "Accounting", "APIs"],
    posted: daysAgo(7), firstSeen: daysAgo(6),
  }),
  job({
    key: "lever-2ab8-9911", company: "Vanta", title: "Product Manager, Compliance Automation",
    location: "Remote (US)", remote: true, market: "Remote", workModel: "Remote (US)",
    compRange: "$155,000 - $190,000", compMinK: 155, compMaxK: 190,
    minYoe: 3, seniority: "PM", industry: "Security compliance",
    roleFocus: "Automated evidence collection",
    skills: ["Compliance", "Automation", "B2B SaaS"],
    posted: daysAgo(8), firstSeen: daysAgo(7),
  }),
  // ---- already triaged (they must not reappear in the queue)
  job({
    key: "greenhouse-4410982", company: "Stripe", title: "Product Manager, Billing",
    location: "Seattle, WA", metro: "Seattle", workModel: "Hybrid",
    compRange: "$185,000 - $240,000", compMinK: 185, compMaxK: 240,
    minYoe: 5, seniority: "Senior", triage: "interested",
    industry: "Payments", roleFocus: "Subscription billing",
    skills: ["Billing", "Payments", "Platform"],
    posted: daysAgo(9), firstSeen: daysAgo(8),
  }),
  job({
    key: "ashby-90ab12cd", company: "Notion", title: "Product Manager, Growth",
    location: "New York, NY", metro: "New York", workModel: "Hybrid",
    compRange: "$170,000 - $210,000", compMinK: 170, compMaxK: 210,
    minYoe: 4, triage: "dismissed", seniority: "PM",
    industry: "Productivity", roleFocus: "Self-serve growth",
    skills: ["Growth", "Consumer"], posted: daysAgo(10), firstSeen: daysAgo(9),
  }),
  job({
    key: "greenhouse-3312876", company: "Figma", title: "Product Manager, Platform",
    location: "San Francisco, CA", metro: "San Francisco Bay Area", workModel: "Hybrid",
    compRange: "$178,000 - $222,000", compMinK: 178, compMaxK: 222,
    minYoe: 4, triage: "snoozed", snoozeUntil: daysAgo(-3), seniority: "PM",
    industry: "Design tools", roleFocus: "Plugin and extensibility platform",
    skills: ["Platform", "Developer tools"], posted: daysAgo(11), firstSeen: daysAgo(10),
  }),
  // ---- filtered, one per distinct reason (the "why?" view renders these)
  job({
    key: "workday-R_1472470", company: "Wise", title: "Product Manager, Transfers",
    location: "London, United Kingdom", market: "United Kingdom",
    country: "United Kingdom",
    compRange: "£85,000 - £110,000", minYoe: 3,
    disposition: "filtered", dispositionReason: "geo:United Kingdom",
    posted: daysAgo(4), firstSeen: daysAgo(3),
  }),
  job({
    key: "eightfold-88201", company: "Microsoft", title: "Senior Product Manager, Azure",
    location: "Hyderabad, Telangana, IND", market: "India", country: "India",
    minYoe: 6, disposition: "filtered", dispositionReason: "geo:India",
    posted: daysAgo(5), firstSeen: daysAgo(4),
  }),
  job({
    key: "greenhouse-7781200", company: "Databricks", title: "Principal Product Manager",
    location: "San Francisco, CA", metro: "San Francisco Bay Area",
    compRange: "$220,000 - $290,000", compMinK: 220, compMaxK: 290, minYoe: 8,
    seniority: "Principal", disposition: "filtered", dispositionReason: "yoe:8>4",
    posted: daysAgo(3), firstSeen: daysAgo(2),
  }),
  job({
    key: "lever-6612-77aa", company: "Retool", title: "Product Manager, Internal Tools",
    location: "Austin, TX", metro: "Austin", compRange: "$95,000 - $115,000",
    compMinK: 95, compMaxK: 115, minYoe: 3,
    disposition: "filtered", dispositionReason: "comp:<120k",
    posted: daysAgo(4), firstSeen: daysAgo(3),
  }),
  job({
    key: "smartrec-330091", company: "Anduril", title: "Product Manager, Mission Systems",
    location: "Costa Mesa, CA", metro: "Los Angeles", workModel: "Onsite",
    compRange: "$170,000 - $210,000", compMinK: 170, compMaxK: 210, minYoe: 4,
    disposition: "filtered", dispositionReason: "work-model:onsite",
    posted: daysAgo(6), firstSeen: daysAgo(5),
  }),
  job({
    key: "oraclehcm-99120", company: "Global Logistics Co", title: "Product Manager",
    location: "2 Locations", market: null, country: null,
    disposition: "filtered", dispositionReason: "geo-unknown",
    posted: daysAgo(7), firstSeen: daysAgo(6),
  }),
  // ---- the board took it down while it was still undecided
  //
  // Qualified and untriaged, so every predicate that forgets to check `status`
  // will happily offer it as work. Acceptance criterion 16 says a Closed
  // posting is absent from the queue; without a Closed row in the fixture set
  // that assertion cannot fail, and for a while it could not.
  job({
    key: "greenhouse-5540118", company: "Affirm", title: "Product Manager, Checkout",
    location: "New York, NY", metro: "New York", workModel: "Hybrid",
    compRange: "$168,000 - $205,000", compMinK: 168, compMaxK: 205,
    minYoe: 4, seniority: "PM", industry: "Buy now, pay later",
    roleFocus: "Checkout conversion", skills: ["Payments", "Conversion"],
    status: "Closed",
    posted: daysAgo(24), firstSeen: daysAgo(23),
  }),

  // ---- awaiting analysis
  job({
    key: "radancy-40012", company: "Fifth Third Bank", title: "Product Owner, Digital",
    location: "Chicago, IL", metro: "Chicago",
    disposition: "needs-info", dispositionReason: "awaiting-tags", taggedAt: null,
    posted: daysAgo(1), firstSeen: stampAgo(6).slice(0, 10),
  }),
];

/**
 * One application, with the fields P8 added defaulted.
 *
 * A helper rather than five hand-written literals: `statusActor` decides whether
 * the human-wins lock is engaged, and a row that got it wrong by omission would
 * be a fixture quietly asserting the opposite of what its test says. The derived
 * fields (`noteCount`, `latestNote`, `postingStatus`) are here only to satisfy
 * the type — `FixtureDataSource.withNotes()` recomputes all three on every read,
 * because a stored copy is exactly what matrix row 54 is about.
 */
function app(
  a: Omit<ApplicationView, "statusActor" | "noteCount" | "latestNote" | "postingStatus"> &
    Partial<Pick<ApplicationView, "statusActor">>,
): ApplicationView {
  return {
    statusActor: "system",
    noteCount: 0,
    latestNote: null,
    postingStatus: null,
    ...a,
  };
}

export const FIXTURE_APPLICATIONS: ApplicationView[] = [
  app({
    id: 1, postingKey: "greenhouse-4410982", company: "Stripe",
    title: "Product Manager, Billing", url: "https://boards.greenhouse.io/stripe/jobs/4410982",
    status: "Interview", suggestedStatus: null,
    evidence: "https://mail.google.com/mail/u/0/#inbox/abc123",
    appliedDate: daysAgo(21), nextAction: "Prep the ledger case study",
    nextActionDate: daysAgo(-2), notes: "Recruiter screen went well. Panel is 3 rounds.",
    updatedAt: stampAgo(30),
  }),
  // The suggestion row: Applied with a bot suggesting Rejected, which is what
  // Confirm / Not-this are driven against. `statusActor` stays `system` — the
  // whole point is that nothing human has claimed it yet.
  app({
    id: 2, postingKey: "ashby-3f21a9c4", company: "Plaid",
    title: "Product Manager, Payments", url: "https://jobs.ashbyhq.com/plaid/3f21a9c4",
    status: "Applied", suggestedStatus: "Rejected",
    evidence: "https://mail.google.com/mail/u/0/#inbox/def456",
    appliedDate: daysAgo(14), nextAction: null, nextActionDate: null,
    notes: null, updatedAt: stampAgo(50),
  }),
  app({
    id: 3, postingKey: null, company: "Anthropic",
    title: "Product Manager, Developer Platform", url: "https://example.com/jobs/manual-1",
    status: "Applied", suggestedStatus: null, evidence: null,
    appliedDate: daysAgo(9), nextAction: "Follow up with referrer",
    nextActionDate: daysAgo(-1), notes: "Referred by a Norvale alum.",
    updatedAt: stampAgo(72),
  }),
  app({
    id: 4, postingKey: "greenhouse-8814021", company: "Ramp",
    title: "Product Manager, Core Platform", url: "https://boards.greenhouse.io/ramp/jobs/8814021",
    status: "Queued", suggestedStatus: null, evidence: null,
    appliedDate: null, nextAction: "Tailor résumé", nextActionDate: daysAgo(-1),
    notes: null, updatedAt: stampAgo(4),
  }),
  // Terminal, so Reopen is reachable — and Reopen is the one gesture the
  // database refuses without a note.
  app({
    id: 5, postingKey: null, company: "Datadog", title: "Product Manager, Observability",
    url: null, status: "Rejected", suggestedStatus: null,
    evidence: "https://mail.google.com/mail/u/0/#inbox/ghi789",
    appliedDate: daysAgo(35), nextAction: null, nextActionDate: null,
    notes: "Auto-rejection 3 weeks after applying.", updatedAt: stampAgo(200),
  }),
  // An application whose posting the BOARD has dropped (greenhouse-5540118 is
  // the Closed row in FIXTURE_JOBS). The delisted badge is derived from that
  // posting on every read, so without this row nothing could assert it appears —
  // and, just as importantly, the row must STAY in its status group: §G2 is
  // explicit that a delisted posting does not remove the application.
  app({
    id: 6, postingKey: "greenhouse-5540118", company: "Affirm",
    title: "Product Manager, Checkout", url: "https://boards.greenhouse.io/affirm/jobs/5540118",
    status: "Screen", suggestedStatus: null,
    evidence: "https://mail.google.com/mail/u/0/#inbox/jkl012",
    appliedDate: daysAgo(18), nextAction: null, nextActionDate: null,
    notes: null, updatedAt: stampAgo(90),
  }),
  // A status no vocabulary defines. The sheet allows one and `statusRank` ranks
  // it highest by construction; without a row like this, "an invented status
  // still renders" (matrix row 53) is unfalsifiable. Claimed by a human, so it
  // also covers the locked-row rendering.
  // …and the row that reaches Prepare's `no-board` refusal. A company careers
  // page carrying `?gh_jid=` is knowably Greenhouse and unfetchable — the schema
  // is keyed by the BOARD TOKEN and this URL has only the job id — which is a
  // different sentence from "not Greenhouse" and from "the fetch failed".
  //
  // It was unreachable through the demo: `15460da` gave every fixture row a real
  // board URL, which fixed the opposite hole (the fetchable branch was the one
  // nothing could reach) and closed this one. The branch is cited four times as
  // the reason for the other fixture URLs, so leaving one screen without a path
  // to it is the same rule applied unevenly (matrix row 15).
  app({
    id: 7, postingKey: null, company: "Brex", title: "Product Manager, Spend",
    url: "https://www.brex.com/careers/open-roles?gh_jid=7788991",
    status: "waiting on referral", statusActor: "user", suggestedStatus: null,
    evidence: null, appliedDate: daysAgo(6), nextAction: "Ping Dev again",
    nextActionDate: daysAgo(-4), notes: null, updatedAt: stampAgo(120),
  }),
  // The row Prepare can stage COMPLETELY. Its demo board (see
  // `lib/apply/demo-boards.ts`) asks for no file, which is the only way a staged
  // application reaches `ready` at all — every real Greenhouse posting asks for a
  // résumé, and Prepare does not attach. Without this row the green card, the
  // `batchApprovable` rendering and the "an opinion, not permission" sentence
  // beside it would ship having never been looked at (matrix row 15).
  app({
    id: 8, postingKey: "greenhouse-1120044", company: "Modern Treasury",
    title: "Product Manager, Ledgers",
    url: "https://boards.greenhouse.io/moderntreasury/jobs/1120044",
    status: "Queued", suggestedStatus: null, evidence: null,
    appliedDate: null, nextAction: null, nextActionDate: null,
    notes: null, updatedAt: stampAgo(3),
  }),
];

export const FIXTURE_HEALTH: ChannelHealthView[] = [
  { channel: "monitor", ranAt: stampAgo(4), fetched: 812, newRows: 46, filtered: 39, tagged: 45, errors: 8, ageHours: 4, cadenceHours: 12 },
  { channel: "review", ranAt: stampAgo(9), fetched: 0, newRows: 0, filtered: 0, tagged: 3, errors: 0, ageHours: 9, cadenceHours: 24 },
  { channel: "cafe", ranAt: stampAgo(26), fetched: 120, newRows: 2, filtered: 0, tagged: 0, errors: 0, ageHours: 26, cadenceHours: 24 },
  { channel: "theirstack", ranAt: stampAgo(6), fetched: 25, newRows: 0, filtered: 0, tagged: 0, errors: 0, ageHours: 6, cadenceHours: 24 },
  { channel: "tracker", ranAt: stampAgo(1), fetched: 0, newRows: 0, filtered: 0, tagged: 0, errors: 0, ageHours: 1, cadenceHours: 2 },
  { channel: "capture", ranAt: stampAgo(0.3), fetched: 43, newRows: 15, filtered: 0, tagged: 0, errors: 0, ageHours: 0.3, cadenceHours: 1.5 },
];

/**
 * Per-run bot rows (bot_runs, migration 0023) — the Activity tab's source.
 *
 * Deliberately spans every branch of `activityForJob`, so the mapper is
 * exercised by demo mode and the parity test rather than only by hand-written
 * unit cases:
 *   - monitor      succeeded 2h ago, with counts   → "Last succeeded 2h ago",
 *                                                     "38 roles checked, 2 new"
 *   - digest       succeeded, no counts            → "completed"
 *   - tracker      an OPEN row (finishedAt null)    → "Running"
 *   - theirstack   three failures after a success   → "Failing since Jul 19"
 *                                                     ("since" is the streak's
 *                                                     start, not the newest fail)
 */
export const FIXTURE_BOT_RUNS: BotRunRow[] = [
  { job: "monitor", startedAt: stampAgo(2.05), finishedAt: stampAgo(2), ok: true, fetched: 38, newRows: 2, error: null },
  { job: "monitor", startedAt: stampAgo(14.1), finishedAt: stampAgo(14), ok: true, fetched: 40, newRows: 1, error: null },
  { job: "digest", startedAt: stampAgo(8.02), finishedAt: stampAgo(8), ok: true, fetched: 0, newRows: 0, error: null },
  { job: "tracker", startedAt: stampAgo(0.05), finishedAt: null, ok: null, fetched: 0, newRows: 0, error: null },
  { job: "tracker", startedAt: stampAgo(2.02), finishedAt: stampAgo(2), ok: true, fetched: 0, newRows: 0, error: null },
  { job: "theirstack", startedAt: stampAgo(6.1), finishedAt: stampAgo(6), ok: false, fetched: 0, newRows: 0, error: "TheirStack API returned 429" },
  { job: "theirstack", startedAt: stampAgo(30.1), finishedAt: stampAgo(30), ok: false, fetched: 0, newRows: 0, error: "TheirStack API returned 429" },
  { job: "theirstack", startedAt: stampAgo(54.1), finishedAt: stampAgo(54), ok: false, fetched: 0, newRows: 0, error: "TheirStack API returned 429" },
  { job: "theirstack", startedAt: stampAgo(78.1), finishedAt: stampAgo(78), ok: true, fetched: 25, newRows: 0, error: null },
];
