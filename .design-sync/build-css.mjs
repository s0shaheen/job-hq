// Compile the webapp's Tailwind v4 stylesheet into a single static file the
// design-sync converter can ship as `cfg.cssEntry`.
//
// WHY THIS EXISTS
// The webapp has no compiled CSS artifact: Tailwind v4 runs inside Next's
// PostCSS pipeline, so the utility classes every component references only
// exist inside `.next/`. Pointing `cfg.cssEntry` at `app/globals.css` would
// ship the tokens and none of the utilities — components would render
// unstyled, which is the exact failure the rubric's "Styled" gate catches.
//
// WHAT IT DOES
//   1. reads `webapp/app/globals.css` verbatim (tokens stay single-sourced —
//      nothing is duplicated into this repo's sync config),
//   2. rewrites its first line to `@import "tailwindcss" source(none);` and
//      adds explicit `@source` globs, so detection is deterministic instead of
//      "walk the git root and guess",
//   3. runs it through the webapp's OWN pinned `@tailwindcss/postcss` (4.3.3),
//      so the output is byte-comparable to what Next serves,
//   4. writes `webapp/.ds-styles.css` — gitignored, regenerated every sync.
//
// Run from the repo root:  node .design-sync/build-css.mjs

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEBAPP = join(REPO, 'webapp');
const GLOBALS = join(WEBAPP, 'app', 'globals.css');
const OUT = join(WEBAPP, '.ds-styles.css');

// Resolve postcss + the tailwind plugin from the WEBAPP's node_modules, not
// this script's — the pinned 4.3.3 pair is what the app itself builds with.
const req = createRequire(join(WEBAPP, 'package.json'));
const postcss = req('postcss');
const tailwind = req('@tailwindcss/postcss');

const src = readFileSync(GLOBALS, 'utf8');
if (!/^@import ["']tailwindcss["'];/m.test(src)) {
  console.error('! globals.css no longer starts with `@import "tailwindcss";` — update build-css.mjs');
  process.exit(1);
}

// `source(none)` turns OFF automatic detection (which would walk the whole git
// repo from globals.css — python, snapshots, resume YAML, the lot). The globs
// below are relative to globals.css's own directory (webapp/app) and cover a
// superset of the components in `componentSrcMap`: a class that is scanned but
// unused costs bytes, a class that is missed renders broken.
const input = src.replace(
  /^@import ["']tailwindcss["'];/m,
  [
    '@import "tailwindcss" source(none);',
    '@source "./**/*.tsx";',
    '@source "../components/**/*.tsx";',
    '@source "../lib/**/*.tsx";',
  ].join('\n'),
);

const result = await postcss([tailwind()]).process(input, { from: GLOBALS, to: OUT });
writeFileSync(OUT, result.css);
console.error(`css: ${OUT} (${(Buffer.byteLength(result.css) / 1024).toFixed(0)} KB)`);
