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
import type { ApplicationView, ChannelHealthView, JobView } from "./view-models";

/** The instant every fixture date is relative to. Tests pin the clock here. */
export const FIXTURE_NOW = "2026-07-21T15:00:00.000Z";

function daysAgo(n: number): string {
  const t = new Date(FIXTURE_NOW).getTime() - n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function stampAgo(hours: number): string {
  return new Date(new Date(FIXTURE_NOW).getTime() - hours * 3_600_000).toISOString();
}

type Seed = Partial<JobView> & Pick<JobView, "key" | "company" | "title">;

function job(seed: Seed): JobView {
  return {
    url: `https://example.com/jobs/${seed.key}`,
    location: null,
    metro: null,
    market: "US",
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
    disposition: "qualified",
    dispositionReason: "",
    triage: "",
    snoozeUntil: null,
    updatedAt: stampAgo(5),
    ...seed,
  };
}

export const FIXTURE_JOBS: JobView[] = [
  job({
    key: "greenhouse-8814021", company: "Ramp", title: "Product Manager, Core Platform",
    location: "New York, NY", metro: "New York", workModel: "Hybrid",
    compRange: "$165,000 - $210,000", compMinK: 165, compMaxK: 210,
    minYoe: 3, seniority: "PM", industry: "Fintech — spend management",
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
    location: "Chicago, IL", metro: "Chicago", workModel: "Hybrid — 3 days onsite",
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
    compRange: "$180,000 - $225,000", compMinK: 180, compMaxK: 225,
    minYoe: 4, triage: "snoozed", snoozeUntil: daysAgo(-3), seniority: "PM",
    industry: "Design tools", roleFocus: "Plugin and extensibility platform",
    skills: ["Platform", "Developer tools"], posted: daysAgo(11), firstSeen: daysAgo(10),
  }),
  // ---- filtered, one per distinct reason (the "why?" view renders these)
  job({
    key: "workday-R_1472470", company: "Wise", title: "Product Manager, Transfers",
    location: "London, United Kingdom", market: "United Kingdom",
    compRange: "£85,000 - £110,000", minYoe: 3,
    disposition: "filtered", dispositionReason: "geo:United Kingdom",
    posted: daysAgo(4), firstSeen: daysAgo(3),
  }),
  job({
    key: "eightfold-88201", company: "Microsoft", title: "Senior Product Manager, Azure",
    location: "Hyderabad, Telangana, IND", market: "India",
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
    location: "2 Locations", market: null,
    disposition: "filtered", dispositionReason: "geo-unknown",
    posted: daysAgo(7), firstSeen: daysAgo(6),
  }),
  // ---- awaiting analysis
  job({
    key: "radancy-40012", company: "Fifth Third Bank", title: "Product Owner, Digital",
    location: "Chicago, IL", metro: "Chicago",
    disposition: "needs-info", dispositionReason: "awaiting-tags",
    posted: daysAgo(1), firstSeen: stampAgo(6).slice(0, 10),
  }),
];

export const FIXTURE_APPLICATIONS: ApplicationView[] = [
  {
    id: 1, postingKey: "greenhouse-4410982", company: "Stripe",
    title: "Product Manager, Billing", url: "https://example.com/jobs/greenhouse-4410982",
    status: "Interview", suggestedStatus: null,
    evidence: "https://mail.google.com/mail/u/0/#inbox/abc123",
    appliedDate: daysAgo(21), nextAction: "Prep the ledger case study",
    nextActionDate: daysAgo(-2), notes: "Recruiter screen went well. Panel is 3 rounds.",
    updatedAt: stampAgo(30),
  },
  {
    id: 2, postingKey: "ashby-3f21a9c4", company: "Plaid",
    title: "Product Manager, Payments", url: "https://example.com/jobs/ashby-3f21a9c4",
    status: "Applied", suggestedStatus: "Rejected",
    evidence: "https://mail.google.com/mail/u/0/#inbox/def456",
    appliedDate: daysAgo(14), nextAction: null, nextActionDate: null,
    notes: null, updatedAt: stampAgo(50),
  },
  {
    id: 3, postingKey: null, company: "Anthropic",
    title: "Product Manager, Developer Platform", url: "https://example.com/jobs/manual-1",
    status: "Applied", suggestedStatus: null, evidence: null,
    appliedDate: daysAgo(9), nextAction: "Follow up with referrer",
    nextActionDate: daysAgo(-1), notes: "Referred by a UIUC alum.",
    updatedAt: stampAgo(72),
  },
  {
    id: 4, postingKey: "greenhouse-8814021", company: "Ramp",
    title: "Product Manager, Core Platform", url: "https://example.com/jobs/greenhouse-8814021",
    status: "Queued", suggestedStatus: null, evidence: null,
    appliedDate: null, nextAction: "Tailor résumé", nextActionDate: daysAgo(-1),
    notes: null, updatedAt: stampAgo(4),
  },
  {
    id: 5, postingKey: null, company: "Datadog", title: "Product Manager, Observability",
    url: null, status: "Rejected", suggestedStatus: null,
    evidence: "https://mail.google.com/mail/u/0/#inbox/ghi789",
    appliedDate: daysAgo(35), nextAction: null, nextActionDate: null,
    notes: "Auto-rejection 3 weeks after applying.", updatedAt: stampAgo(200),
  },
];

export const FIXTURE_HEALTH: ChannelHealthView[] = [
  { channel: "monitor", ranAt: stampAgo(4), fetched: 812, newRows: 46, filtered: 39, tagged: 45, errors: 8, ageHours: 4, cadenceHours: 12 },
  { channel: "review", ranAt: stampAgo(9), fetched: 0, newRows: 0, filtered: 0, tagged: 3, errors: 0, ageHours: 9, cadenceHours: 24 },
  { channel: "cafe", ranAt: stampAgo(26), fetched: 120, newRows: 2, filtered: 0, tagged: 0, errors: 0, ageHours: 26, cadenceHours: 24 },
  { channel: "theirstack", ranAt: stampAgo(6), fetched: 25, newRows: 0, filtered: 0, tagged: 0, errors: 0, ageHours: 6, cadenceHours: 24 },
  { channel: "tracker", ranAt: stampAgo(1), fetched: 0, newRows: 0, filtered: 0, tagged: 0, errors: 0, ageHours: 1, cadenceHours: 2 },
  { channel: "capture", ranAt: stampAgo(0.3), fetched: 43, newRows: 15, filtered: 0, tagged: 0, errors: 0, ageHours: 0.3, cadenceHours: 1.5 },
];
