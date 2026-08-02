/**
 * The anti-slop copy rules, as executable regexes.
 *
 * Source of truth: the design spec's terminology document, section 3 ("Anti-slop
 * rules for interface copy") plus section 2's punctuation mechanics. Every rule
 * below carries the sentence it enforces in `doc`, verbatim enough to paste into
 * a review comment — the spec's own instruction is "regenerate with the violated
 * rule quoted", and a lint that only says "banned word" makes that impossible.
 *
 * Two design decisions worth stating, because both look like over-reach until
 * you read the spec's reasoning:
 *
 *  1. **Any vocabulary hit fails, not two.** The spec's density rule ("one
 *     construction hit or two vocabulary hits in a single string is a rewrite,
 *     not an edit") is guidance for the AUTHOR about how to fix a string, not a
 *     tolerance for the gate: sections 3.1 and 3.2 both say "never user-facing".
 *     So one hit is a failure, and the density note rides along in the message so
 *     the author knows whether to sand the word or regenerate the string.
 *
 *  2. **Judgment rules are deliberately absent.** "Rule of three as a reflex",
 *     "hedged comparison via rather than", and "restating a control's benefit"
 *     cannot be matched without a false-positive rate that would train everyone
 *     to reach for the allowlist. They stay review-gate items, exactly as the
 *     foundations document splits its own checklist into mechanical and
 *     judgment halves.
 *
 * A rule that fires where the copy is genuinely right is resolved through
 * `allowlist.json`, which demands a written reason per entry and fails when an
 * entry stops matching. That is the repo's standing bargain: an exception is a
 * deliberate, reviewed act with a name on it, never a silent suppression.
 *
 * Plain `.mjs` on purpose: the CLI and the vitest self-test both import it, and
 * a build step between a lint rule and the test that proves the rule can fail is
 * one more thing that can quietly stop being true.
 */

/** Escape a literal for embedding in a RegExp source. */
function esc(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A word-list rule. Matches on word boundaries, case-insensitively, so "Sweep"
 * and "sweeps" both trip a `sweep` entry while "sweepstakes" does not.
 *
 * The trailing `(?:s|es|ing|ed)?` is NOT applied blindly — each list spells out
 * the inflections it wants, because "gates" is a banned engine word and "gated"
 * is too, while "tiered" is not a word this product ever writes and adding it
 * would only widen the false-positive surface.
 */
function wordListMatcher(words) {
  const source = words.map(esc).join("|");
  const re = new RegExp(`(?<![\\w-])(?:${source})(?![\\w-])`, "gi");
  return (text) => {
    const hits = [];
    for (const m of text.matchAll(re)) hits.push({ match: m[0], index: m.index ?? 0 });
    return hits;
  };
}

/** A pattern rule: one or more regexes, each already carrying its own flags. */
function patternMatcher(patterns) {
  return (text) => {
    const hits = [];
    for (const re of patterns) {
      const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
      for (const m of text.matchAll(rx)) hits.push({ match: m[0], index: m.index ?? 0 });
    }
    return hits;
  };
}

/** Word list plus extra patterns, for the entries the spec qualifies by context. */
function bothMatcher(words, patterns) {
  const byWord = wordListMatcher(words);
  const byPattern = patternMatcher(patterns);
  return (text) => [...byWord(text), ...byPattern(text)];
}

/**
 * Engine vocabulary — section 3.1's list, verbatim.
 *
 * These are correct inside the database and inside `core/schema.py`; the whole
 * point of the display dictionary is that they stop at the view-model edge. A
 * hit here means an engine word reached a string a person reads.
 *
 * `null` and `N/A` are in the list as VALUES: the spec names "Not listed" as the
 * value word, and `lib/data/view-models.ts` already exports NOT_LISTED for it.
 */
const ENGINE_WORDS = [
  "triage",
  "triaged",
  "triaging",
  "disposition",
  "dispositions",
  "provenance",
  "sweep",
  "sweeps",
  "swept",
  "gate",
  "gates",
  "gating",
  "gated",
  "tier",
  "tiers",
  "canonical",
  "idempotent",
  "polarity",
  "knockout",
  "knockouts",
  "payload",
  "dedupe",
  "batch-approvable",
  "N/A",
  "null",
];

/**
 * Section 4's dictionary rows that name a specific engine→user translation.
 *
 * Separate from ENGINE_WORDS because these have a NAMED replacement the author
 * can apply without thinking: the failure message carries it. "resolution",
 * "adapter" and "schema" live here rather than in the engine list for the same
 * reason — they each have a dictionary row.
 *
 * Deliberately NOT in this list: "board" and "source". Both are ordinary English
 * this product uses correctly ("job board", "where it came from"), and a rule
 * that fires on every honest use is a rule everyone learns to allowlist.
 */
const DICTIONARY_WORDS = {
  resolution: 'section 4: "resolution method" renders as "how it was found"',
  "resolution method": 'section 4: "resolution method" renders as "how it was found"',
  schema: "section 3.1: engine vocabulary, never user-facing",
  adapter: "section 3.1: engine vocabulary, never user-facing",
  adapters: "section 3.1: engine vocabulary, never user-facing",
  batch: 'section 4: batch renders as "import" ("this import", never "this batch")',
  batches: 'section 4: batch renders as "import"',
  ATS: 'section 4: ATS / board renders as "job board or career site"',
  verified: "section 4: verified / inferred / asserted / unresolved render as confirmed / likely / added by you / not found yet",
  inferred: "section 4: verified / inferred / asserted / unresolved render as confirmed / likely / added by you / not found yet",
  asserted: "section 4: verified / inferred / asserted / unresolved render as confirmed / likely / added by you / not found yet",
  unverified: "section 4: source quality reads confirmed / likely / added by you / not found yet",
  unresolved: "section 4: verified / inferred / asserted / unresolved render as confirmed / likely / added by you / not found yet",
  undecided: 'section 4: the decision words are "Needs decision" / "Interested" / "Passed" / "Later"',
  snoozed: 'section 4: snoozed renders as "Later"',
  dismissed: 'section 4: dismissed renders as "Passed"',
  "needs-info": 'section 4: needs-info / awaiting-tags render as "Checking details"',
  "awaiting-tags": 'section 4: needs-info / awaiting-tags render as "Checking details"',
  "policy layer": 'section 4: policy layers render as "your answers" or "company-specific answers"',
  "policy layers": 'section 4: policy layers render as "your answers" or "company-specific answers"',
  "layer 1": 'section 4: layer 1 renders as "your answers"',
  "layer 2": 'section 4: layer 2 renders as "company-specific answers"',
  job_key: "section 4: job_key / hq_id / hq_version are never shown in the UI",
  hq_id: "section 4: job_key / hq_id / hq_version are never shown in the UI",
  hq_version: "section 4: job_key / hq_id / hq_version are never shown in the UI",
};

/**
 * Section 3.2 tier 1 — the current-generation hedging cluster.
 *
 * The spec qualifies three of these ("highlights as a verb", "supports as
 * filler", "enables as filler"), so those arrive as patterns below rather than
 * as bare words: "the export supports CSV" is a fact, "supports your workflow"
 * is the tell, and a rule that cannot tell them apart is a rule everyone
 * allowlists.
 */
const AI_TIER_1 = [
  "ensuring",
  "ensures",
  "ensure",
  "highlighting",
  "empowers",
  "empower",
  "streamlines",
  "streamline",
  "reflects",
];

const AI_TIER_1_PATTERNS = [
  // "highlights" / "supports" / "enables" with an ABSTRACT object — the filler
  // sense. A concrete object (a file format, a column, a browser) is a fact.
  /\b(?:highlights|supports|enables)\s+(?:your|our|the\s+(?:experience|workflow|process|journey))\b/i,
  /\bhighlights?\s+(?:available|how|what|which|roles?|jobs?|applications?|results?|changes?)\b/i,
];

/** Section 3.2 tier 2 — marketing and inflation. */
const AI_TIER_2 = [
  "seamless",
  "seamlessly",
  "effortless",
  "effortlessly",
  "easily",
  "simply",
  "powerful",
  "robust",
  "comprehensive",
  "cutting-edge",
  "innovative",
  "supercharge",
  "unlock",
  "leverage",
  "leverages",
  "leveraging",
  "elevate",
  "enhance",
  "enhances",
  "delightful",
  "intuitive",
  "optimize",
  "optimizes",
  "optimized",
  "optimization",
];

const AI_TIER_2_PATTERNS = [
  // "just (as a minimizer)" — the spec's own qualifier. "just now" and "just
  // the ones you picked" are ordinary; "just click", "just two steps" is the
  // minimizer that tells the reader the work is beneath mentioning.
  /\bjust\s+(?:a|an|one|two|three|click|tap|add|paste|enter|pick|choose|drop|type|\d)\b/i,
];

/** Section 3.2 tier 3 — the classic era; rarer now, still banned. */
const AI_TIER_3 = [
  "delve",
  "tapestry",
  "landscape",
  "journey",
  "navigating",
  "navigate",
  "navigates",
  "navigated",
  "realm",
  "embark",
  "foster",
  "harness",
  "pivotal",
  "crucial",
  "vital",
  "myriad",
  "plethora",
  "holistic",
  "synergy",
  "testament",
  "underscore",
  "underscores",
  "transformative",
  "game-changer",
];

/** Section 3.2's closing paragraph: filler and mood. */
const FILLER_MOOD = [
  "Oops",
  "Whoops",
  "Sorry",
  "Great",
  "Awesome",
  "Amazing",
  "Let's",
  "Let’s",
  "please",
  "Welcome back",
  "You're all set",
  "You’re all set",
];

export const RULES = [
  {
    id: "engine-vocab",
    doc: "3.1 Engine vocabulary (never user-facing): triage, disposition, provenance, sweep, gate, gating, tier, resolution, canonical, schema, adapter, idempotent, polarity, knockout, payload, dedupe, batch-approvable, N/A, null, none as a value.",
    match: wordListMatcher(ENGINE_WORDS),
  },
  {
    id: "dictionary-term",
    doc: "4. Terminology dictionary: every engine term has a user-facing translation, and the surface reads the translation.",
    match: wordListMatcher(Object.keys(DICTIONARY_WORDS)),
    /** The named replacement, so the failure tells the author what to write. */
    hint: (hit) => DICTIONARY_WORDS[hit.match.toLowerCase()] ?? DICTIONARY_WORDS[hit.match],
  },
  {
    id: "engine-vocab-none-as-value",
    doc: '3.1: "none as a value (\\"Not listed\\" is the value word)". Use the NOT_LISTED constant.',
    match: (text) => {
      const t = text.trim();
      return /^(none|n\/a|null|unknown|-{1,2}|—)$/i.test(t)
        ? [{ match: t, index: text.indexOf(t) }]
        : [];
    },
  },
  {
    id: "ai-vocab-tier-1",
    doc: "3.2 Tier 1, the current-generation hedging cluster and the strongest single-word signals in 2026 corpus data: ensuring, ensures, highlights, supports, reflects, empowers, enables, streamlines.",
    match: bothMatcher(AI_TIER_1, AI_TIER_1_PATTERNS),
  },
  {
    id: "ai-vocab-tier-2",
    doc: "3.2 Tier 2, marketing and inflation cluster: seamless(ly), effortless(ly), easily, simply, just (as a minimizer), powerful, robust, comprehensive, cutting-edge, innovative, supercharge, unlock, leverage, elevate, enhance, optimize (as filler), delightful, intuitive.",
    match: bothMatcher(AI_TIER_2, AI_TIER_2_PATTERNS),
  },
  {
    id: "ai-vocab-tier-3",
    doc: "3.2 Tier 3, classic-era cluster; rarer in current models but still banned: delve, tapestry, landscape, realm, journey, embark, foster, harness, pivotal, crucial, vital, myriad, plethora, holistic, synergy, navigate, testament, underscore, elevate, transformative, game-changer.",
    match: wordListMatcher(AI_TIER_3),
  },
  {
    id: "filler-mood",
    doc: '3.2: also banned, filler and mood: Oops, Whoops, Sorry, Great, Awesome, Amazing, Let\'s, please (dropped everywhere for consistency; direct instructions read as clarity, not rudeness, in an instrument), Welcome back, You\'re all set.',
    match: wordListMatcher(FILLER_MOOD),
  },
  {
    id: "construction-negative-parallelism",
    doc: '3.3 #1 Negative parallelism: "not just X, but Y", "isn\'t only X; it\'s Y", "It\'s not about X. It\'s about Y." The single most overrepresented rhetorical pattern in LLM output.',
    match: patternMatcher([
      /\bnot (?:just|only|merely|simply)\b[^.!?]{0,80}?\bbut\b/i,
      /\bisn[’']t (?:just|only|merely)\b[^.!?]{0,80}?\b(?:it[’']s|it is)\b/i,
      /\bit[’']s not about\b[^.!?]{0,60}[.;]\s*it[’']s about\b/i,
      /\bnot\b[^.!?]{0,50},\s*(?:it|this|that)\s+(?:is|does)\b/i,
    ]),
  },
  {
    id: "construction-no-x-no-y",
    doc: '3.3 #2 "No X. No Y. Just Z." The landing-page slogan compression. Never in this product.',
    match: patternMatcher([/\bNo [^.!?]{1,30}\.\s*No [^.!?]{1,30}\./]),
  },
  {
    id: "construction-significance-formula",
    doc: '3.3 #3 The significance formula: "[plays a] crucial/key/important role in [shaping]". Statistically the most formulaic sentence shape in current corpus data.',
    match: patternMatcher([
      /\b(?:plays?|playing|played)\s+(?:an?\s+)?\w+\s+role\b/i,
      /\b(?:crucial|key|important|pivotal|vital|central|essential)\s+role\s+in\b/i,
    ]),
  },
  {
    id: "construction-trailing-participle",
    doc: '3.3 #4 Trailing participle analysis: a sentence that ends with ", ensuring/highlighting/reflecting/helping you ...". The clause adds felt importance, not information. Settings and help text are where this one breeds.',
    match: patternMatcher([
      /,\s+(?:ensuring|ensures|highlighting|reflecting|helping|allowing|enabling|providing|offering|making it)\b[^.!?]*\.?\s*$/i,
    ]),
  },
  {
    id: "construction-copula-avoidance",
    doc: '3.3 #5 Copula avoidance: "serves as", "acts as", "functions as", "is designed to" where "is" or "does" belongs.',
    match: patternMatcher([
      /\b(?:serves?|serving|acts?|acting|functions?|functioning)\s+as\b/i,
      /\b(?:is|are|was|were)\s+designed\s+to\b/i,
    ]),
  },
  {
    id: "construction-rhetorical-question",
    doc: '3.3 #9 The standalone rhetorical question: "The result?" "Why does this matter?" Never in interface copy. And 2: no rhetorical questions.',
    match: patternMatcher([
      /\bthe result\?/i,
      /\bwhy (?:does|is) (?:this|that) (?:matter|important)\?/i,
      /\bwhat does (?:this|that) mean\?/i,
      /\bsound familiar\?/i,
      /\bthe (?:catch|upshot|point)\?/i,
      /\bready to \w+\?/i,
    ]),
  },
  {
    id: "construction-glazing",
    doc: '3.3 #10 Glazing: praising the user or their input ("Great choice", "You\'re on the right track"). The system reports; it does not cheer.',
    match: patternMatcher([
      /\b(?:great|good|excellent|smart|perfect|nice)\s+(?:choice|call|pick|work|job|start)\b/i,
      /\byou[’']re on the right track\b/i,
      /\bwell done\b/i,
      /\bnicely done\b/i,
      /\bgood (?:news|to go)\b/i,
    ]),
  },
  {
    id: "construction-coverage-sweep",
    doc: '3.3 #7 "From X to Y" coverage sweeps: "from tracking to applying". Name the thing or cut it.',
    match: patternMatcher([/\bfrom\s+\w+ing\b[^.!?]{0,25}?\bto\s+\w+ing\b/i]),
  },
  {
    id: "em-dash",
    doc: "2. No em dashes in interface copy. Use a period or a comma. En dash only inside numeric ranges (\"$120k–$150k\"). 3.4: the spaced em dash in particular is the canonical current tell.",
    match: patternMatcher([/—/]),
  },
  {
    id: "curly-quote",
    doc: "3.4 Apostrophes and quotes: straight characters everywhere, enforced by lint. The mixed curly-and-straight inconsistency inside one product is itself the tell; one enforced form ends it.",
    match: patternMatcher([/[‘’“”]/, /&(?:rsquo|lsquo|ldquo|rdquo|apos);/i]),
  },
  {
    id: "exclamation",
    doc: "2. No exclamation points. No rhetorical questions. No ellipses except as a truncation affordance.",
    match: patternMatcher([/!/]),
  },
  {
    id: "glue-glyph",
    doc: "2. No interpunct (·), bullet (•), pipe, or slash as glue between pieces of text. Adjacent metadata separates by layout (columns, right-alignment, a line break) or a comma. Foundations checklist item 27.",
    match: patternMatcher([/[·•]/, /\s[|/]\s/]),
  },
  {
    id: "ellipsis",
    doc: "2. No ellipses except as a truncation affordance. Status and progress copy uses a complete phrase without trailing dots.",
    match: patternMatcher([/…/, /\.{3}/]),
  },
  {
    id: "bold-inline-markup",
    doc: "2 and 3.4: no bold spans inside sentences. If items need labels, use a table; numeric emphasis uses layout and tabular figures.",
    match: patternMatcher([/<strong>/i, /<\/strong>/i, /\*\*[^*]+\*\*/]),
  },
  {
    id: "italic-markup",
    doc: "2. No italics. Foundations checklist item 7: italics, anywhere.",
    match: patternMatcher([/<\/?em>/i, /<\/?i>/i]),
  },
];

export const RULES_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]));

/**
 * Run every rule over one string.
 *
 * Returns a flat list of `{ rule, doc, match, index, hint }`. The caller decides
 * what to do with more than one hit — the density rule lives in the reporter,
 * not here, because the reporter is the thing that talks to a human.
 */
export function scanString(text) {
  const hits = [];
  for (const rule of RULES) {
    for (const hit of rule.match(text)) {
      hits.push({
        rule: rule.id,
        doc: rule.doc,
        match: hit.match,
        index: hit.index,
        hint: rule.hint ? rule.hint(hit) : undefined,
      });
    }
  }
  return hits;
}

/**
 * The spec's density rule, reported rather than enforced: one construction hit
 * or two vocabulary hits in a single string means regenerating the string from
 * the templates in section 7, not sanding the word that tripped the gate.
 */
export function needsRegeneration(hits) {
  const constructions = hits.filter((h) => h.rule.startsWith("construction-")).length;
  const vocabulary = hits.filter(
    (h) => h.rule.startsWith("ai-vocab-") || h.rule === "engine-vocab" || h.rule === "dictionary-term",
  ).length;
  return constructions >= 1 || vocabulary >= 2;
}
