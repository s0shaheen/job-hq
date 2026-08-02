/**
 * The coverage gate: renders `docs/pilot-launch/evidence/ui-coverage.md` and
 * exits non-zero on a `missing` cell for a surface that has a route.
 *
 *   npm run coverage:ledger            # render and gate
 *   npm run coverage:ledger -- --check # gate without writing (CI can use either)
 *
 * The declarations and the gate itself are TypeScript under `tests/coverage/`
 * so that vitest can drive them; this file only loads them and writes the file.
 * Vite does the loading because it is already a devDependency, resolves the
 * extensionless imports the rest of the repo uses, and needs no new tool.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBAPP = resolve(HERE, "..");
const OUT = resolve(WEBAPP, "..", "docs/pilot-launch/evidence/ui-coverage.md");

const checkOnly = process.argv.includes("--check");

const server = await createServer({
  root: WEBAPP,
  configFile: false,
  logLevel: "error",
  server: { middlewareMode: true },
});

let report;
try {
  const { buildReport } = await server.ssrLoadModule("./tests/coverage/report.ts");
  report = buildReport({ generatedBy: "npm run coverage:ledger" });
} finally {
  await server.close();
}

if (!checkOnly) {
  mkdirSync(dirname(OUT), { recursive: true });
  const next = `${report.markdown}\n`;
  let previous = null;
  try {
    previous = readFileSync(OUT, "utf8");
  } catch {
    previous = null;
  }
  if (previous !== next) writeFileSync(OUT, next);
  process.stdout.write(`${previous === next ? "unchanged" : "wrote"} ${OUT}\n`);
}

const { covered, na, blocked, missingBaselined, missingNew, unbuilt } = report.counts;
process.stdout.write(
  `covered ${covered}  n/a ${na}  blocked ${blocked}  missing-baselined ${missingBaselined}  ` +
    `missing-new ${missingNew}  unbuilt ${unbuilt}\n`,
);

if (report.errors.length) {
  process.stderr.write(`\ncoverage ledger: ${report.errors.length} failure(s)\n`);
  for (const error of report.errors) process.stderr.write(`  - ${error}\n`);
  process.exit(1);
}
