/**
 * The company-universe fixture set — deterministic data for demo mode and the
 * E2E suite.
 *
 * It is built to make the /companies grid's *hard* cases reachable, because the
 * lesson this repo keeps relearning is that a fixture set which only contains
 * comfortable rows ships the uncomfortable states unlooked-at (matrix row 15).
 * So it deliberately carries, from the real research findings in
 * docs/plans/COMPANY-DISCOVERY-RESEARCH.md:
 *
 *   - all three reliability tiers AND unresolved rows (tier null), so the
 *     coverage meter's unresolved slice is never zero;
 *   - all four resolution confidences — a probed Greenhouse board (verified), a
 *     CXS-confirmed Workday tenant (verified), an aggregator-covered iCIMS
 *     employer (inferred), a Common-Crawl slug nobody re-probed (asserted), a
 *     hand-pasted name (asserted) — because a meter that cannot show the
 *     grounded/inferred/unverified split is the exact false-confidence the
 *     research pass warned about;
 *   - a resolution_method this app does not recognise, so the "unrecognised
 *     method reads as unverified" rule has a row to prove itself on;
 *   - a slug-only row with an EMPTY name (Common Crawl mines boards, not names),
 *     which is the case a naive name cell renders as a blank line;
 *   - a deliberately enormous name, for the same reason FIXTURE_JOBS carries a
 *     huge title: long content must truncate, not blow out the layout;
 *   - proposed, approved and dismissed rows, so all three working sets and both
 *     bulk verbs are exercisable without a write.
 */
import type { CompanyView } from "./view-models";

/** Pinned clock, matching FIXTURE_NOW in fixtures.ts. */
export const FIXTURE_COMPANY_NOW = "2026-07-21T12:00:00.000Z";

function at(offsetSeconds: number): string {
  return new Date(new Date(FIXTURE_COMPANY_NOW).getTime() + offsetSeconds * 1000).toISOString();
}

/**
 * 0013's two fields are optional here and default to "no id pasted yet", because
 * that is the state every row starts in and the one the paste prompt exists for.
 * Three rows below set one explicitly — a fixture set where the "has an id"
 * branch is unreachable ships the warm-links popover unlooked-at, which is
 * matrix row 15 with a different surface.
 */
type Seed = Omit<
  CompanyView,
  "key" | "linkedinCompanyId" | "linkedinIdSource" | "domain" | "companyUpdatedAt"
> & {
  key?: string;
  linkedinCompanyId?: string;
  linkedinIdSource?: string;
  domain?: string | null;
  companyUpdatedAt?: string;
};

function company(seed: Seed): CompanyView {
  return {
    linkedinCompanyId: "",
    // Nobody has answered, which is what an empty id means. A seed that sets an id
    // has to say who set it — the two are one fact and the demo would otherwise
    // render every id as bot-written.
    linkedinIdSource: "",
    // No domain harvested yet — the LogoAvatar's monogram branch, which is the
    // state MOST rows start in. The few rows below that set one give the logo.dev
    // branch a company to render, so neither ships unlooked-at (matrix row 15).
    domain: null,
    // The SHARED row's token. Deliberately a DIFFERENT value from `updatedAt`:
    // if the fixture made them equal, a caller sending the wrong one would work
    // in the demo and conflict in production — the fake being kinder than the
    // real thing, which is the bug class this repo keeps paying for.
    companyUpdatedAt: at(100 + seed.id),
    ...seed,
    key: String(seed.id),
  };
}

export const FIXTURE_COMPANIES: CompanyView[] = [
  // ---- approved, verified tier 1: the comfortable majority ----------------
  company({
    id: 101,
    name: "Ramp",
    ats: "ashby",
    slug: "ramp",
    source: "seed",
    tier: 1,
    resolutionMethod: "discover-ashby",
    reviewState: "approved",
    enabled: true,
    priority: true,
    seeded: true,
    updatedAt: at(0),
    // Somebody pasted this one, so the warm-links popover has a row to render
    // its full link set on.
    linkedinCompanyId: "12345678",
    // A PERSON pasted it, so the popover offers no change control — they know where
    // the number came from, and the surface they used is the one they already know.
    // This is also the row `visual.spec.ts` screenshots, so it is the row that must
    // keep rendering exactly what it rendered before 0016.
    linkedinIdSource: "human",
    // A harvested domain, so the LogoAvatar's logo.dev branch has a company to render.
    domain: "ramp.com",
  }),
  company({
    id: 102,
    name: "Databricks",
    ats: "greenhouse",
    slug: "databricks",
    source: "seed",
    tier: 1,
    resolutionMethod: "discover-greenhouse",
    reviewState: "approved",
    enabled: true,
    priority: false,
    seeded: true,
    updatedAt: at(1),
    // An id with NO connections behind it, so "links but nobody you know" is a
    // reachable state and not the same cell as "no id at all".
    linkedinCompanyId: "3608",
    // The SWEEP found this one (0016's harvest off a TheirStack row), which makes
    // this the fixture that reaches the correction control — the state where a bot
    // wrote an id and somebody may need to disagree with it. Deliberately a company
    // no popover baseline opens, so the control is covered by the functional e2e
    // project and no screenshot has to be re-recorded to see it.
    linkedinIdSource: "engine",
    domain: "databricks.com",
  }),
  // Workday via the careers-page redirect, confirmed by a CXS jobs POST — the
  // grounded keystone of the Dad universe (research: 12/32 fingerprinted here).
  company({
    id: 103,
    name: "Northern Trust",
    ats: "workday",
    slug: "ntrs.wd1.myworkdayjobs.com/careers",
    source: "edgar",
    tier: 1,
    resolutionMethod: "workday-redirect",
    reviewState: "approved",
    enabled: true,
    priority: false,
    seeded: false,
    updatedAt: at(2),
    domain: "northerntrust.com",
  }),
  // Two states in one row, both of which a comfortable fixture set would hide:
  //
  //   * Approved but NOT swept — proves `enabled` is a real column and not a
  //     synonym for approval.
  //   * APPROVED and Tier 1 but only `ingested-slug` — a mined board nobody
  //     probed. This is the row that makes the coverage meter's "N are marked
  //     Tier 1, so M of those are expected rather than seen" line reachable at
  //     all. Without it every approved row is verified, the gap is zero, and the
  //     one number the whole widget exists to separate never renders.
  company({
    id: 104,
    name: "Fifth Third Bank",
    ats: "greenhouse",
    slug: "fifththird",
    source: "commoncrawl",
    tier: 1,
    resolutionMethod: "ingested-slug",
    reviewState: "approved",
    enabled: false,
    priority: false,
    seeded: true,
    // Connections here and NO company id: the one combination that proves the
    // two halves of the popover are independent — names to ask without the deep
    // links, and the paste prompt still on screen.
    linkedinCompanyId: "",
    updatedAt: at(3),
  }),

  // ---- approved, tier 2, INFERRED: reachable but not proven --------------
  company({
    id: 105,
    name: "Aon",
    ats: "icims",
    slug: "aon",
    source: "formadv",
    tier: 2,
    resolutionMethod: "aggregator",
    reviewState: "approved",
    enabled: true,
    priority: false,
    seeded: false,
    updatedAt: at(4),
  }),

  // ---- proposed: the review pile the two bulk verbs act on ----------------
  company({
    id: 106,
    name: "Cboe Global Markets",
    ats: "workday",
    slug: "cboe.wd1.myworkdayjobs.com/careers",
    source: "edgar",
    tier: 1,
    resolutionMethod: "workday-redirect",
    reviewState: "proposed",
    enabled: false,
    priority: false,
    seeded: false,
    updatedAt: at(5),
  }),
  // A mined slug nobody probed. The research pass found Common Crawl "contains
  // dead boards", so this must not read as verified — and it carries NO name,
  // which is the real shape of a mined row.
  company({
    id: 107,
    name: "",
    ats: "greenhouse",
    slug: "loopreturns",
    source: "commoncrawl",
    tier: 1,
    resolutionMethod: "ingested-slug",
    reviewState: "proposed",
    enabled: false,
    priority: false,
    seeded: false,
    updatedAt: at(6),
  }),
  // Pasted by hand: tier 3, no board, tracked not pulled.
  company({
    id: 108,
    name: "Grainger",
    ats: "",
    slug: "",
    source: "paste",
    tier: 3,
    resolutionMethod: "manual",
    reviewState: "proposed",
    enabled: false,
    priority: false,
    seeded: false,
    updatedAt: at(7),
  }),
  // No tier at all: the unresolved slice the coverage meter must show.
  company({
    id: 109,
    name: "Citadel",
    ats: "",
    slug: "",
    source: "edgar",
    tier: null,
    resolutionMethod: "",
    reviewState: "proposed",
    enabled: false,
    priority: false,
    seeded: false,
    updatedAt: at(8),
  }),
  // A method this app has never heard of. It must read as UNVERIFIED, not as
  // evidence — defaulting the other way is how a meter lies.
  company({
    id: 110,
    name: "Old Republic International",
    ats: "brassring",
    slug: "oldrepublic",
    source: "theirstack",
    tier: 2,
    resolutionMethod: "vendor-hint-2026",
    reviewState: "proposed",
    enabled: false,
    priority: false,
    seeded: false,
    updatedAt: at(9),
  }),
  // The long-content row. Layout must truncate it, at every width.
  company({
    id: 111,
    name: "Guggenheim Partners Investment Management Holdings International Advisory Group",
    ats: "workday",
    slug: "guggenheimpartners.wd1.myworkdayjobs.com/GuggenheimCareers",
    source: "formadv",
    tier: 1,
    resolutionMethod: "workday-redirect",
    reviewState: "proposed",
    enabled: false,
    priority: false,
    seeded: false,
    updatedAt: at(10),
  }),

  // ---- dismissed: kept, so the agent does not re-propose -----------------
  company({
    id: 112,
    name: "Zzzq Nonexistent Holdings",
    ats: "",
    slug: "",
    source: "agent",
    tier: null,
    resolutionMethod: "",
    reviewState: "dismissed",
    enabled: false,
    priority: false,
    seeded: false,
    updatedAt: at(11),
  }),
];
