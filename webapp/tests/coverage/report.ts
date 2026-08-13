/**
 * Evaluation and rendering for the coverage ledger.
 *
 * Everything the gate decides lives here rather than in the script, so the gate
 * itself is unit-testable: `tests/unit/coverage-ledger.test.ts` feeds it a
 * fixture ledger with a broken citation and a new missing cell and asserts it
 * goes red. A gate nobody has watched fail is a gate nobody should trust
 * (`17-ui-verification-standard.md` §10).
 */
import {
  loadAddenda,
  loadStates,
  loadSurfaces,
  cellKey,
  MODES,
  type Mode,
  type SurfaceSource,
} from "./sources";
import { CitationResolver, type Citation } from "./spec-titles";
import { RouteExtractor, routeMatches } from "./routes";
import { machineCheckedStates, proveState, undeclaredStates } from "./states";
import {
  BASELINE_MISSING,
  LEDGER,
  MISSING,
  type Baseline,
  type Cell,
  type SurfaceLedger,
  type Verdict,
} from "./ledger";

export interface Row {
  readonly surface: string;
  readonly state: string;
  readonly mode: Mode;
  readonly cell: Cell;
  /** A routed surface is enforced; an unrouted one is listed as unbuilt. */
  readonly routed: boolean;
  /** Only meaningful for `missing`: covered by a dated baseline entry. */
  readonly baselined: boolean;
}

export interface Counts {
  readonly covered: number;
  readonly na: number;
  readonly blocked: number;
  readonly missingBaselined: number;
  readonly missingNew: number;
  readonly unbuilt: number;
}

export interface Report {
  readonly rows: readonly Row[];
  readonly counts: Counts;
  readonly errors: readonly string[];
  readonly markdown: string;
}

export interface BuildOptions {
  readonly ledger?: Readonly<Record<string, SurfaceLedger>>;
  readonly baseline?: Baseline;
  readonly resolver?: CitationResolver;
  readonly extractor?: RouteExtractor;
  readonly surfaces?: readonly SurfaceSource[];
  readonly states?: readonly string[];
  readonly addenda?: ReadonlySet<string>;
  /** Stamped into the rendered file. Injectable so the test is deterministic. */
  readonly generatedBy?: string;
}

interface ParsedEntry {
  readonly surface: string;
  readonly state: string;
  readonly mode: string;
  readonly reason: string;
  readonly raw: string;
  used: boolean;
}

function parseBaseline(baseline: Baseline): ParsedEntry[] {
  return baseline.entries.map((e) => {
    const parts = e.key.split("|").map((p) => p.trim());
    if (parts.length !== 3) {
      throw new Error(`baseline key must be "surface | state | mode": ${e.key}`);
    }
    return { surface: parts[0], state: parts[1], mode: parts[2], reason: e.reason, raw: e.key, used: false };
  });
}

function matches(field: string, value: string): boolean {
  return field === "*" || field === value;
}

function cellFor(ledger: SurfaceLedger, state: string, mode: Mode): Cell {
  if (ledger.all) return ledger.all;
  if (mode === "fixture") return ledger.fixture?.[state] ?? MISSING;
  const declared = ledger.live?.[state];
  if (declared) return declared;
  // `n/a` and `blocked` are claims about the surface, not about the data
  // source: a state that cannot occur here cannot occur here in either mode,
  // and a missing design input is missing in both. `covered` never carries
  // over — that is the whole point of having a mode axis.
  const fixture = ledger.fixture?.[state];
  if (fixture && (fixture.verdict === "n/a" || fixture.verdict === "blocked")) return fixture;
  return MISSING;
}

/**
 * The route proof: a citation is rejected unless the cited test demonstrably
 * drives one of the surface's routes (`routes.ts` for why this is static, and
 * for what the alternatives would have missed).
 *
 * The resolver above proves a citation names a test that EXISTS. This proves
 * it has anything to do with the surface. Without it a cell on `/companies`
 * closed by a test that only ever loads `/queue` was a green gate over nothing,
 * and the only thing standing in its way was a person promising they had
 * checked.
 *
 * Returns the errors for one citation. Empty means proven.
 */
function proveRoute(
  where: string,
  state: string,
  cite: Citation,
  routes: readonly string[],
  extractor: RouteExtractor,
): string[] {
  const cited = `${cite.spec} "${cite.title}"`;
  const spec = extractor.spec(cite.spec);
  if (!spec) return []; // resolve() already reported the missing file.
  const nav = spec.navigations(cite.title);

  // The state half and the runs-at-all half apply whether or not the route
  // proof is waived: a hatch excuses an unreadable ROUTE, never a test that
  // does not enter the state and never a test that does not run.
  const errors: string[] = nav
    ? proveState(state, nav, spec.declaration(cite.title)).map(
        (p) => `${where}: cites ${cited}, and ${p.message}`,
      )
    : [];

  if (cite.drives !== undefined) {
    if (!routes.some((r) => routeMatches(cite.drives!, r))) {
      errors.push(
        `${where}: cites ${cited} with drives "${cite.drives}", which is not a route this surface owns (${routes.join(", ")}).`,
      );
    }
    if ((cite.why ?? "").trim().length < 30) {
      errors.push(`${where}: cites ${cited} with a route escape hatch and no usable reason.`);
    }
    // A hatch over a route the extractor CAN read is a suppression that stopped
    // suppressing — the same failure mode as a stale baseline entry.
    if (nav && nav.routes.some((r) => routes.some((s) => routeMatches(r, s)))) {
      errors.push(
        `${where}: cites ${cited} with a route escape hatch, but the test's navigation is readable and already lands on this surface (${nav.routes.join(", ")}). Delete the hatch.`,
      );
    }
    return errors;
  }

  if (!nav) {
    errors.push(`${where}: cites ${cited}, whose navigation could not be read at all.`);
    return errors;
  }
  if (nav.routes.some((r) => routes.some((s) => routeMatches(r, s)))) return errors;

  const drove = nav.routes.length ? nav.routes.join(", ") : "no route at all";
  const blind = nav.unresolved.length
    ? ` Navigation it could not read: ${nav.unresolved.map((u) => `${u.expression} (line ${u.line})`).join(", ")}.`
    : "";
  errors.push(
    `${where}: cites ${cited}, which never drives this surface. It drives ${drove}; this surface owns ${routes.join(", ")}.${blind}` +
      " Cite a test that renders this surface, or, if it reaches the route by a path the source cannot show, say so with `drives` and `why`.",
  );
  return errors;
}

const SYMBOL: Record<Verdict, string> = {
  covered: "yes",
  "n/a": "n/a",
  blocked: "add",
  missing: "gap",
};

/** The whole gate. Returns errors rather than throwing, so all of them show. */
export function buildReport(options: BuildOptions = {}): Report {
  const ledger = options.ledger ?? LEDGER;
  const baseline = options.baseline ?? BASELINE_MISSING;
  const resolver = options.resolver ?? new CitationResolver();
  const extractor = options.extractor ?? new RouteExtractor();
  const surfaces = options.surfaces ?? loadSurfaces();
  const states = options.states ?? loadStates();
  const addenda = options.addenda ?? new Set(loadAddenda().keys());

  const errors: string[] = [];
  const entries = parseBaseline(baseline);
  const stateSet = new Set(states);

  // A §5 state with no decision in `states.ts` would be exempt from the state
  // proof without anyone choosing that. Same rule as the ledger itself: a new
  // row upstream arrives red.
  for (const state of undeclaredStates(states)) {
    errors.push(
      `04-design-parity-standard.md section 5 declares state "${state}", which tests/coverage/states.ts does not. Say whether entering it requires a mechanism a test must call, or record it as null — a state cannot become exempt by being new.`,
    );
  }

  // Drift between the ledger and its sources is a failure, not a silent gap.
  for (const [surface, decl] of Object.entries(ledger)) {
    if (!surfaces.some((s) => s.surface === surface)) {
      errors.push(`ledger declares surface "${surface}", which the design source manifest does not list`);
    }
    // Route declarations are checked BEFORE they are used to prove anything.
    // Before this, `shared-shell-and-components` declared its route as the
    // prose "(app) layout, nav, toasts, dialogs, the pending-work banner" —
    // which is true, reads well, and matches no URL, so every route proof on
    // that surface would have failed for a reason that was not a defect. The
    // fix is not to skip those surfaces; it is to make "renders inside every
    // app route" a thing the ledger can SAY, and to make saying it cost a
    // written justification.
    for (const route of decl.routes) {
      if (route === "*") {
        if ((decl.routeProofNote ?? "").trim().length < 30) {
          errors.push(
            `ledger surface "${surface}" claims the every-route wildcard without a routeProofNote saying why it owns no route of its own`,
          );
        }
      } else if (!route.startsWith("/")) {
        errors.push(
          `ledger surface "${surface}" declares route "${route}", which is not a path. A route is what a browser can ask for; describe the rest in the surface note, and use "*" with a routeProofNote for a surface that renders inside every other one.`,
        );
      }
    }
    for (const table of [decl.fixture, decl.live]) {
      for (const state of Object.keys(table ?? {})) {
        if (!stateSet.has(state)) {
          errors.push(
            `ledger declares state "${state}" on "${surface}", which is not a row of 04-design-parity-standard.md section 5`,
          );
        }
      }
    }
  }
  for (const s of surfaces) {
    if (!(s.surface in ledger)) {
      errors.push(`the manifest lists surface "${s.surface}", which the ledger does not declare`);
    }
  }

  const rows: Row[] = [];
  for (const surface of surfaces) {
    const decl = ledger[surface.surface];
    if (!decl) continue;
    const routed = decl.routes.length > 0;
    for (const state of states) {
      for (const mode of MODES) {
        const cell = cellFor(decl, state, mode);
        const where = cellKey(surface.surface, state, mode);

        if (cell.verdict === "covered") {
          for (const cite of cell.cites) {
            const problem = resolver.resolve(cite);
            if (problem?.kind === "missing-spec") {
              errors.push(`${where}: cites ${cite.spec}, which does not exist`);
            } else if (problem?.kind === "missing-title") {
              const near = problem.near.length ? ` Nearest titles: ${problem.near.join(" / ")}` : "";
              errors.push(
                `${where}: cites ${cite.spec} "${cite.title}", which that spec does not declare.${near}`,
              );
            } else {
              // Resolving is the weaker half. This is the other one.
              errors.push(...proveRoute(where, state, cite, decl.routes, extractor));
            }
          }
        } else if (cell.verdict === "blocked") {
          if (!addenda.has(cell.add)) {
            errors.push(`${where}: blocked on "${cell.add}", which is not an ADD item in 07-decisions-assumptions-risks.md`);
          }
          if (cell.reason.trim().length < 20) {
            errors.push(`${where}: blocked without a usable reason`);
          }
        } else if (cell.verdict === "n/a") {
          if (cell.reason.trim().length < 20) {
            errors.push(`${where}: n/a without a usable reason`);
          }
        }

        let baselined = false;
        if (cell.verdict === "missing") {
          const hit = entries.find(
            (e) => matches(e.surface, surface.surface) && matches(e.state, state) && matches(e.mode, mode),
          );
          if (hit) {
            hit.used = true;
            baselined = true;
          } else if (routed) {
            errors.push(
              `${where}: missing, and outside the ${baseline.date} baseline. Cover it, declare why it cannot occur, or block it on a named ADD item.`,
            );
          }
        }

        rows.push({ surface: surface.surface, state, mode, cell, routed, baselined });
      }
    }
  }

  // A suppression that stopped matching is how a gate quietly stops gating.
  for (const e of entries) {
    if (!e.used) {
      errors.push(
        `baseline entry "${e.raw}" no longer matches a missing cell. Delete it: the list may only shrink.`,
      );
    }
  }

  const counts: Counts = {
    covered: rows.filter((r) => r.cell.verdict === "covered").length,
    na: rows.filter((r) => r.cell.verdict === "n/a").length,
    blocked: rows.filter((r) => r.cell.verdict === "blocked").length,
    missingBaselined: rows.filter((r) => r.cell.verdict === "missing" && r.baselined).length,
    missingNew: rows.filter((r) => r.cell.verdict === "missing" && !r.baselined && r.routed).length,
    unbuilt: rows.filter((r) => !r.routed).length,
  };

  return { rows, counts, errors, markdown: render(rows, counts, states, ledger, baseline, errors, options) };
}

function describe(cell: Cell): string {
  switch (cell.verdict) {
    case "covered":
      return cell.cites
        .map((c) =>
          c.drives
            ? `\`${c.spec}\` "${c.title}" — route proof waived to \`${c.drives}\`: ${c.why}`
            : `\`${c.spec}\` "${c.title}"`,
        )
        .join("; ");
    case "n/a":
      return cell.reason;
    case "blocked":
      return `${cell.add}: ${cell.reason}`;
    case "missing":
      return "";
  }
}

function render(
  rows: readonly Row[],
  counts: Counts,
  states: readonly string[],
  ledger: Readonly<Record<string, SurfaceLedger>>,
  baseline: Baseline,
  errors: readonly string[],
  options: BuildOptions,
): string {
  const surfaceNames = [...new Set(rows.map((r) => r.surface))];
  const by = new Map(rows.map((r) => [cellKey(r.surface, r.state, r.mode), r]));
  const out: string[] = [];

  out.push("# UI coverage ledger");
  out.push("");
  out.push(
    `Generated by \`${options.generatedBy ?? "npm run coverage:ledger"}\`. Do not hand-edit: the next run overwrites it, and a hand-written row is a coverage claim with nothing behind it.`,
  );
  out.push("");
  out.push(
    "The unit of verification is a cell: surface by state by mode (`17-ui-verification-standard.md` section 2). Surfaces come from `evidence/design-source-manifest.json`, states from `04-design-parity-standard.md` section 5, ADD items from `07-decisions-assumptions-risks.md`. Nothing in this file is retyped from those sources.",
  );
  out.push("");
  out.push("| Verdict | In the matrix | Meaning |");
  out.push("|---|---|---|");
  out.push(
    "| covered | `yes` | a named test exercises it: the citation resolves to a real title, that test is proven to drive one of this surface's routes, it runs rather than being quarantined, and where entering the state requires a specific call, it makes it |",
  );
  out.push("| n/a | `n/a` | the state cannot occur here, with a stated reason |");
  out.push("| blocked | `add` | the design input does not exist; names its ADD item |");
  out.push("| missing (baselined) | `gap` | a known, dated hole. Not covered. Does not fail today |");
  out.push("| missing (new) | `NEW` | outside the baseline. Fails the build |");
  out.push("");

  out.push("## Counts");
  out.push("");
  out.push("| | Cells |");
  out.push("|---|---:|");
  out.push(`| covered | ${counts.covered} |`);
  out.push(`| n/a | ${counts.na} |`);
  out.push(`| blocked on an ADD item | ${counts.blocked} |`);
  out.push(`| missing, baselined ${baseline.date} | ${counts.missingBaselined} |`);
  out.push(`| missing, new (fails) | ${counts.missingNew} |`);
  out.push(`| on an unbuilt surface (not enforced) | ${counts.unbuilt} |`);
  out.push(`| total | ${rows.length} |`);
  out.push("");
  out.push(
    `**Baselined is not covered.** ${counts.missingBaselined} cells below are unverified. The baseline exists so the gate could be switched on without a twelve-surface backfill first, and so that any new hole fails on the commit that opens it instead of joining an invisible pile. Removing an entry from \`BASELINE_MISSING\` is how a surface packet closes a gap.`,
  );
  out.push("");

  out.push("## Matrix, fixture mode");
  out.push("");
  out.push(`| Surface | ${states.join(" | ")} |`);
  out.push(`|---|${states.map(() => "---").join("|")}|`);
  for (const surface of surfaceNames) {
    const cells = states.map((state) => {
      const row = by.get(cellKey(surface, state, "fixture"));
      if (!row) return "";
      if (row.cell.verdict === "missing") {
        if (!row.routed) return "unbuilt";
        return row.baselined ? "gap" : "NEW";
      }
      return SYMBOL[row.cell.verdict];
    });
    out.push(`| ${surface} | ${cells.join(" | ")} |`);
  }
  out.push("");
  out.push(
    "Live mode is not shown as a matrix because it has one value everywhere. Every live cell is missing: the whole Playwright suite runs `HQ_DEMO=1` against `FixtureDataSource`, so no browser test has ever touched the real data path, real session handling, or RLS.",
  );
  out.push("");

  out.push("## What `covered` does not mean here");
  out.push("");
  out.push(
    "- No test in the estate renders non-Latin script, emoji, CJK or bidirectional text. Every long-string assertion is Latin-only, so `Long strings` means length, never script.",
  );
  out.push(
    "- The mobile Playwright project is a Pixel 7 viewport and nothing else. The repo issues zero tap, touchscreen or gesture calls, so no phone assertion anywhere covers touch input.",
  );
  out.push(
    "- `Permission/holding` means the pending and suspended entitlements, driven through the demo seam that the shipped predicate reads. WRONG-OWNER refusal is still uncovered in the browser: it needs two real identities and RLS, and the whole Playwright estate is one single-tenant fixture store. That half stays proven at the database layer only.",
  );
  out.push(
    "- The visual snapshot suite is not cited: a baseline is a picture, not an assertion a cell can name, and the PNGs under `tests/e2e/visual.spec.ts-snapshots` are their own evidence.",
  );
  out.push(
    `- A cell is checked on three things: the citation resolves, the cited test drives one of this surface's routes, and the cited test actually runs (a \`test.skip\`, \`test.fixme\` or \`test.fail\` cannot be cited — CI stays green over it). State ENTRY is checked only where the browser cannot reach the state without a specific call: ${machineCheckedStates().join(", ")}. For every other state, that the test entered it is a reviewer's judgement, recorded as \`null\` in \`tests/coverage/states.ts\` rather than left unsaid.`,
  );
  out.push(
    "- A cited test that is red is CI's job, not this gate's: the full Playwright suite runs on every PR and `land.sh` refuses on a red or pending check set. What this gate adds is the case CI cannot see — a cited test that never runs.",
  );
  out.push(
    "- The route proof (`tests/coverage/routes.ts`) is a necessary condition, not a sufficient one. It rejects a citation whose test never renders the surface at all — the class it was built for, and the class it found six of. It cannot tell whether the test looked at the right thing once it got there; only the reviewer and the assertion can.",
  );
  out.push("");

  out.push("## Per surface");
  out.push("");
  for (const surface of surfaceNames) {
    const decl = ledger[surface];
    out.push(`### ${surface}`);
    out.push("");
    out.push(decl.routes.length ? `Routes: ${decl.routes.map((r) => `\`${r}\``).join(", ")}` : "No route. Unbuilt: listed, never enforced.");
    out.push("");
    if (decl.note) {
      out.push(decl.note);
      out.push("");
    }
    out.push("| State | Fixture | Evidence or reason |");
    out.push("|---|---|---|");
    for (const state of states) {
      const row = by.get(cellKey(surface, state, "fixture"));
      if (!row) continue;
      let verdict: string;
      let detail: string;
      if (row.cell.verdict === "missing") {
        verdict = row.routed ? (row.baselined ? "gap" : "NEW") : "unbuilt";
        detail = row.baselined
          ? (baseline.entries.find((e) => {
              const [s, st, m] = e.key.split("|").map((p) => p.trim());
              return matches(s, surface) && matches(st, state) && matches(m, "fixture");
            })?.reason ?? "")
          : "";
      } else {
        verdict = SYMBOL[row.cell.verdict];
        detail = describe(row.cell);
      }
      out.push(`| ${state} | ${verdict} | ${detail} |`);
    }
    out.push("");
  }

  out.push(`## Baseline, ${baseline.date}`);
  out.push("");
  out.push("Each line is a hole that already existed when the gate was switched on. Baselined is not covered.");
  out.push("");
  out.push("| Cell | Found | Why it is missing |");
  out.push("|---|---|---|");
  for (const e of baseline.entries) {
    out.push(`| \`${e.key}\` | ${e.since ?? baseline.date} | ${e.reason} |`);
  }
  out.push("");

  if (errors.length) {
    out.push("## Failures");
    out.push("");
    for (const e of errors) out.push(`- ${e}`);
    out.push("");
  }

  return out.join("\n");
}
