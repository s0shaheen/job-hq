import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The `@theme` split, and the per-view scale's opt-out — pinned as structure.
 *
 * THIS FILE EXISTS BECAUSE THE MECHANIC IS INVISIBLE. Two blocks in
 * `globals.css` look interchangeable and are not:
 *
 *   `@theme inline { --color-x: var(--x) }`  substitutes the VALUE into every
 *   utility at build time, which is what makes `.dark` reach `bg-surface`;
 *
 *   `@theme        { --text-sm: … }`         emits `font-size: var(--text-sm)`,
 *   which is the ONLY reason a runtime override of the type scale reaches
 *   anything at all.
 *
 * Swap them and nothing errors. Colours quietly stop flipping in dark mode, or
 * — the failure that actually happened — the large-type override has nothing to
 * override, because no utility references the token: the body font grew and
 * every `text-*` utility stayed put, so a status pill grew its text and not its
 * box. Design doc 07 §2 names this as the one repo mechanic that must carry
 * into every handoff, "or the large-type mechanism regresses".
 *
 * Nothing else can see it. Tailwind compiles without complaint either way, the
 * token tests set `.dark` by hand, and the runtime proofs are on two specific
 * surfaces (`pipeline.spec.ts` measures the pill's computed font-size growing;
 * `grid-polish.spec.ts` proves the grid's subtree opts out) — both of which
 * would be deleted along with the surface they belong to. This is the check
 * that survives a rewrite of every component.
 */

const CSS = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

/** The body of the block whose header STARTS at `header`, brace-balanced. */
function blockAfter(header: string): string {
  const at = CSS.indexOf(header);
  if (at === -1) throw new Error(`no \`${header}\` block in globals.css — did it move?`);
  const open = CSS.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}") {
      depth--;
      if (depth === 0) return CSS.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated block at ${header}`);
}

/** Custom-property names DECLARED in a block (`--x: …`), comments excluded. */
function declared(body: string): string[] {
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]).sort();
}

// `@theme inline` first, so `indexOf("@theme")` cannot match it by accident when
// the plain block is asked for: the plain one is found by its own exact header.
const INLINE = blockAfter("@theme inline {");
const PLAIN = blockAfter("@theme {");
const LARGE = blockAfter(':root[data-type-scale="large"] {');
const SCOPED = blockAfter(':root[data-type-scale="large"] [data-type-scale-scope="own"] {');

describe("the @theme split", () => {
  it("the parser found four distinct blocks", () => {
    // Non-vacuity. A brace matcher that returned the whole file would make every
    // assertion below pass on any input at all.
    for (const [name, body] of Object.entries({ INLINE, PLAIN, LARGE, SCOPED })) {
      expect(declared(body).length, `${name} parsed as empty`).toBeGreaterThan(5);
    }
    expect(PLAIN).not.toEqual(INLINE);
    expect(PLAIN.length).toBeLessThan(CSS.length / 2);
  });

  it("type tokens live in the PLAIN @theme, never in @theme inline", () => {
    // MUTATION REASON: move one `--text-*` line into the `@theme inline` block
    // and the app still builds, still looks identical at the default scale, and
    // silently stops growing that one step under large type.
    expect(declared(PLAIN).filter((t) => t.startsWith("--text-")).length).toBeGreaterThan(6);
    expect(declared(INLINE).filter((t) => t.startsWith("--text-"))).toEqual([]);
  });

  it("colour tokens live in @theme inline, never in the plain @theme", () => {
    // The other direction, and its failure is just as quiet: a `--color-*`
    // moved out of `inline` compiles to a literal, and `.dark` overriding the
    // underlying `--surface` reaches nothing.
    expect(declared(INLINE).filter((t) => t.startsWith("--color-")).length).toBeGreaterThan(10);
    expect(declared(PLAIN).filter((t) => t.startsWith("--color-"))).toEqual([]);
  });

  it("the colour tokens are var() references, which is what `inline` collapses", () => {
    // `--color-surface: #fff` inside `@theme inline` would satisfy the case
    // above and still break dark mode: there would be no indirection left for
    // `.dark` to redefine.
    const literals = INLINE.split("\n").filter((l) => /^\s*--color-[\w-]+\s*:\s*#/.test(l));
    expect(literals, `colour tokens hard-coded instead of var(): ${literals}`).toEqual([]);
  });
});

describe("the large-type override", () => {
  it("overrides exactly the tokens the base scale declares", () => {
    // A token declared in the base and missing from the override is a step of
    // the scale that does not grow — which is the compounding-adjacent failure
    // where one element grows and its neighbour does not.
    expect(declared(LARGE)).toEqual(declared(PLAIN));
  });

  it("moves line heights with the sizes", () => {
    // Scaling font-size alone is how large type turns a comfortable list into
    // overlapping rows. Paired by construction: every `--text-x` has an
    // `--text-x--line-height` beside it.
    for (const token of declared(PLAIN).filter((t) => !t.endsWith("--line-height"))) {
      expect(declared(LARGE)).toContain(`${token}--line-height`);
    }
  });
});

describe("the per-view opt-out", () => {
  it("re-declares every token, so no branch inherits the outer scale", () => {
    // The whole mechanism: custom properties INHERIT, so a token the subtree
    // does not restate keeps the large value. `/jobs` scales its own type and
    // widens its columns by the same ratio (`colScale`); a token that leaked in
    // would grow the text a second time while the widths knew nothing about it,
    // which is how 15 of 19 comp cells clipped.
    //
    // MUTATION REASON: delete one line from the scoped block and this names it.
    expect(declared(SCOPED)).toEqual(declared(PLAIN));
  });

  it("restores the DEFAULT values, not some third scale", () => {
    // Same names would pass above while the subtree rendered at a size nothing
    // else in the app uses. Compared as text, whitespace-normalised.
    const norm = (s: string) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .sort()
        .join("\n");
    expect(norm(SCOPED)).toEqual(norm(PLAIN));
  });

  it("the attribute is actually used by a component", () => {
    // A selector nothing sets is a dead guard that reads as protection. The
    // grid is the subtree that manages its own scale; if it ever stops opting
    // out, this fails here rather than in a screenshot of clipped comp cells.
    const grid = readFileSync(
      join(process.cwd(), "app", "(app)", "jobs", "jobs-grid.tsx"),
      "utf8",
    );
    expect(grid).toContain('data-type-scale-scope="own"');
  });
});

describe("the scale is driven by an attribute on the root", () => {
  it("keys off `data-type-scale` and `data-density`, which the server renders", () => {
    // E5 moved the SOURCE of these attributes from a cookie read by a client
    // script to `profiles`, rendered onto `<html>` by the root layout. The
    // selectors are the contract between the two halves: rename one here and
    // the server would render an attribute no rule matches, with nothing
    // failing and the app simply ignoring somebody's eyesight.
    expect(CSS).toContain(':root[data-type-scale="large"]');
    expect(CSS).toContain(':root[data-density="comfortable"] .hq-row');

    const layout = readFileSync(join(process.cwd(), "app", "layout.tsx"), "utf8");
    expect(layout).toContain("data-type-scale=");
    expect(layout).toContain("data-density=");
    // And the retired channel is really gone: a script still reading the cookie
    // would be a second writer of the same attributes, which is the fork E5
    // exists to close.
    expect(layout).not.toContain("hq_display=");
  });

  it("dark mode is class-driven, so a stored choice can beat the OS", () => {
    // `data-type-scale` is an ATTRIBUTE and `.dark` is a CLASS on purpose: they
    // compose on the same element without either having to know about the other.
    expect(CSS).toContain("@custom-variant dark (&:where(.dark, .dark *))");
  });
});
