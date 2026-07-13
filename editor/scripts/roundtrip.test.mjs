// Fidelity tests for lib/yamlops.ts — the load-bearing claim of this app:
// structured ops edit ONLY the touched nodes; comments/quoting/blank lines
// survive. Runs on Node >= 22.7 (native TS type stripping): `npm test`.
// The last two tests exercise the real repo files when run from the monorepo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyOps, yamlError } from "../lib/yamlops.ts";

const here = dirname(fileURLToPath(import.meta.url));

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
  assert.equal(applyOps(FIXTURE, []), FIXTURE);
});

test("set bullet changes exactly one line, comments intact", () => {
  const out = applyOps(FIXTURE, [
    { op: "set", path: ["cv", "sections", "experience", 0, "highlights", 0], value: "Rewritten bullet" },
  ]);
  assert.deepEqual(changedLines(FIXTURE, out), [9]);
  assert.ok(out.startsWith("# top-of-file comment must survive"));
  assert.ok(out.includes("position: PM # inline comment"));
});

test("set keeps quoting style on a quoted scalar", () => {
  const out = applyOps(FIXTURE, [
    { op: "set", path: ["cv", "sections", "experience", 0, "highlights", 2], value: "Still: quoted" },
  ]);
  assert.ok(out.includes('- "Still: quoted"'));
});

test("move reorders without rewriting content", () => {
  const out = applyOps(FIXTURE, [
    { op: "move", path: ["cv", "sections", "experience", 0, "highlights"], from: 0, to: 1 },
  ]);
  assert.ok(out.indexOf("Second bullet") < out.indexOf("First bullet"));
  assert.equal([...FIXTURE.split("\n")].sort().join("\n"), [...out.split("\n")].sort().join("\n"));
});

test("insert then remove returns to the original", () => {
  const path = ["cv", "sections", "experience", 0, "highlights"];
  const added = applyOps(FIXTURE, [{ op: "insert", path, index: 3, value: "Temp bullet" }]);
  assert.ok(added.includes("- Temp bullet"));
  const back = applyOps(added, [{ op: "remove", path, index: 3 }]);
  assert.equal(back, FIXTURE);
});

test("op against a bogus path fails loud with the op index", () => {
  assert.throws(
    () => applyOps(FIXTURE, [{ op: "move", path: ["cv", "nope"], from: 0, to: 1 }]),
    /op 0 \(move/,
  );
});

test("yamlError: null on valid, message on broken", () => {
  assert.equal(yamlError(FIXTURE), null);
  assert.match(yamlError("a: [1, 2") ?? "", /./);
});

// ---- real repo files (skipped when the editor is checked out standalone) ----

const realBase = join(here, "..", "..", "resume", "base.yaml");
const realDesign = join(here, "..", "..", "resume", "design.yaml");

test("repo base.yaml: no-op replay is byte-identical", { skip: !existsSync(realBase) }, () => {
  const src = readFileSync(realBase, "utf8");
  assert.equal(applyOps(src, []), src);
});

test("repo base.yaml: bullet edit touches exactly one line", { skip: !existsSync(realBase) }, () => {
  const src = readFileSync(realBase, "utf8");
  const out = applyOps(src, [
    { op: "set", path: ["cv", "sections", "experience", 0, "highlights", 0], value: "EDITED" },
  ]);
  assert.equal(changedLines(src, out).length, 1);
});

test("repo design.yaml: parses clean (raw mode never round-trips it)", { skip: !existsSync(realDesign) }, () => {
  assert.equal(yamlError(readFileSync(realDesign, "utf8")), null);
});
