/**
 * The dry run: what a profile WOULD have let through, computed without writing
 * anything.
 *
 * The screen exists because of one asymmetry. A wrong `metros` or `yoe_max`
 * produces an empty queue, and an empty queue is indistinguishable from "no
 * jobs were posted". Every other mistake in this app is visible; this one is
 * silent, and it is silent for weeks.
 *
 * One computation, both data sources. `SupabaseDataSource` reads the corpus
 * through `app_preview_corpus` (stable, so Postgres refuses a write) and calls
 * this; `FixtureDataSource` calls it over `PREVIEW_CORPUS`. That is what keeps
 * the demo's numbers and production's numbers the same function rather than two
 * that agree today.
 */
import { dispose, normalizeGateConfig, type GateCriteria, type GateRow } from "@/lib/gating/dispose";
import { titleMatches } from "@/lib/gating/titles";
import { explainReason, reasonSetting } from "@/lib/data/view-models";
import type { ProfileCriteria } from "./criteria";

/**
 * One posting as the preview corpus carries it — the exact projection
 * `app_preview_corpus` returns.
 *
 * No `url`, deliberately: the function is `security definer` and widens a read
 * that RLS would otherwise scope to rows the user was already gated on, so the
 * projection is the narrowest thing that answers the question.
 */
export type PreviewPosting = {
  key: string;
  company: string;
  title: string;
  /** `postings.tags` — min_yoe, seniority, comp_range, work_model, tagged_at. */
  tags: Record<string, unknown>;
  /** `postings.geo` — city, state, country, remote, market, metro. */
  geo: Record<string, unknown>;
  lastSeen: string | null;
  status: string | null;
};

/**
 * A posting shown as an example, and why it landed where it did.
 *
 * Deliberately NOT a `JobView`, which PHASE-PROFILE §2 pencils in: a JobView
 * has a `url`, the corpus does not carry one, and a sample rendered through the
 * job card would offer a link to "". A shape that cannot hold a dead link
 * cannot render one.
 */
export type PreviewSample = {
  key: string;
  company: string;
  title: string;
  metro: string | null;
  compRange: string | null;
  workModel: string | null;
  /** The raw disposition reason. `""` for a qualified sample. */
  reason: string;
  /** …the same thing in English, so the panel does not re-derive it. */
  explanation: string;
};

/**
 * The single change that would recover the most postings.
 *
 * `field` is the criteria key; `setting` is `reasonSetting()`'s vocabulary, so
 * the link lands on an anchor `/settings` already has (plans/README C11 — do
 * not invent a second id set).
 */
export type BindingRelaxation = {
  field: string;
  setting: string;
  label: string;
  /** Postings that qualify with this one field relaxed and did not before. */
  recovers: number;
  /** One posting this field is currently refusing, in English. */
  sample: string;
};

export type PreviewResult = {
  /** Postings in the window, before anything is judged. */
  corpusTotal: number;
  /** …of those, how many match the profile's title lists. */
  titleMatched: number;
  /**
   * How many include-terms the profile carries.
   *
   * Zero is a DIFFERENT state from "the engine has not swept for these titles
   * yet", and conflating them is how the banner ends up telling somebody the
   * engine is behind when in fact they have not said what they are looking for.
   * Found by looking at the recorded screenshot, not by any assertion.
   */
  titlesConfigured: number;
  qualified: number;
  filtered: number;
  needsInfo: number;
  /**
   * reason KIND -> n. First-hit only, because the gate short-circuits.
   *
   * NOT rendered, deliberately, and that is worth a sentence because a computed
   * value nothing reads is usually dead code. This one is the counter-example
   * the design argues against: a histogram of first-hit reasons is exactly what
   * `binding` exists NOT to be, so putting it on screen beside the binding
   * constraint would offer somebody two answers and let them pick the wrong one.
   * It is kept because the unit tests assert on it — `geo` 30, `comp` 6 is how
   * the relaxation pass is shown to disagree with counting — and because a
   * future Health surface reading it would be reading a real measurement.
   */
  reasonCounts: Record<string, number>;
  binding: BindingRelaxation | null;
  samples: { qualified: PreviewSample[]; filtered: PreviewSample[] };
  windowDays: number;
  computedAt: string;
};

/** How many of each kind of example the panel shows. */
export const SAMPLE_LIMIT = 5;

/** The window `app_preview_corpus` defaults to, and its hard ceiling. */
export const PREVIEW_WINDOW_DAYS = 30;
export const PREVIEW_MAX_WINDOW_DAYS = 90;

/**
 * The window, as the SQL will actually apply it:
 * `least(greatest(coalesce(p_days, 30), 1), 90)`.
 *
 * One function, called by both data sources, because the number is rendered as
 * well as used. `SupabaseDataSource` clamped the value it SENT and then handed
 * the panel the raw one, so asking for 3,650 days produced "Of 4,182 postings
 * collected in the last 3650 days" over a 90-day corpus — a sentence with a
 * false number in it, on the one screen whose whole job is a number somebody can
 * trust. The fake clamped properly, which is the wrong way round for a fake and
 * would have hidden it.
 */
export function clampWindowDays(days: number | undefined): number {
  const n = Math.trunc(Number(days ?? PREVIEW_WINDOW_DAYS));
  if (!Number.isFinite(n)) return PREVIEW_WINDOW_DAYS;
  return Math.min(Math.max(n, 1), PREVIEW_MAX_WINDOW_DAYS);
}

/**
 * Below this share of the corpus matching the profile's titles, the preview
 * says so in words instead of letting the gate take the blame.
 *
 * `title_matches` runs at INGEST (`monitor/run.py`, `monitor/wide.py`), so a
 * posting the title filter rejected never entered `postings` at all. A user
 * whose role family is new to the system previews near-zero and the number is
 * not their profile's fault — folding the two together is a lie in exactly the
 * direction this screen exists to prevent.
 */
export const TITLE_COVERAGE_FLOOR = 0.05;

function gateRow(p: PreviewPosting): GateRow {
  return {
    country: p.geo.country,
    remote: p.geo.remote,
    metro: p.geo.metro,
    work_model: p.tags.work_model,
    comp_range: p.tags.comp_range,
    min_yoe: p.tags.min_yoe,
    seniority: p.tags.seniority,
    tagged_at: p.tags.tagged_at,
  };
}

function sample(p: PreviewPosting, reason: string): PreviewSample {
  return {
    key: p.key,
    company: p.company,
    title: p.title,
    metro: typeof p.geo.metro === "string" && p.geo.metro ? p.geo.metro : null,
    compRange: typeof p.tags.comp_range === "string" && p.tags.comp_range ? p.tags.comp_range : null,
    workModel: typeof p.tags.work_model === "string" && p.tags.work_model ? p.tags.work_model : null,
    reason,
    explanation: explainReason(reason),
  };
}

/**
 * criteria field -> the reason KINDS relaxing it recovers.
 *
 * Distinct from `FIELD_SETTING` below, which COLLAPSES several kinds onto one
 * anchor — and that collapse is why the illustration used to be wrong. Picking a
 * sample by setting meant relaxing `geo_unknown` ("how unplaceable locations are
 * handled") could illustrate itself with a posting in India, whose reason is
 * `geo` and whose setting is also `countries`. The sentence named one thing and
 * the example underneath it named another.
 *
 * `seniority` appears twice on purpose: a seniority-filtered row comes back
 * either by dropping the exclusion or by switching `yoe_unknown` to keep, which
 * is the same overlap the tie order below is ordered for.
 */
const FIELD_REASON_KINDS: Record<string, readonly string[]> = {
  countries: ["geo"],
  geo_unknown: ["geo-unknown", "metro-unknown"],
  metros: ["metro"],
  yoe_max: ["yoe"],
  yoe_unknown: ["seniority"],
  seniority_exclude: ["seniority"],
  comp_min: ["comp"],
  comp_unknown: ["comp-unknown"],
  work_model_exclude: ["work-model"],
};

/** criteria field -> the `/settings` anchor a person would go and change. */
const FIELD_SETTING: Record<string, string> = {
  countries: "countries",
  geo_unknown: "countries",
  metros: "metros",
  yoe_max: "yoeMax",
  yoe_unknown: "yoeMax",
  seniority_exclude: "seniorityExclude",
  comp_min: "compMin",
  comp_unknown: "compMin",
  work_model_exclude: "workModelExclude",
};

/**
 * …and how each field is named to a person.
 *
 * The same vocabulary the why-popover and the `/settings` headings use, because
 * this string is rendered as a link INTO one of those headings.
 */
const FIELD_LABELS: Record<string, string> = {
  countries: "countries",
  geo_unknown: "rule for postings with no location",
  metros: "cities",
  yoe_max: "experience limit",
  yoe_unknown: "rule for postings with no years given",
  seniority_exclude: "levels ruled out",
  comp_min: "pay floor",
  comp_unknown: "rule for postings with no salary",
  work_model_exclude: "ways of working",
};

/**
 * Every gate field, relaxed to the value that turns it OFF.
 *
 * `countries` has no off value in `dispose` — an empty list refuses everything
 * — so relaxing it means "accept every country this corpus contains", which is
 * exactly equivalent and needs no sentinel inside the gate. `yoe_max` relaxes
 * to Infinity for the same reason: `Math.trunc(n) > Infinity` is false for
 * every real n, and no reason string is produced from a gate that never fires.
 */
function relaxations(
  base: GateCriteria,
  countriesInCorpus: string[],
): { field: string; config: GateCriteria }[] {
  // ORDER IS THE TIE-BREAK, and the tie is not rare: several refusals are
  // recovered by two fields at once. A `seniority:Director` row comes back
  // either by dropping the exclusion or by switching `yoe_unknown` to keep, and
  // a `comp-unknown` row comes back either by relaxing the unstated-pay policy
  // or by removing the floor entirely. Ties keep the FIRST entry, so each pair
  // is ordered with the more specific advice ahead of the blunter one — telling
  // somebody to delete their compensation floor when the actual problem is that
  // half the feed states no pay is advice about the wrong thing.
  return [
    { field: "countries", config: { ...base, countries: countriesInCorpus } },
    { field: "metros", config: { ...base, metros: [] } },
    { field: "geo_unknown", config: { ...base, geoUnknown: "keep" } },
    { field: "work_model_exclude", config: { ...base, workModelExclude: [] } },
    { field: "comp_unknown", config: { ...base, compUnknown: "keep" } },
    { field: "comp_min", config: { ...base, compMin: 0 } },
    { field: "seniority_exclude", config: { ...base, seniorityExclude: [] } },
    { field: "yoe_max", config: { ...base, yoeMax: Number.POSITIVE_INFINITY } },
    { field: "yoe_unknown", config: { ...base, yoeUnknown: "keep" } },
  ];
}

function countQualified(rows: GateRow[], config: GateCriteria): number {
  let n = 0;
  for (const r of rows) if (dispose(r, config)[0] === "qualified") n += 1;
  return n;
}

/**
 * Run a profile over a corpus and report what it would do.
 *
 * The binding constraint is computed by RELAXATION, not by counting reasons,
 * and that is the whole reason this function is more than a histogram. Gates
 * short-circuit in a fixed order — geo, metro, work-model, comp, YoE — so if
 * geo filters 412 rows first, comp's real impact is invisible behind it. The
 * histogram's top entry is frequently not the thing starving the queue.
 */
export function computePreview(
  corpus: PreviewPosting[],
  criteria: ProfileCriteria,
  opts: { windowDays: number; now: string },
): PreviewResult {
  const config = normalizeGateConfig(criteria);
  const rows = corpus.map(gateRow);

  let qualified = 0;
  let filtered = 0;
  let needsInfo = 0;
  let titleMatched = 0;
  const reasonCounts: Record<string, number> = {};
  const qualifiedSamples: PreviewSample[] = [];
  const filteredSamples: PreviewSample[] = [];
  const countries = new Set<string>();

  for (let i = 0; i < corpus.length; i += 1) {
    const p = corpus[i];
    const [disposition, reason] = dispose(rows[i], config);
    const country = typeof p.geo.country === "string" ? p.geo.country.trim() : "";
    if (country) countries.add(country);

    if (titleMatches(p.title, criteria.titles_include, criteria.titles_exclude)) titleMatched += 1;

    const kind = reason.split(":")[0];
    reasonCounts[kind] = (reasonCounts[kind] ?? 0) + 1;

    if (disposition === "qualified") {
      qualified += 1;
      if (qualifiedSamples.length < SAMPLE_LIMIT) qualifiedSamples.push(sample(p, reason));
    } else if (disposition === "filtered") {
      filtered += 1;
      if (filteredSamples.length < SAMPLE_LIMIT) filteredSamples.push(sample(p, reason));
    } else {
      needsInfo += 1;
    }
  }

  // The relaxation pass. Nine fields over the same rows: at the 5,000-row cap
  // the SQL enforces that is 45k pure calls with no I/O in any of them.
  let binding: BindingRelaxation | null = null;
  const corpusCountries = [...countries, ...config.countries];
  for (const { field, config: relaxed } of relaxations(config, corpusCountries)) {
    const recovers = countQualified(rows, relaxed) - qualified;
    // Strictly greater, so a tie keeps the FIRST field and the sentence does
    // not flip between two equals on every recompute.
    if (recovers > 0 && (!binding || recovers > binding.recovers)) {
      binding = {
        field,
        setting: FIELD_SETTING[field] ?? field,
        label: FIELD_LABELS[field] ?? field,
        recovers,
        sample: bindingSample(field, filteredSamples, corpus, rows, config),
      };
    }
  }

  return {
    corpusTotal: corpus.length,
    titleMatched,
    titlesConfigured: criteria.titles_include.length,
    qualified,
    filtered,
    needsInfo,
    reasonCounts,
    binding,
    samples: { qualified: qualifiedSamples, filtered: filteredSamples },
    windowDays: opts.windowDays,
    computedAt: opts.now,
  };
}

/**
 * One concrete posting the binding field is refusing, in English.
 *
 * Looked up by the reason KIND the field produces, not by the setting it maps
 * to. Two reasons for the indirection, and the second is the bug:
 *
 *   - The field that BINDS is frequently not the field that produced the most
 *     first-hit reasons (that is the whole point of the relaxation pass), so the
 *     first filtered sample usually names something else entirely — hence the
 *     scan past the samples.
 *   - Several kinds collapse onto one ANCHOR. Matching on the anchor let a
 *     `geo_unknown` sentence be illustrated by a posting in India: reason kind
 *     `geo`, setting `countries`, same anchor as `geo-unknown`. The sentence and
 *     its example named different things, which is worse than no example.
 *
 * Returns "" when the binding field filtered nothing with a reason of its own,
 * and the caller renders no example rather than a wrong one.
 */
function bindingSample(
  field: string,
  filteredSamples: PreviewSample[],
  corpus: PreviewPosting[],
  rows: GateRow[],
  config: GateCriteria,
): string {
  const kinds = FIELD_REASON_KINDS[field] ?? [];
  const matches = (reason: string) => kinds.includes(reason.split(":")[0]);

  const shown = filteredSamples.find((s) => matches(s.reason));
  if (shown) return shown.explanation;
  for (let i = 0; i < rows.length; i += 1) {
    const [disposition, reason] = dispose(rows[i], config);
    if (disposition === "filtered" && matches(reason)) {
      return `${corpus[i].title} — ${explainReason(reason)}`;
    }
  }
  return "";
}

/**
 * What the preview should say about title coverage, if anything.
 *
 *   ok            nothing to report
 *   no-titles     the profile names no titles at all. An empty include list
 *                 matches NOTHING (`any([])` is false in Python, `some()` is
 *                 false here), so the queue this profile produces is whatever
 *                 the engine happens to have already fetched and nothing more.
 *                 The fix is one field away and it is not the engine's fault.
 *   engine-behind titles ARE set and almost nothing in the corpus matches them:
 *                 `title_matches` runs at INGEST, so a posting the filter
 *                 rejected never entered `postings`. A user whose role family
 *                 is new to the system previews near-zero and the number is not
 *                 their profile's fault either — but the remedy is waiting, not
 *                 editing, and saying the wrong one sends them to change a
 *                 setting that was right.
 *
 * The two used to be one boolean, and the recorded baseline showed what that
 * costs: "Only 0 of those 136 match your job titles. The engine has not been
 * sweeping for this kind of role yet" — said to somebody who had not filled the
 * field in. Never on an empty corpus, either: "0 of 0" is 0%, and reporting
 * that would warn every user of a brand-new deployment about their titles.
 */
export type TitleCoverage = "ok" | "no-titles" | "engine-behind";

export function titleCoverage(p: PreviewResult): TitleCoverage {
  if (p.titlesConfigured === 0) return "no-titles";
  if (p.corpusTotal === 0) return "ok";
  if (p.titleMatched / p.corpusTotal < TITLE_COVERAGE_FLOOR) return "engine-behind";
  return "ok";
}

/** True when either kind of coverage warning applies. */
export function titleCoverageWarning(p: PreviewResult): boolean {
  return titleCoverage(p) !== "ok";
}
