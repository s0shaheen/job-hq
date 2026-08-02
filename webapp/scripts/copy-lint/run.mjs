/**
 * The copy lint: the static half of the anti-slop gate.
 *
 * Pairs with `tests/e2e/slop.spec.ts` (the computed-style DOM sweep). The two
 * split the job the way the design's own checklist splits: this one reads the
 * SOURCE, so it catches a banned word in a branch no test happens to render;
 * that one reads the RENDERED PAGE, so it catches a style that no source string
 * can express. Neither subsumes the other, and a violation that survives both is
 * a violation nobody wrote down.
 *
 *   node scripts/copy-lint/run.mjs            # fail on any unallowed hit
 *   node scripts/copy-lint/run.mjs --json     # machine-readable, for triage
 *
 * ## The allowlist bargain
 *
 * `allowlist.json` entries are `{ file, rule, match, reason }`. A reason is
 * REQUIRED and is checked for length, because the repo's standing rule is that
 * an exception is a deliberate, reviewed act with a name on it. And an entry
 * that stops matching anything FAILS the run: a stale suppression is how a gate
 * quietly stops gating, and the only defence is making the dead entry as loud as
 * a live violation.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractCopy, DICTIONARY_FILES } from "./extract.mjs";
import { scanString, needsRegeneration } from "./rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP = path.resolve(HERE, "..", "..");

/** Source roots. `app` and `components` are every surface; the dictionary files
 *  are named individually because `lib` is overwhelmingly not copy. */
const ROOTS = ["app", "components"];

const SKIP_DIRS = new Set(["node_modules", ".next", "test-results", "playwright-report"]);

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

export function collectFiles() {
  const files = [];
  for (const root of ROOTS) walk(path.join(WEBAPP, root), files);
  for (const f of DICTIONARY_FILES) {
    const full = path.join(WEBAPP, f);
    // A named dictionary file that has moved must be LOUD, not skipped: the
    // whole value of naming them individually is that the vocabulary edge is
    // covered on purpose, and a silently-dropped path is coverage nobody
    // notices losing.
    if (!statSync(full, { throwIfNoEntry: false }))
      throw new Error(
        `copy-lint: DICTIONARY_FILES names ${f}, which does not exist. Update the list in ` +
          `scripts/copy-lint/extract.mjs — a moved dictionary file must not silently lose coverage.`,
      );
    files.push(full);
  }
  return files.sort();
}

const rel = (f) => path.relative(WEBAPP, f).replaceAll("\\", "/");

/**
 * Every violation in the tree, before the allowlist is applied.
 *
 * Deduplicated by (file, line, column, rule, match). Nested JSX expressions
 * reach the same literal from more than one visited node — a ternary inside a
 * fragment inside an attribute — and one string reported five times is a report
 * that reads as five problems.
 */
export function findViolations(files = collectFiles()) {
  const violations = [];
  const seen = new Set();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const item of extractCopy(source, file)) {
      const hits = scanString(item.text);
      if (!hits.length) continue;
      const regenerate = needsRegeneration(hits);
      for (const hit of hits) {
        const id = `${rel(file)}:${item.line}:${item.column}:${hit.rule}:${hit.match}`;
        if (seen.has(id)) continue;
        seen.add(id);
        violations.push({
          file: rel(file),
          line: item.line,
          column: item.column,
          context: item.context,
          rule: hit.rule,
          doc: hit.doc,
          hint: hit.hint,
          match: hit.match,
          text: item.text.length > 160 ? `${item.text.slice(0, 157)}...` : item.text,
          regenerate,
        });
      }
    }
  }
  return violations;
}

/**
 * @param file the allowlist to read. Parameterised ONLY so the self-test can
 *   run the real guard against a fixture: a test that re-implements the check
 *   in its own body proves the test, not the code.
 */
export function loadAllowlist(file = path.join(HERE, "allowlist.json")) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const entries = raw.entries ?? [];
  for (const [i, e] of entries.entries()) {
    if (!e.file || !e.rule || !e.match)
      throw new Error(`allowlist entry ${i} needs file, rule and match`);
    if (!e.reason || e.reason.trim().length < 20)
      throw new Error(
        `allowlist entry ${i} (${e.file} / ${e.rule} / ${e.match}) needs a reason of at least ` +
          `20 characters. An exception without a stated reason is a silent suppression.`,
      );
  }
  return entries;
}

/**
 * Apply the allowlist.
 *
 * Match is exact on file and rule, and case-insensitive on the matched text —
 * an entry for "sweep" covers the sentence-initial "Sweep", because the two are
 * one decision and splitting them would double the maintenance for no signal.
 */
export function applyAllowlist(violations, entries) {
  const used = new Set();
  const remaining = violations.filter((v) => {
    const idx = entries.findIndex(
      (e) =>
        e.file === v.file &&
        e.rule === v.rule &&
        e.match.toLowerCase() === v.match.toLowerCase().trim(),
    );
    if (idx === -1) return true;
    used.add(idx);
    return false;
  });
  const stale = entries.filter((_, i) => !used.has(i));
  return { remaining, stale };
}

function report(remaining, stale) {
  const lines = [];
  if (remaining.length) {
    lines.push(`Copy lint: ${remaining.length} violation(s).`, "");
    for (const v of remaining) {
      lines.push(`${v.file}:${v.line}:${v.column}  [${v.rule}]  ${JSON.stringify(v.match)}`);
      lines.push(`  string  : ${JSON.stringify(v.text)}  (${v.context})`);
      lines.push(`  rule    : ${v.doc}`);
      if (v.hint) lines.push(`  write   : ${v.hint}`);
      if (v.regenerate)
        lines.push(
          "  density : one construction hit or two vocabulary hits in one string means " +
            "regenerating it from the section 7 templates, not sanding the word.",
        );
      lines.push("");
    }
  }
  if (stale.length) {
    lines.push(`Copy lint: ${stale.length} STALE allowlist entr(ies) — they match nothing now.`);
    lines.push("Delete them; a suppression that no longer suppresses is how a gate stops gating.");
    lines.push("");
    for (const e of stale) lines.push(`  ${e.file}  [${e.rule}]  ${JSON.stringify(e.match)}`);
    lines.push("");
  }
  return lines.join("\n");
}

function main() {
  const json = process.argv.includes("--json");
  const violations = findViolations();
  const { remaining, stale } = applyAllowlist(violations, loadAllowlist());

  if (json) {
    process.stdout.write(JSON.stringify({ remaining, stale }, null, 2));
    process.exit(remaining.length || stale.length ? 1 : 0);
  }

  if (!remaining.length && !stale.length) {
    process.stdout.write(
      `Copy lint: clean. ${violations.length} allowlisted hit(s), each with a stated reason.\n`,
    );
    return;
  }
  process.stderr.write(`${report(remaining, stale)}\n`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)))
  main();
