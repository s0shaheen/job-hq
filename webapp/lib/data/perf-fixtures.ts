/**
 * Deterministic large-row generator for the grid's perf budgets (matrix row
 * 18, plan rows 25–27).
 *
 * Two rules, both inherited from fixtures.ts and both load-bearing:
 *
 *   1. **Seeded, never random.** The perf thresholds in grid-perf.spec.ts are
 *      only comparable run-to-run if the dataset is byte-identical. A
 *      Math.random anywhere here converts every perf failure into "maybe the
 *      data was different this time".
 *   2. **Awkward at scale.** The 18-row fixture set carries a long title, a
 *      missing comp, a missing YoE and every filter reason; 5000 tidy rows
 *      would test scrolling over data easier than the real feed. The same
 *      cases recur here on fixed cycles, so any window of a few dozen rows the
 *      virtualizer renders contains some of each.
 */
import type { JobView } from "./view-models";
import { FIXTURE_NOW } from "./fixtures";

/**
 * Upper bound on `?perf=` (see app/(app)/jobs/page.tsx). At ~400 bytes a row
 * the RSC payload is ~4MB here — beyond the Supabase source's own 5000-row
 * cap, there is nothing real left to simulate, only a bigger download.
 */
export const PERF_MAX = 10_000;

/**
 * Parse the raw `?perf=` search param into a row count, or 0 for anything that
 * is not a plain digit string (arrays, negatives, "5e3", ""). Closed-set
 * parsing at the boundary, same doctrine as the export request parser: reject,
 * never default-and-guess.
 */
export function clampPerfCount(raw: string | string[] | undefined): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return 0;
  return Math.min(Number(raw), PERF_MAX);
}

/** mulberry32 — tiny seeded PRNG; identical sequence for a given seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Dates relative to the pinned fixture instant — same rule as fixtures.ts. */
function daysAgo(n: number): string {
  const t = new Date(FIXTURE_NOW).getTime() - n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function stampAgo(hours: number): string {
  return new Date(new Date(FIXTURE_NOW).getTime() - hours * 3_600_000).toISOString();
}

const COMPANIES = [
  "Ramp", "Plaid", "Chime", "Mercury", "Brex", "Modern Treasury", "Vanta",
  "Stripe", "Notion", "Figma", "Retool", "Airtable", "Linear", "Vercel",
  "Datadog", "Snowflake", "Affirm", "Marqeta", "Unit", "Lithic", "Column",
  "Increase", "Check", "Gusto", "Rippling", "Deel", "Pilot", "Bench",
  "Northwestern Mutual Investment Services", // the long-company case, at scale
  "Carta", "Pulley", "AngelList",
];

const TITLES = [
  "Product Manager, Core Platform",
  "Product Manager, Payments",
  "Senior Product Manager, Risk",
  "Associate Product Manager",
  "Product Manager, Growth",
  "Product Manager, Ledgers",
  "Product Manager, Onboarding",
  "Staff Product Manager, Infrastructure",
  "Product Manager, Compliance Automation",
  "Product Manager, Developer Platform",
  "Product Owner, Digital Servicing",
  // the wrap-breaking case — a window of rows must always contain some
  "Senior Product Manager, Enterprise Data Platform & Reporting Infrastructure",
];

const LOCATIONS: [string, string | null, boolean][] = [
  // [location, metro, remote]
  ["New York, NY", "New York", false],
  ["San Francisco, CA", "San Francisco Bay Area", false],
  ["Chicago, IL", "Chicago", false],
  ["Remote (US)", null, true],
  ["Austin, TX", "Austin", false],
  ["Seattle, WA", "Seattle", false],
];

const WORK_MODELS = ["Hybrid", "Remote (US)", "Onsite", "Hybrid, 3 days onsite"];

/**
 * Every reason token here maps to a profile setting via `reasonSetting()` —
 * unit-asserted — because an unmapped token would render raw in the Why column
 * and dead-end the settings link the escape hatch is for.
 */
const FILTER_REASONS = [
  "geo:India",
  "geo:United Kingdom",
  "metro:Denver",
  "yoe:8>4",
  "comp:<120k",
  "work-model:onsite",
  "geo-unknown",
  "seniority:Principal",
];

const TRIAGES = ["interested", "dismissed", "snoozed"] as const;

const SKILLS = [
  ["Payments", "Platform / APIs", "SQL"],
  ["Growth", "Onboarding", "A/B testing"],
  ["Ledgers", "Accounting", "APIs"],
  ["Compliance", "Automation", "B2B SaaS"],
  [],
];

/**
 * n rows, identical on every call. Cycles rather than draws where the test
 * suite depends on a case existing (missing comp, filter reasons, triage), and
 * uses the seeded PRNG only for inert variety (which company, which title).
 */
export function makePerfJobs(n: number): JobView[] {
  const rand = mulberry32(0x5eed);
  const rows: JobView[] = [];

  for (let i = 0; i < n; i++) {
    const company = COMPANIES[Math.floor(rand() * COMPANIES.length)];
    const title = TITLES[Math.floor(rand() * TITLES.length)];
    const [location, metro, remote] = LOCATIONS[i % LOCATIONS.length];
    const workModel = remote ? "Remote (US)" : WORK_MODELS[i % WORK_MODELS.length];

    const filtered = i % 6 === 4;
    const needsInfo = !filtered && i % 19 === 11;
    const triaged = !filtered && !needsInfo && i % 7 === 2;

    const compMissing = i % 5 === 0;
    const compMin = 90 + ((i * 7) % 140);
    const compMax = compMin + 30 + (i % 5) * 10;
    const yoeMissing = i % 8 === 6;

    const posted = daysAgo(i % 150);
    const key = `perf-${String(i).padStart(5, "0")}`;
    const triage = triaged ? TRIAGES[i % TRIAGES.length] : "";

    rows.push({
      key,
      company,
      title,
      url: `https://example.com/jobs/${key}`,
      location,
      metro,
      market: remote ? "Remote" : "US",
      country: "United States",
      remote,
      workModel,
      compRange: compMissing
        ? null
        : `$${compMin.toLocaleString("en-US")},000 - $${compMax.toLocaleString("en-US")},000`,
      compMinK: compMissing ? null : compMin,
      compMaxK: compMissing ? null : compMax,
      minYoe: yoeMissing ? null : i % 7,
      seniority: i % 9 === 0 ? "Senior" : "PM",
      industry: "Fintech",
      roleFocus: null,
      skills: SKILLS[i % SKILLS.length],
      posted,
      firstSeen: daysAgo(Math.max(0, (i % 150) - 1)),
      taggedAt: needsInfo ? null : stampAgo((i % 200) + 2),
      status: "Seen",
      disposition: filtered ? "filtered" : needsInfo ? "needs-info" : "qualified",
      dispositionReason: filtered
        ? FILTER_REASONS[i % FILTER_REASONS.length]
        : needsInfo
          ? "awaiting-tags"
          : "",
      triage,
      snoozeUntil: triage === "snoozed" ? daysAgo(-3) : null,
      updatedAt: stampAgo((i % 500) + 1),
    });
  }
  return rows;
}
