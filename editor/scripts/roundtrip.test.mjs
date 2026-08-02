// @ts-check
// Fidelity tests for lib/yamlops.ts — the load-bearing claim of this app:
// structured ops edit ONLY the touched nodes; comments, blank lines and
// quoting style survive. `npm test`.
//
// Requires Node >= 22.18 (see package.json `engines`): this file imports a
// .ts module directly (native type stripping, on by default from 22.18) and
// `node --test` is handed a glob (runner glob support landed in 21).
//
// TWO LAYERS, on purpose:
//
//   1. scripts/fixtures/*.yaml — committed, neutral, ALWAYS present. Every
//      fidelity claim is asserted against these UNCONDITIONALLY. This is the
//      real coverage: it depends on nothing outside this directory, so moving
//      a deployment's resume tree elsewhere cannot silently delete it.
//   2. The deployment's own files (RESUME_PATH / DESIGN_PATH, resolved against
//      the repo root exactly as lib/github.ts reads them) — a BONUS check that
//      the claims also hold on real, messy content. Absent in a standalone
//      checkout, and that is where the trap is.
//
// THE TRAP: node:test prints a skipped test as `ok` and does not touch the exit
// code, so a suite that skips itself reports green — the same class of bug as
// the Postgres suite in tests/db/, and handled the same way:
//
//   * EDITOR_REQUIRE_FIXTURES=1 turns a would-be skip into a hard ERROR. CI
//     (and anything running inside the monorepo) should set it.
//   * Unconditionally, the suite counts the test bodies that actually RAN and
//     fails if that count drops below MIN_RUNS — a refactor that skips
//     everything cannot pass.
//   * The guard itself is tested (see "guard self-test" below). A guard nobody
//     tests is the same bug wearing a hat.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { applyOps, yamlError } from "../lib/yamlops.ts";

const here = dirname(fileURLToPath(import.meta.url));
const editorRoot = resolve(here, "..");
const repoRoot = resolve(editorRoot, "..");

const requireFixtures = () => process.env.EDITOR_REQUIRE_FIXTURES === "1";

/**
 * Resolve a file the app addresses through an env var, the way the app does:
 * RESUME_PATH / DESIGN_PATH are repo-root-relative (see lib/github.ts). The
 * paths are NOT hardcoded here on purpose — renaming resume/base.yaml without
 * updating the env var then fails loudly instead of skipping.
 *
 * Returns { path, rel, exists }. With `required`, a miss THROWS instead.
 *
 * @param {string} envName
 * @param {string} defaultRelPath
 * @param {{ required?: boolean, root?: string }} [opts]
 */
export function resolveFixture(envName, defaultRelPath, opts = {}) {
  const { required = requireFixtures(), root = repoRoot } = opts;
  const rel = process.env[envName] || defaultRelPath;
  const path = resolve(root, rel);
  const exists = existsSync(path);
  if (!exists && required) {
    throw new Error(
      `EDITOR_REQUIRE_FIXTURES=1 but ${envName} (${rel}) does not exist at ${path} — ` +
        "the tests that read it would have SKIPPED and this suite would have reported success",
    );
  }
  return { path, rel, exists };
}

// Module scope on purpose: with EDITOR_REQUIRE_FIXTURES=1 a missing file
// throws HERE, which node:test reports as a failed test FILE. No skips.
const deployBase = resolveFixture("RESUME_PATH", "resume/base.yaml");
const deployDesign = resolveFixture("DESIGN_PATH", "resume/design.yaml");

if (!deployBase.exists || !deployDesign.exists) {
  const missing = [deployBase, deployDesign].filter((f) => !f.exists).map((f) => f.rel).join(", ");
  const bar = "!".repeat(78);
  console.error(
    `\n${bar}\n` +
      `!! NOTICE — deployment resume files not found: ${missing}\n` +
      "!! The tests that read them are SKIPPED. node:test reports a skip as `ok`\n" +
      "!! and leaves the exit code at 0, so this run proves NOTHING about them.\n" +
      "!! Every fidelity claim is still covered by scripts/fixtures/ below.\n" +
      "!! Run with EDITOR_REQUIRE_FIXTURES=1 to make this a hard failure.\n" +
      `${bar}\n`,
  );
}

// ---- the non-skipped-test-count guard -------------------------------------
// Exactly the number of test bodies below that do NOT depend on a deployment
// file. Bump it when unconditional tests are added; if it ever has to go DOWN,
// coverage was deleted and that should be a conscious edit, not a silent skip.
const MIN_RUNS = 14;
let runs = 0;
let countAsserted = false;
const ran = () => {
  runs++;
};

// Belt and braces: if the counter test itself is skipped or deleted, the
// process still fails. A guard that can be switched off is not a guard.
process.on("exit", () => {
  if (countAsserted) return;
  console.error(
    "\nFATAL: the non-skipped-test-count guard never ran — someone skipped or " +
      "removed it, which is exactly the failure it exists to catch.\n",
  );
  process.exitCode = 1;
});

// ---- inline fixture: the minimal shape, easy to reason about --------------

const FIXTURE = `# top-of-file comment must survive
cv:
  name: Test Person
  sections:
    experience:
      - company: Acme
        position: PM # inline comment
        highlights:
          - First bullet
          - Second bullet
          - "Quoted: bullet stays quoted"
    skills:
      - label: AI
        details: Prompts, Agents
`;

/** @param {string} a @param {string} b */
function changedLines(a, b) {
  const la = a.split("\n");
  const lb = b.split("\n");
  const out = [];
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) out.push(i + 1);
  }
  return out;
}

test("no-op replay is byte-identical", () => {
  ran();
  assert.equal(applyOps(FIXTURE, []), FIXTURE);
});

test("set bullet changes exactly one line, comments intact", () => {
  ran();
  const out = applyOps(FIXTURE, [
    { op: "set", path: ["cv", "sections", "experience", 0, "highlights", 0], value: "Rewritten bullet" },
  ]);
  assert.deepEqual(changedLines(FIXTURE, out), [9]);
  assert.ok(out.startsWith("# top-of-file comment must survive"));
  assert.ok(out.includes("position: PM # inline comment"));
});

test("set keeps quoting style on a quoted scalar", () => {
  ran();
  const out = applyOps(FIXTURE, [
    { op: "set", path: ["cv", "sections", "experience", 0, "highlights", 2], value: "Still: quoted" },
  ]);
  assert.ok(out.includes('- "Still: quoted"'));
});

test("move reorders without rewriting content", () => {
  ran();
  const out = applyOps(FIXTURE, [
    { op: "move", path: ["cv", "sections", "experience", 0, "highlights"], from: 0, to: 1 },
  ]);
  assert.ok(out.indexOf("Second bullet") < out.indexOf("First bullet"));
  assert.equal([...FIXTURE.split("\n")].sort().join("\n"), [...out.split("\n")].sort().join("\n"));
});

test("insert then remove returns to the original", () => {
  ran();
  const path = ["cv", "sections", "experience", 0, "highlights"];
  const added = applyOps(FIXTURE, [{ op: "insert", path, index: 3, value: "Temp bullet" }]);
  assert.ok(added.includes("- Temp bullet"));
  const back = applyOps(added, [{ op: "remove", path, index: 3 }]);
  assert.equal(back, FIXTURE);
});

test("op against a bogus path fails loud with the op index", () => {
  ran();
  assert.throws(
    () => applyOps(FIXTURE, [{ op: "move", path: ["cv", "nope"], from: 0, to: 1 }]),
    /op 0 \(move/,
  );
});

test("yamlError: null on valid, message on broken", () => {
  ran();
  assert.equal(yamlError(FIXTURE), null);
  assert.match(yamlError("a: [1, 2") ?? "", /./);
});

// ---- neutral committed fixtures: the same claims, always run --------------

const neutralBase = resolveFixture("EDITOR_FIXTURE_RESUME", "scripts/fixtures/resume.yaml", {
  required: true,
  root: editorRoot,
});
const neutralDesign = resolveFixture("EDITOR_FIXTURE_DESIGN", "scripts/fixtures/design.yaml", {
  required: true,
  root: editorRoot,
});

test("neutral fixture: no-op replay is byte-identical", () => {
  ran();
  const src = readFileSync(neutralBase.path, "utf8");
  assert.equal(applyOps(src, []), src);
});

test("neutral fixture: bullet edit touches exactly one line", () => {
  ran();
  const src = readFileSync(neutralBase.path, "utf8");
  const out = applyOps(src, [
    { op: "set", path: ["cv", "sections", "experience", 0, "highlights", 0], value: "EDITED" },
  ]);
  assert.deepEqual(changedLines(src, out).length, 1);
});

test("neutral fixture: that edit keeps comments, blank lines and quoting", () => {
  ran();
  const src = readFileSync(neutralBase.path, "utf8");
  const out = applyOps(src, [
    { op: "set", path: ["cv", "sections", "experience", 0, "highlights", 0], value: "EDITED" },
  ]);
  assert.ok(out.startsWith("# Neutral test fixture"), "top-of-file comment block survives");
  assert.ok(out.includes("position: Product Manager # inline comment must survive an edit"));
  assert.ok(out.includes('- "Owned the pricing API: 6 internal consumers on one contract."'));
  assert.equal(
    (src.match(/\n\n/g) ?? []).length,
    (out.match(/\n\n/g) ?? []).length,
    "blank-line count must not change",
  );
});

test("neutral design fixture: parses clean (raw mode never round-trips it)", () => {
  ran();
  assert.equal(yamlError(readFileSync(neutralDesign.path, "utf8")), null);
});

// ---- guard self-tests: the skip-guard is itself under test ----------------

const MISSING_REL = "definitely/not/here/base.yaml";

test("guard self-test: EDITOR_REQUIRE_FIXTURES=1 turns a missing fixture into a throw", () => {
  ran();
  const prev = process.env.EDITOR_REQUIRE_FIXTURES;
  process.env.EDITOR_REQUIRE_FIXTURES = "1";
  try {
    assert.throws(
      () => resolveFixture("EDITOR_TEST_MISSING", MISSING_REL),
      /EDITOR_REQUIRE_FIXTURES=1 but EDITOR_TEST_MISSING .* does not exist/,
      "a missing fixture under the flag must throw, not skip",
    );
  } finally {
    if (prev === undefined) delete process.env.EDITOR_REQUIRE_FIXTURES;
    else process.env.EDITOR_REQUIRE_FIXTURES = prev;
  }
});

test("guard self-test: without the flag a missing fixture reports a miss, never throws", () => {
  ran();
  const prev = process.env.EDITOR_REQUIRE_FIXTURES;
  delete process.env.EDITOR_REQUIRE_FIXTURES;
  try {
    const r = resolveFixture("EDITOR_TEST_MISSING", MISSING_REL);
    assert.equal(r.exists, false);
    assert.equal(r.rel, MISSING_REL);
  } finally {
    if (prev !== undefined) process.env.EDITOR_REQUIRE_FIXTURES = prev;
  }
});

test("guard self-test: the env var overrides the default path", () => {
  ran();
  const prev = process.env.EDITOR_TEST_OVERRIDE;
  process.env.EDITOR_TEST_OVERRIDE = "scripts/fixtures/resume.yaml";
  try {
    const r = resolveFixture("EDITOR_TEST_OVERRIDE", MISSING_REL, { required: true, root: editorRoot });
    assert.equal(r.rel, "scripts/fixtures/resume.yaml");
    assert.ok(r.exists);
  } finally {
    if (prev === undefined) delete process.env.EDITOR_TEST_OVERRIDE;
    else process.env.EDITOR_TEST_OVERRIDE = prev;
  }
});

// ---- deployment files: a bonus, never the only coverage -------------------

const skipBase = deployBase.exists ? false : `${deployBase.rel} not in this checkout`;
const skipDesign = deployDesign.exists ? false : `${deployDesign.rel} not in this checkout`;

test("deployment base.yaml: no-op replay is byte-identical", { skip: skipBase }, () => {
  ran();
  const src = readFileSync(deployBase.path, "utf8");
  assert.equal(applyOps(src, []), src);
});

test("deployment base.yaml: bullet edit touches exactly one line", { skip: skipBase }, () => {
  ran();
  const src = readFileSync(deployBase.path, "utf8");
  const out = applyOps(src, [
    { op: "set", path: ["cv", "sections", "experience", 0, "highlights", 0], value: "EDITED" },
  ]);
  assert.equal(changedLines(src, out).length, 1);
});

test("deployment design.yaml: parses clean (raw mode never round-trips it)", { skip: skipDesign }, () => {
  ran();
  assert.equal(yamlError(readFileSync(deployDesign.path, "utf8")), null);
});

// ---- and the count check, last ---------------------------------------------

test(`guard: at least ${MIN_RUNS} test bodies actually ran (skips cannot hollow this suite out)`, () => {
  countAsserted = true;
  assert.ok(
    runs >= MIN_RUNS,
    `only ${runs} test bodies ran, expected >= ${MIN_RUNS}. Something that used to ` +
      "execute is now skipping, and node:test would have reported that as success.",
  );
});
