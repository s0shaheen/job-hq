import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { atsOf, isStrong, jobKey, PATTERNS } from "@/lib/import/job-key";

/**
 * The TypeScript job key, compared against the engine that mints it.
 *
 * `core/jobkeys.py` is the authority — discovery, the joiner and every migrated
 * row carry keys it produced. Import computes the same key in the browser tier
 * so dedup preview can say "you already have this" before anything is written,
 * and a key that differs by one character makes every re-import a silent
 * duplicate: no error, two rows for one job, noticed weeks later.
 *
 * So both sides assert against ONE recorded file,
 * `tests/fixtures/jobkeys.golden.json`, whose keys came out of the Python and
 * were never hand-typed. `tests/core/test_jobkeys_golden.py` is the other half.
 * Edit one implementation without the other and exactly one language goes red.
 *
 * The parity block below goes further and parses `core/jobkeys.py` itself, the
 * way `status.test.ts` parses `core/schema.py`: the golden catches a pattern
 * whose BEHAVIOUR drifted, and parsing catches one that was added, reordered,
 * or given a different flag before anybody wrote a case for it.
 *
 * Matrix row 29 in docs/plans/README.md; docs/plans/PHASE-IMPORT.md §4.1.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

interface GoldenCase {
  why: string;
  url: string;
  company: string;
  title: string;
  location: string;
  key: string;
  strong: boolean;
}

const CASES: GoldenCase[] = JSON.parse(
  readFileSync(path.join(REPO, "tests", "fixtures", "jobkeys.golden.json"), "utf8"),
);

const JOBKEYS_PY = readFileSync(path.join(REPO, "core", "jobkeys.py"), "utf8");

/**
 * `_PATTERNS` out of the Python: the ats token, the raw regex source with
 * `{_UUID}` expanded, and whether `re.I` was passed.
 *
 * The raw strings in `core/jobkeys.py` contain no `"` and no escaped quote, so
 * `[^"]*` is exact rather than approximate — worth stating, because a regex
 * that silently matched a prefix would make every comparison below weaker
 * without failing.
 */
function pyPatterns(): { ats: string; source: string; ignoreCase: boolean }[] {
  const uuid = /^_UUID\s*=\s*r"([^"]*)"/m.exec(JOBKEYS_PY);
  if (!uuid) throw new Error("_UUID not found in core/jobkeys.py");
  const block = /_PATTERNS[^=]*=\s*\[([\s\S]*?)\n\]/.exec(JOBKEYS_PY);
  if (!block) throw new Error("_PATTERNS not found in core/jobkeys.py");
  const entries = [
    ...block[1].matchAll(/\("([a-z0-9]+)",\s*re\.compile\(rf?"([^"]*)"(\s*,\s*re\.I)?\)\)/g),
  ];
  return entries.map((m) => ({
    ats: m[1],
    source: m[2].split("{_UUID}").join(uuid[1]),
    ignoreCase: Boolean(m[3]),
  }));
}

/**
 * A JS `RegExp.source` escapes `/` (so `eval("/" + source + "/")` is valid) and
 * the literals in `job-key.ts` write `\/` for readability. Python's raw strings
 * do neither. Undoing that one escape is the whole difference between the two
 * spellings — anything else that differs is a real divergence.
 */
function comparableSource(re: RegExp): string {
  return re.source.replace(/\\\//g, "/");
}

describe("parity with core/jobkeys.py", () => {
  it("finds _PATTERNS at all — otherwise every check below is vacuous", () => {
    expect(pyPatterns().length).toBeGreaterThan(10);
    expect(PATTERNS.length).toBeGreaterThan(10);
  });

  it("has the same patterns, in the same order, with the same sources", () => {
    // Order is behaviour here, not style: first match wins, and `sfsf` matches a
    // URL shape rather than a host, so moving it up would hijack postings that
    // belong to a named ATS.
    expect(PATTERNS.map(([ats, re]) => [ats, comparableSource(re)])).toEqual(
      pyPatterns().map((p) => [p.ats, p.source]),
    );
  });

  it("puts the case-insensitive flag on exactly the pattern Python does", () => {
    // `re.I` is on the workday entry alone. A stray `/i` elsewhere would make
    // `careers-ACME.icims.com` key differently from the engine's `icims-acme-…`.
    expect(PATTERNS.map(([, re]) => re.flags)).toEqual(
      pyPatterns().map((p) => (p.ignoreCase ? "i" : "")),
    );
    expect(pyPatterns().filter((p) => p.ignoreCase).map((p) => p.ats)).toEqual(["workday"]);
  });

  it("never compiles a pattern with the global flag", () => {
    // A `/g` regex carries `lastIndex` between calls, so the second call with the
    // same URL would return null. Python's `re` has no such state.
    for (const [ats, re] of PATTERNS) expect([ats, re.global]).toEqual([ats, false]);
  });
});

describe("the golden corpus", () => {
  it("is actually loaded", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
    expect(Object.keys(CASES[0]).sort()).toEqual(
      ["company", "key", "location", "strong", "title", "url", "why"],
    );
  });

  it("covers every ats token the Python defines", () => {
    // The same assertion the pytest makes, from the other side: if a family is
    // in `_PATTERNS` but nothing in the corpus produces its key, neither
    // language is testing it.
    const produced = new Set(CASES.filter((c) => c.strong).map((c) => atsOf(c.key)));
    const missing = [...new Set(pyPatterns().map((p) => p.ats))].filter(
      (ats) => !produced.has(ats),
    );
    expect(missing).toEqual([]);
  });

  it("covers both fallbacks and the empty key", () => {
    expect(CASES.filter((c) => c.key.startsWith("norm-")).length).toBeGreaterThanOrEqual(10);
    expect(CASES.filter((c) => c.key.startsWith("url-")).length).toBeGreaterThanOrEqual(10);
    expect(CASES.filter((c) => c.key === "").length).toBeGreaterThanOrEqual(1);
  });
});

describe("jobKey matches core/jobkeys.py, case by case", () => {
  it.each(CASES.map((c) => [c.why, c] as const))("%s", (_why, c) => {
    // The url rides along in the assertion so a failure names the input rather
    // than making someone count rows in the fixture.
    expect([c.url, jobKey(c)]).toEqual([c.url, c.key]);
  });
});

describe("isStrong matches core/jobkeys.py, case by case", () => {
  it.each(CASES.map((c) => [c.why, c] as const))("%s", (_why, c) => {
    expect([c.key, isStrong(c.key)]).toEqual([c.key, c.strong]);
  });
});

describe("isStrong", () => {
  it("refuses both weak prefixes and the empty key", () => {
    // The only thing allowed to authorize an import merge. A weak key is a guess
    // that two rows are the same job; merging on a guess destroys the loser.
    expect(isStrong("norm-acme|pm|ny")).toBe(false);
    expect(isStrong("url-acme.io/careers/pm")).toBe(false);
    expect(isStrong("")).toBe(false);
    expect(isStrong(null)).toBe(false);
    expect(isStrong(undefined)).toBe(false);
    expect(isStrong("greenhouse-4285367")).toBe(true);
  });
});

describe("atsOf", () => {
  it("takes everything before the first hyphen, including on multi-hyphen keys", () => {
    expect(atsOf("icims-acme-12345")).toBe("icims");
    expect(atsOf("workday-JR-123456")).toBe("workday");
    expect(atsOf("lever-0c66e8ed-1c18-4b64-ad27-a522a866b6e1")).toBe("lever");
    expect(atsOf("")).toBe("");
    expect(atsOf(null)).toBe("");
  });
});

describe("the argument shapes the Python allows", () => {
  it("treats missing fields as empty, the way job_key's defaults do", () => {
    expect(jobKey({})).toBe("");
    expect(jobKey()).toBe("");
    expect(jobKey({ url: null, company: null, title: null, location: null })).toBe("");
    expect(jobKey({ company: "Acme", title: "PM" })).toBe("norm-acme|pm|");
  });

  it("never throws on a relative url, where new URL() would", () => {
    // The reason the fallback hand-rolls urlparse. `new URL("careers/foo/bar")`
    // raises TypeError, and a throw here would take out the whole preview.
    expect(() => new URL("careers/foo/bar")).toThrow();
    expect(jobKey({ url: "careers/foo/bar" })).toBe("url-careers/foo/bar");
  });
});
