import { PreviewPanel } from "hq-webapp";

/**
 * Five states, one panel. The numbers and the sentences are ported from the
 * app's own preview corpus (lib/data/preview-fixtures.ts — 136 postings after
 * Closed rows are dropped, a 30-day window) and from `explainReason` /
 * `FIELD_LABELS`, so every string here is one the real code can produce.
 *
 * The corpus is built so geo masks the pay floor: foreign rows pay well and US
 * rows pay badly, which is why `countries` is the binding constraint below
 * rather than `comp_min`.
 */

const QUALIFIED = [
  {
    key: "greenhouse-70012",
    company: "Ramp",
    title: "Product Manager — Core Platform",
    metro: "New York",
    compRange: "$168,000 - $203,000",
    workModel: "Hybrid — Chicago",
    reason: "",
    explanation: "Matches your search",
  },
  {
    key: "greenhouse-70041",
    company: "Modern Treasury",
    title: "Principal Product Manager, Ledger",
    metro: "San Francisco Bay Area",
    compRange: "$177,000 - $212,000",
    workModel: "Remote (US)",
    reason: "",
    explanation: "Matches your search",
  },
  {
    key: "greenhouse-70083",
    company: "Mercury",
    title: "Technical Product Manager",
    metro: "Denver",
    compRange: "$159,000 - $194,000",
    workModel: "Remote (US)",
    reason: "",
    explanation: "Matches your search",
  },
];

const FILTERED = [
  {
    key: "greenhouse-70003",
    company: "Plaid",
    title: "Product Manager, Payments",
    metro: null,
    compRange: "$186,000 - $221,000",
    workModel: "Remote (US)",
    reason: "geo:Canada",
    explanation: "Located in Canada, outside your countries",
  },
  {
    key: "greenhouse-70025",
    company: "Fifth Third Bank",
    title: "Associate Product Manager",
    metro: "Chicago",
    compRange: "$103,000 - $138,000",
    workModel: "Onsite",
    reason: "comp:<150k",
    explanation: "Pays below your floor (under 150k)",
  },
  {
    key: "greenhouse-70047",
    company: "Grainger",
    title: "Director of Product",
    metro: "Chicago",
    compRange: "$195,000 - $230,000",
    workModel: "Onsite",
    reason: "seniority:Director",
    explanation: 'Seniority "Director" is above your range',
  },
];

const READY = {
  corpusTotal: 136,
  titleMatched: 133,
  titlesConfigured: 6,
  qualified: 24,
  filtered: 104,
  needsInfo: 8,
  reasonCounts: { geo: 41, comp: 33, seniority: 18, "work-model": 12 },
  binding: {
    field: "countries",
    setting: "countries",
    label: "countries",
    recovers: 12,
    sample: "Product Manager, Payments — Located in Canada, outside your countries",
  },
  samples: { qualified: QUALIFIED, filtered: FILTERED },
  windowDays: 30,
  computedAt: "2026-07-21T15:00:00.000Z",
};

/** Before anything has been checked. It says what a check does, and what it costs. */
export function Idle() {
  return <PreviewPanel state={{ kind: "idle" }} onGoToSetting={() => {}} />;
}

/** In flight. Announced, because the numbers replacing it are an answer. */
export function Running() {
  return <PreviewPanel state={{ kind: "running" }} onGoToSetting={() => {}} />;
}

/**
 * The answer: the count, the one setting doing most of the filtering, and
 * examples from both sides. The binding constraint is a link into /settings.
 */
export function Ready() {
  return <PreviewPanel state={{ kind: "ready", preview: READY }} onGoToSetting={() => {}} />;
}

/**
 * The engine has not swept this role family yet — 3 of 136 postings match the
 * titles. The warning exists so the near-zero count does not read as a verdict
 * on the profile; the remedy is waiting, not editing.
 */
export function EngineBehind() {
  return (
    <PreviewPanel
      state={{
        kind: "ready",
        preview: {
          ...READY,
          titleMatched: 3,
          titlesConfigured: 3,
          qualified: 1,
          filtered: 127,
          binding: null,
          samples: {
            qualified: [
              {
                key: "greenhouse-70017",
                company: "Northwestern Mutual",
                title: "Senior Financial Analyst",
                metro: "Chicago",
                compRange: "$118,000 - $153,000",
                workModel: "Hybrid — Chicago",
                reason: "",
                explanation: "Matches your search",
              },
            ],
            filtered: [
              {
                key: "greenhouse-70071",
                company: "Abbott",
                title: "FP&A Manager",
                metro: "Chicago",
                compRange: null,
                workModel: "Onsite",
                reason: "comp-unknown",
                explanation: "Compensation not stated",
              },
              {
                key: "greenhouse-70128",
                company: "Fifth Third Bank",
                title: "Treasury Analyst",
                metro: "Chicago",
                compRange: "$96,000 - $131,000",
                workModel: "Onsite",
                reason: "comp:<150k",
                explanation: "Pays below your floor (under 150k)",
              },
            ],
          },
        },
      }}
      onGoToSetting={() => {}}
    />
  );
}

/**
 * The settings moved after the check ran. A number computed against settings
 * that have since changed is worse than no number, because it looks current.
 */
export function Stale() {
  return <PreviewPanel state={{ kind: "stale", preview: READY }} onGoToSetting={() => {}} />;
}

/** It could not be computed. Never a spinner that never resolves — save anyway. */
export function Failed() {
  return (
    <PreviewPanel
      state={{ kind: "failed", message: "the check timed out after 15 seconds" }}
      onGoToSetting={() => {}}
    />
  );
}
