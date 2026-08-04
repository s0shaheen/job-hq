/**
 * Citation resolution. A `covered` cell names a spec file and an exact test
 * title; this module is what makes that claim checkable. Renaming a test must
 * not silently uncover a state, so an unresolvable citation is a hard failure
 * rather than a stale row (`17-ui-verification-standard.md` §3).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WEBAPP_ROOT } from "./sources";

export interface SpecTitle {
  readonly title: string;
  readonly kind: "test" | "describe";
  readonly line: number;
}

/**
 * Matches `test("…"`, `test.describe(\`…\``, `test.skip('…'`, allowing a line
 * break between the call and its title. Only literal titles are collected: a
 * computed title (`test(scheme, …)`) cannot be cited, which is correct — a
 * citation has to name something a human can find.
 */
const CALL = new RegExp(
  String.raw`\btest(\.describe|\.skip|\.fixme|\.only|\.describe\.serial|\.describe\.parallel)?\s*\(\s*` +
    String.raw`(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|` +
    "`([^`$\\\\\\n]*)`)",
  "g",
);

function unescape(raw: string): string {
  return raw.replace(/\\(["'`\\])/g, "$1");
}

/** Every literal title declared in one spec file. */
export function parseSpecTitles(source: string): SpecTitle[] {
  const out: SpecTitle[] = [];
  CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL.exec(source)) !== null) {
    const raw = m[2] ?? m[3] ?? m[4];
    if (raw === undefined) continue;
    const suffix = m[1] ?? "";
    out.push({
      title: unescape(raw),
      kind: suffix.startsWith(".describe") ? "describe" : "test",
      line: source.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

export interface Citation {
  /** Repo-relative-to-webapp path, e.g. `tests/e2e/triage.spec.ts`. */
  readonly spec: string;
  /** Exact title as written in the spec. */
  readonly title: string;
  /**
   * The ONE escape hatch in the route proof (`routes.ts`), for a test that
   * genuinely renders the surface by a path no reader of the source can
   * follow — a client-side navigation through a clicked link, an id minted at
   * runtime. It names the route the test actually reaches and `why` says how,
   * in writing, in the diff, and in the rendered evidence file.
   *
   * It is not a way to quiet the gate. `drives` must be one of the surface's
   * own routes, `why` must be a real sentence, and a hatch on a citation the
   * extractor CAN read is itself a failure — like the baseline, this list may
   * only shrink.
   */
  readonly drives?: string;
  readonly why?: string;
}

export type CitationProblem =
  | { kind: "missing-spec"; spec: string }
  | { kind: "missing-title"; spec: string; title: string; near: string[] };

/** Resolves citations against the real spec files. Cached per file per run. */
export class CitationResolver {
  private cache = new Map<string, SpecTitle[] | null>();

  constructor(private readonly root: string = WEBAPP_ROOT) {}

  titles(spec: string): SpecTitle[] | null {
    if (!this.cache.has(spec)) {
      const path = resolve(this.root, spec);
      this.cache.set(
        spec,
        existsSync(path) ? parseSpecTitles(readFileSync(path, "utf8")) : null,
      );
    }
    return this.cache.get(spec) ?? null;
  }

  resolve(citation: Citation): CitationProblem | null {
    const titles = this.titles(citation.spec);
    if (titles === null) return { kind: "missing-spec", spec: citation.spec };
    if (titles.some((t) => t.title === citation.title)) return null;
    // A near list turns "citation broken" into "you renamed it to this".
    const wanted = citation.title.toLowerCase();
    const near = titles
      .filter((t) => {
        const got = t.title.toLowerCase();
        return got.includes(wanted.slice(0, 20)) || wanted.includes(got.slice(0, 20));
      })
      .map((t) => t.title)
      .slice(0, 3);
    return { kind: "missing-title", spec: citation.spec, title: citation.title, near };
  }
}
