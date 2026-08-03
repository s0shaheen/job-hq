/**
 * "GREEN" MUST NOT BE ABLE TO MEAN "NOTHING RAN".
 *
 * Playwright exits 0 on a run that matched no tests, and it exits 0 on a run
 * where every test skipped. Both are the failure mode `tests/db` already cost
 * this repo once: a suite that reports success while executing none of the
 * cases it is credited with. For the live lane that is worse than for any other
 * suite, because it is the ONLY thing that can retire the coverage ledger's
 * `live` column — a vacuous pass here would mark 189 cells verified by nothing.
 *
 * So the workflow reads the report back and asserts, positively:
 *
 *   - the live projects are the ones that ran (a fixture run cannot satisfy it);
 *   - at least one test EXPECTED to run;
 *   - at least one test actually PASSED, rather than every one skipping.
 *
 * Deliberately plain `.mjs`: it runs in `if: always()`, including after the step
 * that would have installed anything it needed. A postflight with dependencies
 * is a postflight that does not run on the days it matters.
 */
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node live-postflight.mjs <playwright-json-report>");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  console.error(
    `POSTFLIGHT FAILED: cannot read the live lane's report at ${path} (${error.message}).\n` +
      "No report means no evidence the lane ran at all. Refusing to call this a pass.",
  );
  process.exit(1);
}

/** Every test result in the report, flattened out of the suite tree. */
function* results(suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      yield { projectName: test.projectName, status: test.status, results: test.results ?? [] };
    }
  }
  for (const child of suite.suites ?? []) yield* results(child);
}

const all = [];
for (const suite of report.suites ?? []) all.push(...results(suite));

const problems = [];

const projects = new Set(all.map((t) => t.projectName));
if (![...projects].some((name) => name.startsWith("live-"))) {
  problems.push(
    `no live-* project ran. Projects seen: ${[...projects].join(", ") || "(none)"}. ` +
      "A fixture run cannot satisfy the live lane.",
  );
}

if (all.length === 0) {
  problems.push("the report contains zero tests: the run matched nothing.");
}

// Counted over the LIVE projects only, not the whole report.
//
// The shipped config cannot produce a report mixing fixture and live projects —
// `HQ_LIVE_E2E=1` swaps the project list wholesale. But the reviewer hand-built
// one, and it satisfied the old check: fixture passes plus live skips read as
// "something passed". That is the cheating report this file exists to refuse,
// and "the config cannot currently emit it" is an argument about today's config,
// not about this check. Count what the claim is about.
const live = all.filter((t) => (t.projectName ?? "").startsWith("live-"));
const passed = live.filter((t) => (t.results ?? []).some((r) => r.status === "passed")).length;
const skipped = live.filter((t) => t.status === "skipped").length;
if (passed === 0) {
  problems.push(
    `no LIVE test passed (${live.length} live tests collected, ${skipped} skipped; ` +
      `${all.length} tests in the report overall). A lane where every live test skips ` +
      "reports success and proves nothing — the exact failure this check exists for.",
  );
}

if (problems.length > 0) {
  console.error("POSTFLIGHT FAILED: the live lane did not prove anything.\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nSee webapp/tests/live/README.md.");
  process.exit(1);
}

console.log(
  `live lane postflight ok: ${passed} live tests passed, ${skipped} skipped, ` +
    `projects: ${[...projects].join(", ")}`,
);
