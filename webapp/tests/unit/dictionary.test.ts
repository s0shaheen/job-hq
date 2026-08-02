import { describe, expect, it } from "vitest";
import * as dictionary from "@/lib/dictionary";
import {
  COLUMN_HEADERS,
  DECISION_WORDS,
  NOT_LISTED,
  SAVED_VIEW_NAMES,
  countedNoun,
  decisionToast,
  decisionWord,
  exportLabel,
  filterChipLabel,
  filterChipLabels,
  formatPayK,
  formatPayRangeK,
  reasonSentence,
  scopeLine,
  toastFor,
  triageFor,
  type DecisionWord,
} from "@/lib/dictionary";
import type { Clause } from "@/lib/grid/filter";
import type { Triage } from "@/lib/data/view-models";

/**
 * The dictionary is the only place engine vocabulary becomes user-facing
 * words, so every assertion below names the mutation it kills. A test that
 * only restates the implementation is worth nothing here: the strings ARE the
 * implementation.
 */

const ALL_TRIAGE: readonly Triage[] = ["", "interested", "dismissed", "snoozed"];

describe("decisionWord and triageFor", () => {
  it("maps every engine state to its word", () => {
    // Kills the one mutation that matters: a swapped dismissed/snoozed pair.
    // Both engine words are neutral tokens, so the swap type-checks, passes a
    // round-trip test, and shows "Later" on a role the user passed on — a lie
    // about a decision the user made.
    expect(decisionWord("")).toBe("Needs decision");
    expect(decisionWord("interested")).toBe("Interested");
    expect(decisionWord("dismissed")).toBe("Passed");
    expect(decisionWord("snoozed")).toBe("Later");
  });

  it("is an exact inverse in both directions over all four values", () => {
    // Kills a mapping that is one-way correct: `triageFor` writing "dismissed"
    // for both Passed and Later would still render every row correctly and
    // would silently un-snooze whatever the user set to Later.
    for (const t of ALL_TRIAGE) expect(triageFor(decisionWord(t))).toBe(t);
    for (const w of DECISION_WORDS) expect(decisionWord(triageFor(w))).toBe(w);
  });

  it("covers the closed set, with no word left over", () => {
    // Kills a fifth word sneaking into DECISION_WORDS, and kills dropping one:
    // StatusSelect renders this list, so an extra entry is an unsettable state
    // in the menu and a missing one is a decision nobody can undo.
    expect([...DECISION_WORDS]).toEqual(["Needs decision", "Interested", "Passed", "Later"]);
    expect(new Set(ALL_TRIAGE.map(decisionWord)).size).toBe(4);
  });
});

describe("COLUMN_HEADERS", () => {
  it("is the six Jobs columns in order", () => {
    // Kills a reintroduced "Comp"/"Work model"/"Location"/"Min YoE"/"Why"/
    // "Warm" column set — 03 section 4 retires all six of those names, and the
    // Jobs field budget is exactly six columns.
    expect([...COLUMN_HEADERS]).toEqual([
      "Company",
      "Title",
      "Pay",
      "Location & model",
      "Posted",
      "Decision",
    ]);
  });
});

describe("SAVED_VIEW_NAMES", () => {
  it("replaces the preset names with the decision words", () => {
    // Kills leaving `lib/grid/presets.ts`'s names in place. Four of the five
    // views filter the Decision column, so their names must be the words IN
    // that column: "Dismissed" beside a cell reading "Passed" is two names for
    // one state.
    expect([...SAVED_VIEW_NAMES]).toEqual([
      "All",
      "Needs decision",
      "Interested",
      "Passed",
      "Later",
    ]);
    const decisions: readonly string[] = DECISION_WORDS;
    for (const name of SAVED_VIEW_NAMES.slice(1)) expect(decisions).toContain(name);
  });
});

describe("NOT_LISTED", () => {
  it("is the same constant the view models already use", () => {
    // Kills a forked copy. Two spellings of the absent-value word is how one
    // screen starts saying "Unknown" and another "Not listed" for one fact.
    expect(NOT_LISTED).toBe("Not listed");
  });
});

describe("toastFor", () => {
  it("gives each verb the past tense of its own outcome", () => {
    // Kills a toast that renames the action ("Dismissed" for Pass, "Snoozed"
    // for Later). 02 section 6: the verb keeps its name through the flow and
    // reappears in the toast; a toast that uses the engine word tells the user
    // the button did something other than what it said.
    expect(toastFor("Interested")).toBe("Marked interested");
    expect(toastFor("Pass")).toBe("Passed");
    expect(toastFor("Later")).toBe("Saved for later");
  });
});

describe("decisionToast and countedNoun", () => {
  it("agrees with the action table at one row", () => {
    // Kills the two entry points drifting apart. `toastFor` is the 02 section
    // 6 table and `decisionToast` is the bulk form; if pressing `i` on a row
    // and on a selection of one produced different words, the toast would stop
    // being the confirmation of the verb the user pressed.
    expect(decisionToast("Interested", 1)).toBe(toastFor("Interested"));
    expect(decisionToast("Passed", 1)).toBe(toastFor("Pass"));
    expect(decisionToast("Later", 1)).toBe(toastFor("Later"));
  });

  it("carries the count when more than one row moved", () => {
    // Kills a bulk toast that says "Passed" after passing on twelve roles —
    // the count is the only evidence the bulk action did what was asked.
    expect(decisionToast("Interested", 3)).toBe("Marked 3 roles interested");
    expect(decisionToast("Passed", 3)).toBe("Passed 3 roles");
    expect(decisionToast("Later", 3)).toBe("Saved 3 roles for later");
  });

  it("has a word for a decision being taken back", () => {
    // Kills a fall-through returning undefined when `StatusSelect` sets a row
    // back to undecided — a real menu item, so a real toast.
    expect(decisionToast("Needs decision", 1)).toBe("Decision cleared");
    expect(decisionToast("Needs decision", 4)).toBe("Cleared 4 decisions");
  });

  it("takes the noun in either form", () => {
    // Kills a strict signature. Half the call sites read naturally with a
    // plural and half with a singular; a helper that only accepts one emits
    // "Copied 3 row" at whichever half got it backwards.
    expect(countedNoun(3, "role")).toBe("roles");
    expect(countedNoun(3, "roles")).toBe("roles");
    expect(countedNoun(1, "roles")).toBe("role");
    expect(countedNoun(1, "role")).toBe("role");
    expect(countedNoun(2, "company")).toBe("companies");
    expect(countedNoun(1, "companies")).toBe("company");
    expect(countedNoun(0, "row")).toBe("rows");
  });
});

describe("scopeLine", () => {
  it("states the total alone when nothing is filtered", () => {
    // Kills "always show both numbers". "47 of 47 match your filters" on an
    // unfiltered table is noise that trains a reader to stop reading the line
    // that exists to tell them when a filter is hiding rows.
    expect(scopeLine(47, 47)).toBe("47 roles");
  });

  it("states both numbers and the reason when a filter is on", () => {
    // Kills dropping the total ("12 roles"), which hides the fact that 35 rows
    // are being withheld — the one thing this line is for.
    expect(scopeLine(12, 47)).toBe("12 of 47 match your filters");
  });

  it("singularises at one", () => {
    // Kills "1 roles".
    expect(scopeLine(1, 1)).toBe("1 role");
  });
});

describe("exportLabel", () => {
  it("carries the count", () => {
    // Kills a bare "Export". 02 section 6: the button carries the count when a
    // count exists, and the count it carries is the count it acts on — the
    // whole guard against exporting a different set than the one on screen.
    expect(exportLabel(12)).toBe("Export 12 roles");
    expect(exportLabel(47)).toBe("Export 47 roles");
    expect(exportLabel(1)).toBe("Export 1 role");
  });

  it("takes the noun from the caller", () => {
    // Kills hardcoding "roles" — Applications exports applications.
    expect(exportLabel(3, "applications")).toBe("Export 3 applications");
    expect(exportLabel(1, "companies")).toBe("Export 1 company");
  });
});

describe("money", () => {
  it("formats thousands and millions the way 02 section 8 does", () => {
    // Kills "$120000" and "$1200k": the second is what a naive formatter emits
    // for a band above a million, and it reads as a typo.
    expect(formatPayK(120)).toBe("$120k");
    expect(formatPayK(1200)).toBe("$1.2M");
    expect(formatPayK(1000)).toBe("$1M");
  });

  it("uses the en dash for a range, and only there", () => {
    // Kills a hyphen ("$120k-$150k") and kills an em dash. The numeric range is
    // the ONE en-dash slot in the product (02 section 2).
    expect(formatPayRangeK(120, 150)).toBe("$120k–$150k");
  });
});

// ---------------------------------------------------------------------------
// Why a row was filtered
// ---------------------------------------------------------------------------

/** Every token `lib/gating/dispose.ts` can write, plus the two 02 section 5
 *  names that the TypeScript gate does not emit today. */
const EVERY_REASON = [
  "",
  "geo:India",
  "geo-unknown",
  "metro:Austin",
  "metro-unknown",
  "work-model:onsite",
  "work-model:hybrid",
  "comp:<120k",
  "comp:<1200k",
  "comp-unknown",
  "yoe:6>4",
  "yoe:05>4",
  "yoe-unknown",
  "seniority:Director",
  "title_exclude:sales",
  "awaiting-tags",
  "some-token-nobody-wrote-yet:42",
];

describe("reasonSentence", () => {
  it("renders 02 section 5's table, with the user's own numbers", () => {
    // Kills paraphrasing the spec's sentences. Each one states the job's fact
    // and then the rule it hit; a version that states only the rule ("Below
    // your pay floor") leaves the reader unable to judge the setting.
    expect(reasonSentence("geo:India")).toBe("Location is India, outside your area.");
    expect(reasonSentence("yoe:6>4")).toBe("Asks for 6+ years; your profile says 4.");
    expect(reasonSentence("comp:<120k")).toBe("Pay is below your $120k minimum.");
    expect(reasonSentence("work-model:onsite")).toBe("On-site only; you excluded on-site.");
    expect(reasonSentence("title_exclude:sales")).toBe(
      'Title matches your excluded term "sales".',
    );
  });

  it("reads the zero-padded years token as a number", () => {
    // Kills passing `asks` through raw. `lib/gating/py.ts` documents that the
    // token deliberately mirrors Python and keeps "05", so "Asks for 05+
    // years" is one interpolation away and is not a sentence.
    expect(reasonSentence("yoe:05>4")).toBe("Asks for 5+ years; your profile says 4.");
  });

  it("re-formats the pay floor through the money rules", () => {
    // Kills interpolating the token's own text: `comp:<1200k` would print
    // "$1200k", which 02 section 8 spells "$1.2M".
    expect(reasonSentence("comp:<1200k")).toBe("Pay is below your $1.2M minimum.");
  });

  it("calls the transient state 'checking details'", () => {
    // Kills "awaiting tags" and "needs info" reaching a screen — both are
    // engine words, and 02 section 4 names the replacement.
    expect(reasonSentence("awaiting-tags")).toBe("Checking details.");
  });

  it("states the positive case rather than leaving the line blank", () => {
    // Kills returning "" for a qualified row: `DetailPane` renders `reason`
    // unconditionally, so an empty string is an empty line under the decision.
    expect(reasonSentence("")).toBe("Matches your search.");
    expect(reasonSentence(null)).toBe("Matches your search.");
  });

  it("never prints a token it does not recognise", () => {
    // Kills `default: return raw`, which is what `explainReason` does today —
    // the exact path that puts "geo:India" on a screen. A new gate reason
    // added Python-side must degrade to the generic, not leak.
    for (const token of EVERY_REASON) {
      const text = reasonSentence(token);
      expect(text, token).not.toContain(":");
      expect(text, token).not.toMatch(/\b(geo|yoe|comp|metro|awaiting|tags|unknown)\b/i);
    }
    expect(reasonSentence("some-token-nobody-wrote-yet:42")).toBe("Didn't match your search.");
  });
});

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------

/** Every operator in `lib/grid/filter.ts`: three text, two enum, three
 *  number, three date, plus the remote clause. If a clause kind is added
 *  there and not here, `EVERY_OPERATOR` stops being exhaustive — which is why
 *  the count is asserted. */
const EVERY_OPERATOR: Clause[] = [
  { kind: "text", field: "company", op: "has", value: "Stripe" },
  { kind: "text", field: "title", op: "is", value: "Product Manager" },
  { kind: "text", field: "compRange", op: "empty", value: true },
  { kind: "text", field: "compRange", op: "empty", value: false },
  { kind: "enum", field: "workModel", op: "in", values: ["Remote", "Hybrid"] },
  { kind: "enum", field: "workModel", op: "notin", values: ["Onsite"] },
  { kind: "enum", field: "triage", op: "in", values: ["undecided", "dismissed", "snoozed"] },
  { kind: "number", field: "compMax", op: "gte", value: 120 },
  { kind: "number", field: "compMax", op: "lte", value: 120 },
  { kind: "number", field: "compMax", op: "between", min: 120, max: 150 },
  { kind: "number", field: "minYoe", op: "gte", value: 4 },
  { kind: "number", field: "minYoe", op: "between", min: 3, max: 6 },
  { kind: "date", field: "posted", op: "inlast", days: 7 },
  { kind: "date", field: "posted", op: "before", value: "2026-06-25" },
  { kind: "date", field: "firstSeen", op: "after", value: "2026-06-25" },
  { kind: "remote", value: "remote" },
  { kind: "remote", value: "onsite-hybrid" },
];

const NOW = Date.UTC(2026, 6, 25); // 2026-07-25, 30 days after 2026-06-25

describe("filterChipLabel", () => {
  it("phrases the four the spec names, in plain language", () => {
    expect(filterChipLabel({ kind: "number", field: "compMax", op: "gte", value: 120 })).toBe(
      "Pay above $120k",
    );
    expect(filterChipLabel({ kind: "number", field: "compMax", op: "lte", value: 120 })).toBe(
      "Pay below $120k",
    );
    expect(filterChipLabel({ kind: "date", field: "posted", op: "inlast", days: 7 })).toBe(
      "Posted under 7d",
    );
    expect(
      filterChipLabel({ kind: "date", field: "posted", op: "before", value: "2026-06-25" }, NOW),
    ).toBe("Posted over 30d");
  });

  it("never emits a comparison glyph or a field token", () => {
    // THE test. Kills "fall through to the machine clause" — the failure where
    // an operator nobody wrote a sentence for leaks `comp:>=120` or
    // `Comp ≥ $120k` onto the screen. `lib/grid/filter.ts`'s own
    // `formatClause` emits ≥ and ≤ today, so this is a live regression path,
    // not a hypothetical one.
    for (const clause of EVERY_OPERATOR) {
      for (const label of [filterChipLabel(clause), filterChipLabel(clause, NOW)]) {
        expect(label, JSON.stringify(clause)).not.toMatch(/[<>≥≤]/);
        // Field tokens as they appear in the engine, and the `field:value`
        // shape a raw clause serialises to.
        expect(label, JSON.stringify(clause)).not.toMatch(
          /\b(compMax|compRange|minYoe|workModel|firstSeen|triage|yoe|comp|geo)\b/,
        );
        expect(label, JSON.stringify(clause)).not.toMatch(/\w+:[^ ]/);
      }
    }
  });

  it("gives every operator a sentence rather than a shrug", () => {
    // Kills a renderer that phrases the four in the spec and returns the
    // fallback for the other thirteen. The fallback exists for clauses that
    // cannot be phrased; a valid clause is not one of those.
    expect(EVERY_OPERATOR).toHaveLength(17);
    for (const clause of EVERY_OPERATOR) {
      expect(filterChipLabel(clause), JSON.stringify(clause)).not.toBe("Custom filter");
    }
  });

  it("routes triage values through the decision words", () => {
    // Kills the chip printing the engine token. "Decision is dismissed" is the
    // exact leak 02 section 3.1 forbids, and it is one `.join()` away.
    const label = filterChipLabel({
      kind: "enum",
      field: "triage",
      op: "in",
      values: ["undecided", "dismissed", "snoozed"],
    });
    expect(label).toBe("Decision is Needs decision, Passed or Later");
    expect(label).not.toMatch(/dismissed|snoozed|undecided/);
  });

  it("says 'not listed' rather than 'empty' for an unstated value", () => {
    // Kills `lib/grid/filter.ts`'s "Comp not stated" wording surviving the
    // port: 02 section 8 makes "Not listed" the single value word for absence.
    expect(filterChipLabel({ kind: "text", field: "compRange", op: "empty", value: true })).toBe(
      "Pay is not listed",
    );
    expect(filterChipLabel({ kind: "text", field: "compRange", op: "empty", value: false })).toBe(
      "Pay is listed",
    );
  });

  it("falls back to plain language instead of leaking an unphraseable clause", () => {
    // Kills `return \`${field}:${op}\`` as the default arm. A clause can reach
    // here from a URL somebody edited, and the honest answer is a vague chip,
    // never the machine's own words.
    const unknownField = { kind: "text", field: "moonPhase", op: "is", value: "waxing" };
    expect(filterChipLabel(unknownField as unknown as Clause)).toBe("Custom filter");
    expect(filterChipLabel({ kind: "text", field: "company", op: "has", value: "  " })).toBe(
      "Custom filter",
    );
    expect(
      filterChipLabel({
        kind: "enum",
        field: "triage",
        op: "in",
        values: ["parked"],
      }),
    ).toBe("Custom filter");
  });

  it("renders a date bound absolutely when no instant is threaded", () => {
    // Kills a `Date.now()` call inside the renderer. `clauseMatches` takes
    // `now` for exactly this reason: server and hydrating client must agree,
    // or a chip flickers across midnight and the console-error scan fails.
    expect(filterChipLabel({ kind: "date", field: "posted", op: "before", value: "2026-06-25" })).toBe(
      "Posted before Jun 25",
    );
  });

  it("gives one chip per OR-group", () => {
    // Kills flattening the filter to one chip per clause, which drops the
    // distinction between "A and B" and "A or B" — two different result sets
    // shown with identical chips.
    expect(
      filterChipLabels([
        [{ kind: "number", field: "compMax", op: "gte", value: 120 }],
        [
          { kind: "remote", value: "remote" },
          { kind: "enum", field: "workModel", op: "in", values: ["Hybrid"] },
        ],
      ]),
    ).toEqual(["Pay above $120k", "Remote only or Work model is Hybrid"]);
  });
});

// ---------------------------------------------------------------------------
// The lint: what keeps the dictionary a dictionary
// ---------------------------------------------------------------------------

/** 02 sections 3.1 and 3.2, plus the filler-and-mood list at the end of 3.2. */
const BANNED_WORDS = [
  // 3.1 engine vocabulary
  "triage", "disposition", "provenance", "sweep", "gate", "gating", "tier",
  "resolution", "canonical", "schema", "adapter", "idempotent", "polarity",
  "knockout", "payload", "dedupe", "batch-approvable", "null", "none",
  // 3.2 tier 1, the current hedging cluster
  "ensuring", "ensures", "highlights", "supports", "reflects", "empowers",
  "enables", "streamlines",
  // 3.2 tier 2, marketing and inflation
  "seamless", "seamlessly", "effortless", "effortlessly", "easily", "simply",
  "just", "powerful", "robust", "comprehensive", "cutting-edge", "innovative",
  "supercharge", "unlock", "leverage", "elevate", "enhance", "optimize",
  "delightful", "intuitive",
  // 3.2 tier 3, the classic era
  "delve", "tapestry", "landscape", "realm", "journey", "embark", "foster",
  "harness", "pivotal", "crucial", "vital", "myriad", "plethora", "holistic",
  "synergy", "navigate", "testament", "underscore", "transformative",
  "game-changer",
  // filler and mood
  "oops", "whoops", "sorry", "great", "awesome", "amazing", "please",
];

/**
 * Every string this module can put on a screen: the exported constants, plus
 * the output of every exported function over the inputs it will really see.
 *
 * Linting only the constants would leave the functions — where most of the
 * copy actually comes from — unchecked.
 */
function everyDictionaryString(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  const add = (where: string, text: unknown) => {
    if (typeof text === "string") out.push({ where, text });
  };

  for (const [name, value] of Object.entries(dictionary)) {
    if (typeof value === "string") add(name, value);
    else if (Array.isArray(value)) value.forEach((v, i) => add(`${name}[${i}]`, v));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) add(`${name}.${k}`, v);
    }
  }

  for (const t of ALL_TRIAGE) add(`decisionWord(${JSON.stringify(t)})`, decisionWord(t));
  for (const a of ["Interested", "Pass", "Later"] as const) add(`toastFor(${a})`, toastFor(a));
  for (const w of DECISION_WORDS) {
    for (const n of [1, 3]) add(`decisionToast(${w},${n})`, decisionToast(w, n));
  }
  for (const n of [1, 3]) {
    for (const noun of ["role", "roles", "row", "company", "applications"]) {
      add(`countedNoun(${n},${noun})`, countedNoun(n, noun));
    }
  }
  for (const n of [0, 1, 12, 47]) {
    add(`exportLabel(${n})`, exportLabel(n));
    add(`scopeLine(${n},${n})`, scopeLine(n, n));
    add(`scopeLine(${n},99)`, scopeLine(n, 99));
  }
  for (const k of [0, 120, 1000, 1200]) add(`formatPayK(${k})`, formatPayK(k));
  add("formatPayRangeK", formatPayRangeK(120, 150));
  for (const token of EVERY_REASON) add(`reasonSentence(${token})`, reasonSentence(token));
  for (const clause of EVERY_OPERATOR) {
    const where = `filterChipLabel(${clause.kind}/${"op" in clause ? clause.op : clause.value})`;
    add(where, filterChipLabel(clause));
    add(`${where}+now`, filterChipLabel(clause, NOW));
  }
  return out;
}

describe("the dictionary lints itself", () => {
  const strings = everyDictionaryString();

  it("has strings to lint", () => {
    // Kills a walker that silently finds nothing and turns every assertion
    // below into a green no-op.
    expect(strings.length).toBeGreaterThan(50);
  });

  it("uses no glue glyph and no em dash", () => {
    // 01 section 12.27 and 02 section 2. The interpunct, bullet and pipe are
    // the generated-UI signature; the em dash is the current prose tell.
    // Kills "Remote · US", "Pay | Posted", "12 of 47 — filtered".
    for (const { where, text } of strings) {
      expect(text, where).not.toMatch(/[·•|—]/);
    }
  });

  it("uses the en dash only between numbers", () => {
    // Kills the en dash spreading from the one slot 02 allows it into prose,
    // where it is an em dash by another name.
    for (const { where, text } of strings) {
      for (let i = text.indexOf("–"); i !== -1; i = text.indexOf("–", i + 1)) {
        expect(text.slice(0, i), where).toMatch(/[\dkM]$/);
        expect(text.slice(i + 1), where).toMatch(/^[$\d]/);
      }
    }
  });

  it("uses straight quotes and apostrophes", () => {
    // 02 section 3.4: mixed curly and straight inside one product is itself
    // the tell, so one form is enforced. Kills a smart-quoted paste.
    for (const { where, text } of strings) {
      expect(text, where).not.toMatch(/[‘’“”]/);
    }
  });

  it("is sentence case, with no shouted word", () => {
    // 01 sections 12.8 and 12.9: no title case, no uppercase. Kills "Export 12
    // ROLES" and kills an abbreviation like "YoE"/"ATS" arriving as chrome.
    for (const { where, text } of strings) {
      const shouted = text.match(/\b[A-Z]{2,}\b/g);
      expect(shouted, where).toBeNull();
    }
  });

  it("uses no banned word", () => {
    // 02 sections 3.1 and 3.2. The engine words are the ones that matter here:
    // "triage" and "disposition" are one careless label away at all times,
    // because they are what the code around this file is called.
    for (const { where, text } of strings) {
      for (const word of BANNED_WORDS) {
        const pattern = new RegExp(`\\b${word.replace(/[-]/g, "\\-")}\\b`, "i");
        expect(pattern.test(text), `${where}: "${text}" contains "${word}"`).toBe(false);
      }
    }
  });

  it("uses no banned construction", () => {
    // 02 section 3.3, the rules that survive a word swap: negative parallelism,
    // the "No X. No Y. Just Z." compression, copula avoidance, and the
    // standalone rhetorical question.
    for (const { where, text } of strings) {
      expect(text, where).not.toMatch(/\bnot (just|only)\b/i);
      expect(text, where).not.toMatch(/\b(serves|acts|functions) as\b/i);
      expect(text, where).not.toMatch(/\bis designed to\b/i);
      expect(text, where).not.toMatch(/[?!]/);
      expect(text, where).not.toMatch(/\.\.\./);
    }
  });

  it("keeps DecisionWord assignable from the words it ships", () => {
    // Type-level, but it fails the build rather than a run: kills widening
    // DecisionWord to `string`, which would let any of the mappings above
    // return anything at all.
    const word: DecisionWord = decisionWord("dismissed");
    expect(word).toBe("Passed");
  });
});
