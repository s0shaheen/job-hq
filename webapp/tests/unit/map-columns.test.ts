// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// map-columns imports `Cell`/`cellText` from the server-only reader so there is
// one definition of "blank" in the phase. Stubbing the poison pill is what makes
// the pure functions testable; nothing else is faked.
vi.mock("server-only", () => ({}));

import {
  diceCoefficient,
  FUZZY_FLOOR,
  HEADER_ALIASES,
  isRoundTrip,
  MAPPABLE_FIELDS,
  normalizeHeader,
  sampleValues,
  suggestMapping,
  TARGET_FIELDS,
  unmappedHeaders,
} from "@/lib/import/map-columns";
import { readWorkbook } from "@/lib/import/read";

/**
 * The single failure this file exists to make impossible: a confident wrong
 * mapping (matrix rows 25 and 26).
 *
 * "Contact Company" is the case. It scores 0.63 against `company` — high enough
 * that any similarity threshold picked by feel catches it, low enough that the
 * mapper has no business acting on it. Every assertion below is written so that
 * loosening the floor, or dropping the header-consumed bookkeeping, turns it
 * red rather than merely changing a number nobody reads.
 */

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "import");

describe("normalizeHeader", () => {
  it("folds the punctuation people actually put in headers", () => {
    for (const raw of ["Job Title", "job_title", "job-title", "JOB  TITLE", " Job/Title "]) {
      expect(normalizeHeader(raw)).toBe("job title");
    }
    // Punctuation becomes a space, not nothing — `job_title` has to land where
    // `Job Title` lands, or every alias needs a de-spaced twin.
    expect(normalizeHeader("Applied?")).toBe("applied");
    expect(normalizeHeader("###")).toBe("");
  });
});

describe("alias hits", () => {
  it("maps a plain export at confidence 1.0", () => {
    const m = suggestMapping([
      "Company",
      "Job Title",
      "Status",
      "Date Applied",
      "URL",
      "Location",
      "Notes",
      "Next Step",
      "Follow Up Date",
    ]);
    expect(m.company).toEqual({ header: "Company", index: 0, confidence: 1, source: "alias" });
    expect(m.title).toEqual({ header: "Job Title", index: 1, confidence: 1, source: "alias" });
    expect(m.status).toEqual({ header: "Status", index: 2, confidence: 1, source: "alias" });
    expect(m.appliedDate).toEqual({ header: "Date Applied", index: 3, confidence: 1, source: "alias" });
    expect(m.url).toEqual({ header: "URL", index: 4, confidence: 1, source: "alias" });
    expect(m.location).toEqual({ header: "Location", index: 5, confidence: 1, source: "alias" });
    expect(m.notes).toEqual({ header: "Notes", index: 6, confidence: 1, source: "alias" });
    expect(m.nextAction).toEqual({ header: "Next Step", index: 7, confidence: 1, source: "alias" });
    expect(m.nextActionDate).toEqual({ header: "Follow Up Date", index: 8, confidence: 1, source: "alias" });
  });

  it("returns the header verbatim, not the normalized form", () => {
    // The mapping is written back into `import_batches.mapping` and has to name
    // the column as the file spells it, or the commit reads the wrong column.
    const m = suggestMapping([" COMPANY NAME "]);
    expect(m.company?.header).toBe(" COMPANY NAME ");
  });

  it("gives no alias to two fields at once", () => {
    // If one normalized word owned two targets, which one won would depend on
    // the order of an object literal rather than on anything true.
    const owners = new Map<string, string[]>();
    for (const field of MAPPABLE_FIELDS) {
      for (const alias of HEADER_ALIASES[field]) {
        owners.set(alias, [...(owners.get(alias) ?? []), field]);
      }
    }
    const shared = [...owners.entries()].filter(([, fields]) => fields.length > 1);
    expect(shared).toEqual([]);
  });

  it("spells every alias in normalized form, so it can actually be hit", () => {
    for (const field of MAPPABLE_FIELDS) {
      for (const alias of HEADER_ALIASES[field]) {
        expect(normalizeHeader(alias)).toBe(alias);
      }
    }
  });
});

describe("the 0.82 floor", () => {
  it("leaves `Contact Company` Unmapped", () => {
    const m = suggestMapping(["Contact Company", "Job Title", "Status"]);
    // The failure: 300 applications at companies that do not exist, found a
    // month later. The floor is the only thing standing between here and there.
    expect(m.company).toBeNull();
    expect(m.title).not.toBeNull();
  });

  it("scores `Contact Company` high enough that a looser floor would map it", () => {
    // Pins the mutation: at any floor <= 0.63 the test above goes green while
    // being wrong. This is the number that makes 0.82 a decision rather than
    // a magic constant.
    const score = diceCoefficient(normalizeHeader("Contact Company"), "company");
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(FUZZY_FLOOR);
    expect(score).toBeCloseTo(0.63, 2);
  });

  it("accepts a plural just above the floor and refuses one just below", () => {
    // "Statuses" -> 0.833, in. "URLs" -> 0.800, out: one added character moves a
    // three-letter word 20 points, and there is nothing to be confident about.
    expect(diceCoefficient("statuses", "status")).toBeCloseTo(0.833, 3);
    expect(diceCoefficient("urls", "url")).toBeCloseTo(0.8, 3);

    const inBounds = suggestMapping(["Companies Applied To", "Statuses"]);
    expect(inBounds.status).toMatchObject({ header: "Statuses", source: "fuzzy" });
    expect(inBounds.status?.confidence).toBeCloseTo(0.833, 3);

    expect(suggestMapping(["URLs"]).url).toBeNull();
  });

  it("never reports a fuzzy confidence below the floor", () => {
    const m = suggestMapping(["Contact Company", "Recruiter", "Salary Band", "Locations", "Titles"]);
    for (const field of MAPPABLE_FIELDS) {
      const s = m[field];
      if (s) expect(s.confidence).toBeGreaterThanOrEqual(FUZZY_FLOOR);
    }
  });

  it("matches the endings people actually type", () => {
    const m = suggestMapping(["Locations", "Job Titles"]);
    expect(m.location).toMatchObject({ header: "Locations", source: "fuzzy" });
    expect(m.title).toMatchObject({ header: "Job Titles", source: "fuzzy" });
  });
});

describe("diceCoefficient", () => {
  it("scores identity 1 and disjoint 0", () => {
    expect(diceCoefficient("company", "company")).toBe(1);
    expect(diceCoefficient("company", "xyzw")).toBe(0);
  });

  it("does not reward a repeated bigram more than once", () => {
    // Multiset intersection, and the direction is what proves it: counting each
    // occurrence in the SECOND string against one occurrence in the first pushes
    // the score above 1.0, so "Company Company" outscores "Company" for the
    // company field and the mapper reports a confidence it cannot have.
    expect(diceCoefficient("company", "company company")).toBeCloseTo(0.632, 3);
    expect(diceCoefficient("company company", "company")).toBeCloseTo(0.632, 3);
    for (const [a, b] of [
      ["company", "company company"],
      ["aa", "aaaa"],
      ["ab", "abab"],
    ] as const) {
      expect(diceCoefficient(a, b)).toBeLessThanOrEqual(1);
      expect(diceCoefficient(b, a)).toBeLessThanOrEqual(1);
    }
  });

  it("is symmetric, so the alias table's direction cannot change an answer", () => {
    for (const [a, b] of [
      ["statuses", "status"],
      ["company company", "company"],
      ["aaaa", "aa"],
    ] as const) {
      expect(diceCoefficient(a, b)).toBe(diceCoefficient(b, a));
    }
  });

  it("does not let containment stand in for similarity", () => {
    // The property that rules out every containment-flavoured measure: "company"
    // sits whole inside "contact company" and still must not score near 1.
    expect(diceCoefficient("contact company", "company")).toBeLessThan(0.8);
  });
});

describe("one header, one field", () => {
  it("maps one of two identically named columns and reports the other as unmapped", () => {
    // A name is not an address. Two "Notes" columns means one is mapped and one
    // goes nowhere, and someone who typed into the second copy deserves to be
    // told rather than to find the sheet unchanged (G13).
    const m = suggestMapping(["Notes", "Notes"]);
    expect(m.notes).toEqual({ header: "Notes", index: 0, confidence: 1, source: "alias" });
    expect(unmappedHeaders(["Notes", "Notes"], m)).toEqual(["Notes"]);
  });

  it("never gives one column to two fields", () => {
    // "Application URL Date" is in here because it is the only header shape that
    // makes this rule load-bearing against the current alias table: it clears the
    // floor for BOTH `url` (0.867) and `appliedDate` (0.839). Without the
    // bookkeeping that spends a column once a field takes it, the same column
    // lands in two fields, the same value is written twice, and the preview shows
    // nothing wrong.
    const m = suggestMapping(["Company", "Application URL Date"]);
    expect(m.url?.index).toBe(1);
    expect(m.appliedDate).toBeNull();

    const headers = [
      "Company",
      "Companies",
      "Application URL Date",
      "Job Titles",
      "Statuses",
      "Locations",
      "Note",
      "Due Dates",
    ];
    const wide = suggestMapping(headers);
    const used = MAPPABLE_FIELDS.map((f) => wide[f]?.index).filter((i) => i !== undefined);
    expect(new Set(used).size).toBe(used.length);
  });

  it("assigns the best pair globally, not in field declaration order", () => {
    // `company` is declared before `location`. Walking fields in order would let
    // it take a 0.84 header that `location` matches at 0.93.
    const m = suggestMapping(["Locations"]);
    expect(m.location?.header).toBe("Locations");
    expect(m.company).toBeNull();
  });

  it("gives the same answer twice for the same headers", () => {
    const headers = ["Statuses", "Locations", "Job Titles", "Companies", "Contact Company"];
    expect(suggestMapping(headers)).toEqual(suggestMapping(headers));
  });

  it("ignores blank headers instead of mapping onto them", () => {
    const m = suggestMapping(["", "   ", "Company"]);
    expect(m.company?.header).toBe("Company");
  });
});

describe("round-trip columns", () => {
  it("matches hq_id and hq_version exactly and flips the batch into round-trip mode", () => {
    const m = suggestMapping(["Company", "Job Title", "hq_id", "hq_version"]);
    expect(m.hqId).toEqual({ header: "hq_id", index: 2, confidence: 1, source: "alias" });
    expect(m.hqVersion).toEqual({ header: "hq_version", index: 3, confidence: 1, source: "alias" });
    expect(isRoundTrip(m)).toBe(true);
  });

  it("never fuzzy-matches them", () => {
    // A near-miss here hands the matcher primary keys from somebody else's
    // numbering scheme, and nothing about that is visible until it writes.
    const m = suggestMapping(["HQ Identifier", "HQ Versions", "HQ"]);
    expect(m.hqId).toBeNull();
    expect(m.hqVersion).toBeNull();
    expect(isRoundTrip(m)).toBe(false);
  });

  it("needs both columns, not either", () => {
    // hq_id alone would match rows by id and write them with no concurrency
    // token at all — the exact overwrite AC 23 exists to prevent.
    expect(isRoundTrip(suggestMapping(["Company", "hq_id"]))).toBe(false);
    expect(isRoundTrip(suggestMapping(["Company", "hq_version"]))).toBe(false);
  });
});

describe("a 60-column spreadsheet", () => {
  it("maps all nine targets and leaves the other 51 headers alone", async () => {
    const [sheet] = await readWorkbook(readFileSync(join(FIXTURES, "wide-60.xlsx")));
    const headers = sheet.rows[0].map((c) => String(c));
    expect(headers).toHaveLength(60);

    const m = suggestMapping(headers);
    for (const field of TARGET_FIELDS) {
      expect(m[field], `${field} should be mapped`).not.toBeNull();
    }
    // 60 headers, 9 mapped: the rest go to the unknown-column report, not into
    // a field that happened to score 0.83 against "Extra Field 41".
    expect(unmappedHeaders(headers, m)).toHaveLength(51);
    for (const header of unmappedHeaders(headers, m)) {
      expect(header).toMatch(/^Extra Field \d+$/);
    }
  });
});

describe("sampleValues", () => {
  const rows = [
    ["Company", "Notes", "Notes"],
    ["Acme", "", "call back"],
    ["Globex", "sent follow-up", ""],
    ["Initech", "waiting", "second round"],
    ["Umbrella", "no reply", "cold"],
  ];

  it("returns up to three live values per header", () => {
    const s = sampleValues(rows, 0);
    expect(s["Company"]).toEqual(["Acme", "Globex", "Initech"]);
  });

  it("skips blanks, because three empty samples say nothing", () => {
    // Column 2's first cell is empty and the sample starts at row 3. The first
    // rows of a real export are often the emptiest, and a mapping screen showing
    // three blanks is the same as showing no data at all.
    expect(sampleValues(rows, 0)["Notes"]).toEqual(["sent follow-up", "waiting", "no reply"]);
  });

  it("falls through to a second column of the same name to fill the bucket", () => {
    // Duplicate header names share one bucket, because the mapping UI keys on
    // the name — so the samples it shows have to cover every column wearing it.
    const sparse = [
      ["Notes", "Notes"],
      ["only value", "from the second column"],
      ["", "and another"],
    ];
    expect(sampleValues(sparse, 0)["Notes"]).toEqual([
      "only value",
      "from the second column",
      "and another",
    ]);
  });

  it("honours the requested count", () => {
    expect(sampleValues(rows, 0, 1)["Company"]).toEqual(["Acme"]);
    expect(sampleValues(rows, 0, 10)["Company"]).toHaveLength(4);
  });

  it("reads below the header row it was given, not from the top of the file", () => {
    const withPreamble = [["My tracker", "", ""], ...rows];
    const s = sampleValues(withPreamble, 1);
    expect(s["Company"]).toEqual(["Acme", "Globex", "Initech"]);
    expect(s["My tracker"]).toBeUndefined();
  });

  it("renders a date cell as a date rather than a timestamp", () => {
    const s = sampleValues(
      [["Applied"], [new Date(Date.UTC(2026, 0, 15))]],
      0,
    );
    expect(s["Applied"]).toEqual(["2026-01-15"]);
  });
});
