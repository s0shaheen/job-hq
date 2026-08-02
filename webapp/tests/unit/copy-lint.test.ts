import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// Plain .mjs, deliberately untyped: the CLI and this test are the only
// consumers, and a build step between a lint rule and the test that proves the
// rule can fail is one more thing that can quietly stop being true.
import { RULES, scanString, needsRegeneration } from "@/scripts/copy-lint/rules.mjs";
import { extractCopy } from "@/scripts/copy-lint/extract.mjs";
import { applyAllowlist, findViolations, loadAllowlist } from "@/scripts/copy-lint/run.mjs";

/**
 * The copy lint, proven able to fail.
 *
 * This file exists because of the standing rule that a new test cannot be
 * trusted until it has been watched failing. A lint is the worst offender: it
 * reports "clean" whether it is working or not, and a rule whose regex never
 * matches anything is indistinguishable from a codebase that never violates it.
 * So every rule is fired at a fixture that violates it AND at a control string
 * that must stay clean.
 *
 * The control halves are the load-bearing ones. A rule that matched everything
 * would satisfy the first assertion of every pair; only the negative case
 * separates "the rule works" from "the rule is a wildcard".
 */

type Hit = { rule: string; match: string; doc: string; hint?: string };
const rulesHit = (text: string): string[] =>
  (scanString(text) as Hit[]).map((h) => h.rule);

/**
 * One violating string and one innocent string per rule.
 *
 * The clean side is chosen to sit as close to the rule as it can without
 * tripping it — "the export supports CSV" against the banned filler "supports
 * your workflow", "just now" against the minimizer "just click" — because a rule
 * is only worth having if it can tell those two apart.
 */
const CASES: Array<{ rule: string; dirty: string; clean: string }> = [
  {
    rule: "engine-vocab",
    dirty: "The sweep found 12 new roles.",
    clean: "The scan found 12 new roles.",
  },
  {
    rule: "dictionary-term",
    dirty: "This batch imported 32 rows.",
    clean: "This import added 32 rows.",
  },
  {
    rule: "engine-vocab-none-as-value",
    dirty: "none",
    clean: "Not listed",
  },
  {
    rule: "ai-vocab-tier-1",
    dirty: "This highlights available roles.",
    clean: "Saved. The next scan uses it.",
  },
  {
    rule: "ai-vocab-tier-2",
    dirty: "Simply paste a list of companies.",
    clean: "Paste a list of companies.",
  },
  {
    rule: "ai-vocab-tier-3",
    dirty: "Navigate your job search.",
    clean: "Review your job search.",
  },
  {
    rule: "filler-mood",
    dirty: "Please pick a column.",
    clean: "Pick a column.",
  },
  {
    rule: "construction-negative-parallelism",
    dirty: "This is not just a tracker, but a decision surface.",
    clean: "This tracks applications and records decisions.",
  },
  {
    rule: "construction-no-x-no-y",
    dirty: "No setup. No spreadsheets. Just roles.",
    clean: "No setup is needed. Roles arrive twice a day.",
  },
  {
    rule: "construction-significance-formula",
    dirty: "Pay plays a crucial role in shaping which roles reach you.",
    clean: "Your pay floor decides which roles reach you.",
  },
  {
    rule: "construction-trailing-participle",
    dirty: "Decisions sync when you reconnect, ensuring nothing is lost.",
    clean: "Decisions sync when you reconnect.",
  },
  {
    rule: "construction-copula-avoidance",
    dirty: "This column serves as the row identity.",
    clean: "This column is the row identity.",
  },
  {
    rule: "construction-rhetorical-question",
    dirty: "The result? Fewer roles to read.",
    clean: "Fewer roles to read.",
  },
  {
    rule: "construction-glazing",
    dirty: "Great choice. That role is saved.",
    clean: "Saved for later.",
  },
  {
    rule: "construction-coverage-sweep",
    dirty: "Everything from finding to applying happens here.",
    clean: "Roles arrive here, and applications are submitted from here.",
  },
  {
    rule: "em-dash",
    dirty: "Couldn't save that — your session expired.",
    clean: "Couldn't save that. Your session expired.",
  },
  {
    rule: "curly-quote",
    dirty: "Saved “Chicago finance” as a view.",
    clean: 'Saved "Chicago finance" as a view.',
  },
  {
    rule: "exclamation",
    dirty: "All done!",
    clean: "You are done for today.",
  },
  {
    rule: "glue-glyph",
    dirty: "Jobs / Applications",
    clean: "Ramp, Product Manager",
  },
  {
    rule: "ellipsis",
    dirty: "Checking the last 30 days…",
    clean: "Checking the last 30 days",
  },
  {
    rule: "bold-inline-markup",
    dirty: "Of <strong>47</strong> postings, 12 matched.",
    clean: "Of 47 postings, 12 matched.",
  },
  {
    rule: "italic-markup",
    dirty: "Open <em>See all employees</em> and paste the address.",
    clean: 'Open "See all employees" and paste the address.',
  },
];

describe("every copy rule can fail, and does not fire on clean copy", () => {
  it("covers every rule the lint declares", () => {
    // A rule added without a fixture is a rule nobody has watched fail. This is
    // the assertion that makes that impossible rather than merely discouraged.
    const declared = (RULES as Array<{ id: string }>).map((r) => r.id).sort();
    const covered = CASES.map((c) => c.rule).sort();
    expect(covered).toEqual(declared);
  });

  for (const { rule, dirty, clean } of CASES) {
    it(`${rule} fires on its violation and stays silent on the fix`, () => {
      expect(rulesHit(dirty), `"${dirty}" should trip ${rule}`).toContain(rule);
      expect(rulesHit(clean), `"${clean}" should not trip ${rule}`).not.toContain(rule);
    });
  }

  it("reports the violated spec sentence, not just a rule id", () => {
    // "Regenerate with the violated rule quoted" is the design's own
    // instruction, and it is impossible if the failure says only "banned word".
    const hits = scanString("The sweep found 12 new roles.") as Hit[];
    const hit = hits.find((h) => h.rule === "engine-vocab")!;
    expect(hit.doc).toContain("Engine vocabulary");
    expect(hit.match).toBe("sweep");
  });

  it("names the replacement for a dictionary term", () => {
    const hits = scanString("This batch imported 32 rows.") as Hit[];
    const hit = hits.find((h) => h.rule === "dictionary-term")!;
    expect(hit.hint).toContain("import");
  });

  it("flags a string for regeneration at one construction or two vocabulary hits", () => {
    // The spec's density rule, reported rather than enforced: one construction
    // hit means the string gets rewritten from the templates, not sanded.
    expect(needsRegeneration(scanString("This column serves as the row identity."))).toBe(true);
    expect(needsRegeneration(scanString("The sweep read the batch."))).toBe(true);
    expect(needsRegeneration(scanString("The sweep found 12 roles."))).toBe(false);
  });
});

describe("the extractor takes copy and leaves values alone", () => {
  const parse = (src: string) =>
    (extractCopy(src, "app/probe.tsx") as Array<{ text: string }>).map((f) => f.text);

  it("takes JSX text, copy attributes and toast arguments", () => {
    const found = parse(`
      export function P() {
        return (
          <div className="uppercase tracking-wider" data-testid="probe">
            The sweep found roles.
            <button title="Retry the sweep" onClick={() => toast("Sweep failed")}>
              {n === 1 ? "1 row" : "many rows"}
            </button>
          </div>
        );
      }
    `);
    expect(found).toContain("The sweep found roles.");
    expect(found).toContain("Retry the sweep");
    expect(found).toContain("Sweep failed");
    expect(found).toContain("many rows");
    // MUTATION REASON: drop the className/data-testid exclusions and these two
    // land in the report. A lint whose output is two-thirds class names is a
    // lint everybody learns to skip.
    expect(found).not.toContain("uppercase tracking-wider");
    expect(found).not.toContain("probe");
  });

  it("leaves comparison operands, case labels and handler arguments as values", () => {
    const found = parse(`
      export function P() {
        return (
          <span onClick={() => decide(job, "dismissed")}>
            {triage === "snoozed" ? "Later" : "Needs decision"}
            {SETS.includes("dismissed") ? null : "All"}
          </span>
        );
      }
    `);
    // MUTATION REASON: make isValueNotCopy return false and every one of these
    // stored tokens is reported as banned copy — which is what happened on the
    // first run, and it is how a gate teaches people to reach for the allowlist.
    expect(found).not.toContain("dismissed");
    expect(found).not.toContain("snoozed");
    expect(found).toContain("Later");
    expect(found).toContain("Needs decision");
  });

  it("reads a styling slot object as styles, not as copy", () => {
    // sonner takes `classNames` as a PROP OBJECT, so its Tailwind important
    // modifiers sit inside a JSX expression and read as exclamation points.
    const found = parse(`
      export function P() {
        return <Toaster toastOptions={{ classNames: { toast: "!bg-surface !text-text" } }} />;
      }
    `);
    expect(found.join(" ")).not.toContain("!bg-surface");
  });

  it("takes banned punctuation even when a variable carries it into JSX", () => {
    const found = parse(`
      export function P({ sorted }) {
        const note = sorted ? "· sorted" : null;
        const result = "Saved — the next scan uses it.";
        return <span>{note}{result}</span>;
      }
    `);
    expect(found).toContain("· sorted");
    expect(found).toContain("Saved — the next scan uses it.");
  });

  it("takes strings returned by display helpers outside dictionary files", () => {
    const found = parse(`
      function statusLabel(value) {
        if (value === "snoozed") return "Snoozed";
        return "Needs decision";
      }
      export function P({ value }) {
        return <span>{statusLabel(value)}</span>;
      }
    `);
    expect(found).toContain("Snoozed");
    expect(found).toContain("Needs decision");
  });

  it("follows a local variable rendered by JSX", () => {
    const found = parse(`
      export function P() {
        const status = "The sweep failed.";
        return <span>{status}</span>;
      }
    `);
    expect(found).toContain("The sweep failed.");
  });

  it("takes user-facing error strings from a JSON response sink", () => {
    const found = parse(`
      export function GET() {
        return NextResponse.json({ error: "Oops. The sweep failed.", code: "sweep_failed" });
      }
    `);
    expect(found).toContain("Oops. The sweep failed.");
    expect(found).not.toContain("sweep_failed");
  });

  it("marks bold spans nested inside sentence copy", () => {
    const found = parse(`
      export function P() {
        return <p>Of <strong>47</strong> postings, 12 matched.</p>;
      }
    `);
    expect(found).toContain("<strong>");
  });
});

describe("the allowlist is a reviewed exception, never a silent one", () => {
  const violation = {
    file: "app/(app)/probe/page.tsx",
    rule: "engine-vocab",
    match: "sweep",
    line: 1,
    column: 1,
  };

  it("suppresses only an exact file + rule + match, case-insensitively", () => {
    const entry = { ...violation, reason: "x".repeat(25) };
    expect(applyAllowlist([violation], [entry]).remaining).toEqual([]);
    expect(
      applyAllowlist([{ ...violation, match: "Sweep" }], [entry]).remaining,
    ).toEqual([]);
    // A different file with the same word is a different decision.
    expect(
      applyAllowlist([{ ...violation, file: "app/other.tsx" }], [entry]).remaining,
    ).toHaveLength(1);
  });

  it("fails an entry that no longer matches anything", () => {
    // MUTATION REASON: return `stale: []` unconditionally and this is the only
    // assertion that fails. A suppression that no longer suppresses is how a
    // gate quietly stops gating, and nothing else in the suite would notice.
    const entry = { ...violation, reason: "x".repeat(25) };
    const { remaining, stale } = applyAllowlist([], [entry]);
    expect(remaining).toEqual([]);
    expect(stale).toEqual([entry]);
  });

  it("refuses an entry with no reason, and one with a token reason", () => {
    // The REAL loader against a fixture file, not a re-implementation of its
    // check: the first version of this test asserted its own two lines and
    // survived deleting the guard entirely.
    //
    // MUTATION REASON: replace the reason check in loadAllowlist with `if
    // (false)` and both expectations here fail.
    const dir = mkdtempSync(path.join(tmpdir(), "copy-lint-"));
    const write = (entries: unknown[]) => {
      const f = path.join(dir, `${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(f, JSON.stringify({ entries }));
      return f;
    };
    expect(() => loadAllowlist(write([{ file: "a.tsx", rule: "em-dash", match: "—" }]))).toThrow(
      /reason/i,
    );
    expect(() =>
      loadAllowlist(write([{ file: "a.tsx", rule: "em-dash", match: "—", reason: "legacy" }])),
    ).toThrow(/reason/i);
    // A real reason loads.
    const ok = loadAllowlist(
      write([
        {
          file: "a.tsx",
          rule: "em-dash",
          match: "—",
          reason: "Owned by the Coverage surface build, which deletes this component.",
        },
      ]),
    ) as unknown[];
    expect(ok).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the committed allowlist parses and every entry carries a real reason", () => {
    for (const entry of loadAllowlist() as Array<{ reason: string }>) {
      expect(entry.reason.trim().length).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("the lint over the real tree", () => {
  it("is clean, and the allowlist has no stale entries", () => {
    // The gate itself, run from the suite so a red lint cannot be discovered
    // only in CI. Slow-ish (it parses every surface), and worth it.
    const { remaining, stale } = applyAllowlist(findViolations(), loadAllowlist());
    expect(
      remaining.map(
        (v: { file: string; line: number; rule: string; match: string }) =>
          `${v.file}:${v.line} [${v.rule}] ${v.match}`,
      ),
    ).toEqual([]);
    expect(stale).toEqual([]);
  });
});
