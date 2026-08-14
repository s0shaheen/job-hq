/**
 * The corpus the profile preview runs against in demo mode and in tests.
 *
 * Separate from `FIXTURE_JOBS` on purpose. That set is one user's gated slice —
 * nineteen rows, all of them already dispositioned — and the preview asks a
 * different question: what does the SHARED posting universe look like to a
 * profile that does not exist yet? `app_preview_corpus` deliberately widens
 * past RLS for exactly that reason, so the fake has to model the widened thing.
 *
 * The distribution is chosen to make three failures reachable rather than
 * assumed, which is the rule a fake earns its keep by:
 *
 *   1. **The title-coverage banner fires for one of the two presets.** Three of
 *      these 140 postings carry an FP&A title (2.1%, under the 5% floor), which
 *      is the finance preset's situation: the engine has only ever swept PM
 *      titles into this universe, so an FP&A preview reads near-zero and it is
 *      not the profile's fault. A corpus that matched both presets equally
 *      would let the banner ship unexercised.
 *   2. **Geo masks comp.** Twelve foreign rows pay well and eleven US rows pay
 *      badly, so a reason histogram credits geo and the relaxation pass finds
 *      the floor behind it.
 *   3. **Untagged rows exist**, so `needs-info` is a real bucket and the
 *      `comp_unknown` policy has rows it must NOT judge.
 *
 * Deterministic: index arithmetic, no clock, no RNG. Every date is relative to
 * FIXTURE_NOW, so a demo screenshot taken today looks like one taken in March.
 */
import type { PreviewPosting } from "@/lib/profile/preview";
import type { ProfileCriteria } from "@/lib/profile/criteria";
import { BASE_CRITERIA } from "@/lib/profile/criteria";
import { presetById } from "@/lib/profile/presets";
import type { ProfileView } from "./source";
import { FIXTURE_NOW } from "./fixtures";

function daysAgo(n: number): string {
  return new Date(new Date(FIXTURE_NOW).getTime() - n * 86_400_000).toISOString().slice(0, 10);
}

const PM_TITLES = [
  "Product Manager, Payments",
  "Senior Product Manager",
  "Associate Product Manager",
  "Technical Product Manager",
  "Group Product Manager, Risk",
  "Product Manager — Core Platform",
  "Director of Product",
  "Principal Product Manager, Ledger",
  "Forward Deployed Engineer, Product",
  "Product Operations Manager",
];

/**
 * Three, out of 140. Not zero: a corpus with NO matching titles makes the
 * banner fire on a division that never has a numerator, and the interesting
 * case is the one where a handful trickle in and the number still means "the
 * engine is not sweeping for this yet".
 */
const FPA_TITLES = ["Senior Financial Analyst", "FP&A Manager", "Treasury Analyst"];

const COMPANIES = [
  "Ramp", "Plaid", "Brex", "Stripe", "Mercury", "Modern Treasury",
  "Northwestern Mutual", "Fifth Third Bank", "Grainger", "Abbott",
];

const METROS = ["Chicago", "New York", "San Francisco Bay Area", "Denver", ""];
const WORK_MODELS = ["Remote (US)", "Hybrid — Chicago", "Onsite", ""];

function build(): PreviewPosting[] {
  const out: PreviewPosting[] = [];
  for (let i = 0; i < 140; i += 1) {
    // Three FP&A titles, spaced so they are not adjacent and cannot be sliced
    // off by a test that only looks at the head of the list.
    const isFpa = i === 17 || i === 71 || i === 128;
    const title = isFpa ? FPA_TITLES[[17, 71, 128].indexOf(i)] : PM_TITLES[i % PM_TITLES.length];

    // 12 foreign rows, and they are the well-paid ones (mask #2 above).
    const foreign = i % 11 === 3 && i < 132;
    const country = foreign ? (i % 22 === 3 ? "India" : "Canada") : i % 29 === 5 ? "" : "United States";
    const remote = country === "" ? i % 3 === 0 : i % 13 === 0;

    // 8 untagged rows: `needs-info` has to be a bucket somebody can see.
    const untagged = i % 17 === 9;

    // US rows pay poorly often enough that a $150k floor bites hard once geo is
    // relaxed; foreign rows pay well, which is what hides it.
    const stated = i % 3 !== 2;
    const lowBand = !foreign && i % 5 !== 0;
    const min = lowBand ? 95 + (i % 5) * 4 : 150 + (i % 7) * 9;
    const max = min + 35;

    out.push({
      key: `greenhouse-${70000 + i}`,
      company: COMPANIES[i % COMPANIES.length],
      title,
      geo: {
        country,
        remote: remote ? "TRUE" : "",
        metro: country === "United States" ? METROS[i % METROS.length] : "",
        market: remote ? "Remote" : country || "",
      },
      tags: untagged
        ? {}
        : {
            tagged_at: daysAgo((i % 20) + 1),
            min_yoe: i % 7 === 4 ? "" : String(i % 9),
            seniority: i % 9 === 0 ? "Senior" : "PM",
            comp_range: stated ? `$${min},000 - $${max},000` : "",
            work_model: WORK_MODELS[i % WORK_MODELS.length],
          },
      lastSeen: daysAgo(i % 28),
      status: i % 37 === 6 ? "Closed" : "Seen",
    });
  }
  return out;
}

/**
 * Postings the preview considers, newest first — the same order and the same
 * cap `app_preview_corpus` applies (`order by last_seen desc limit 5000`).
 *
 * `Closed` rows are absent, exactly as the SQL excludes them: a dead posting is
 * not evidence about what a profile would let through tomorrow. Modelled here
 * rather than left to production, because a fake more permissive than the query
 * is how the demo's number and the real number quietly stop agreeing.
 */
export const PREVIEW_CORPUS: PreviewPosting[] = build()
  .filter((p) => (p.status ?? "").toLowerCase() !== "closed")
  .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "") || (a.key < b.key ? 1 : -1));

/**
 * The row cap `app_preview_corpus` applies. The two WINDOW bounds live beside
 * `clampWindowDays` in `lib/profile/preview.ts`, because the clamped number is
 * rendered as well as used and both data sources have to get the same one.
 */
export const PREVIEW_MAX_ROWS = 5000;

/**
 * The demo user's saved profile — an invented PM search (RM-40 audit §4: no
 * fixture profile may be any real person's saved criteria).
 *
 * A SAVED profile rather than the bare defaults, because the settings page's
 * whole job is showing somebody what they already chose, and a page that opens
 * on empty chips cannot show that. Every answer-shaped value is stated HERE,
 * explicitly: `BASE_CRITERIA` is the unset baseline since RM-40 Step 4, so
 * anything this spread leaves blank renders as blank — a demo profile leaning
 * on inherited values would be the persona-default bug in a costume.
 * `updatedAt` is the fixture clock: the commit path compares version tokens
 * for EQUALITY, never distance, so a pinned value is faithful here in a way it
 * was not for an undo window (matrix row 162).
 */
export const FIXTURE_PROFILE: ProfileView = {
  criteria: {
    ...BASE_CRITERIA,
    ...((presetById("product-manager") as { criteria: Partial<ProfileCriteria> }).criteria),
    // Stated, not inherited: BASE_CRITERIA's ceiling is null (gate off) now,
    // and the demo profile keeps the ceiling the preview corpus was tuned to.
    yoe_max: 4,
    // Distribution-preserving, not anybody's real list: the corpus above only
    // carries "Senior" and "PM" rows, so keeping "Senior" keeps every preview
    // number and reachable state exactly where it was.
    seniority_exclude: ["Senior", "Director", "VP"],
  },
  notify: { notify_channel: "ntfy" },
  updatedAt: FIXTURE_NOW,
};

/**
 * A user who has signed in and never finished the wizard: `criteria = '{}'`.
 *
 * Reachable through the `onboarding` demo seed, which is what makes the
 * middleware redirect and the wizard testable at all — the full fixture set is
 * deliberately complete, so this state is unreachable by using the app
 * (matrix row 15's lesson, on a new surface).
 */
export const FIXTURE_PROFILE_NEW: ProfileView = {
  criteria: null,
  notify: {},
  updatedAt: null,
};
