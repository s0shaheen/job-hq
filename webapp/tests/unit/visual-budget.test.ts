import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The visual suite's diff budget is ABSOLUTE. Pinned here because the failure
 * it prevents is silent in both directions.
 *
 * WHAT WENT WRONG (issue #248). The budget was `maxDiffPixelRatio: 0.02`, and a
 * ratio scales with the CANVAS rather than with what is drawn on it. On a sparse
 * page the canvas is mostly background, so the budget grows with the empty part:
 * on `/settings/preferences` — 1280x900, roughly 19,600 pixels of drawn detail —
 * 2% of the canvas was 23,040 pixels, more than the page draws in total. #247
 * deleted the Theme select from that page and the check passed against baselines
 * that still contained it. Reproducing it by deleting the Type size select
 * instead measured the miss: 3,095 differing pixels, green.
 *
 * WHY A TEST AND NOT JUST THE COMMENT IN `playwright.config.ts`. Nothing about
 * a loose budget is visible. A ratio put back — in the config, or as a per-test
 * option, which is how the queue's absolute budget had to neutralise the old
 * project default — makes no run red, prints no warning, and changes no
 * baseline. It just quietly stops catching things, exactly as it did for two
 * PRs. This is the check that notices, and it is deliberately about the UNIT
 * rather than the number: raising or lowering `maxDiffPixels` is somebody's
 * judgement call and passes here; going back to a proportion of the canvas is
 * the defect and does not.
 */

const ROOT = process.cwd();

/**
 * Source lines with comments dropped, so a line that DISCUSSES the old ratio —
 * both files now carry paragraphs that do — is never mistaken for one that
 * declares it. Both files comment in JSDoc or `//` and nothing else, so
 * "starts with `*`, `//` or `/*`" is exact for them rather than a general
 * TypeScript comment stripper.
 */
function code(relative: string): string[] {
  return readFileSync(join(ROOT, relative), "utf8")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t !== "" && !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    });
}

const CONFIG = code("playwright.config.ts");
const SPEC = code("tests/e2e/visual.spec.ts");

describe("the visual diff budget", () => {
  it("is declared in playwright.config.ts as an absolute pixel count", () => {
    const declaration = CONFIG.filter((l) => l.includes("toHaveScreenshot"));
    expect(declaration, "no toHaveScreenshot budget in playwright.config.ts").toHaveLength(1);

    const budget = /maxDiffPixels:\s*(\d+)/.exec(declaration[0]);
    expect(
      budget,
      `the visual budget must be an absolute maxDiffPixels count, got: ${declaration[0]}`,
    ).not.toBeNull();
    expect(Number(budget![1])).toBeGreaterThan(0);
  });

  it("is not a ratio, in the config or as a per-shot override", () => {
    // `maxDiffPixelRatio` anywhere in the visual lane reopens #248: in the
    // config it is the original defect, and on a single `toHaveScreenshot`
    // call it re-exempts that one surface from the absolute budget — which is
    // how /queue had to opt out of the old default, and is the shape a future
    // "just this once" would take.
    const offenders = [...CONFIG, ...SPEC].filter((l) => l.includes("maxDiffPixelRatio"));
    expect(
      offenders,
      "a ratio budget scales with the empty background, not with what the page draws (#248)",
    ).toEqual([]);
  });

  it("is the same budget for every shot — no surface sets its own", () => {
    // The queue used to, and its 600 became the default precisely so that the
    // sparse surfaces stopped being the exception. A per-shot number is not
    // forbidden forever, but it has to be a decision somebody makes on purpose
    // rather than one that survives from a state this change removed.
    const overrides = SPEC.filter((l) => l.includes("maxDiffPixels"));
    expect(
      overrides,
      "visual.spec.ts sets its own pixel budget; the suite's budget is the config's",
    ).toEqual([]);
  });
});

/**
 * The SECOND tolerance (issue #280), and the reason it needs its own test is
 * that it failed silently for longer than the budget did: it was never written
 * down at all, so it was Playwright's default.
 *
 * `maxDiffPixels` says how many differing pixels are allowed. `threshold` says
 * whether a pixel counts as differing in the first place, and no budget can
 * catch a pixel the comparator already scored as identical. At the default of
 * 0.2 a whole surface could change its background token and this suite reported
 * zero: measured on `/connections` in #278 (188,981 pixels, 0 counted) and
 * reproduced across 22 of the 28 baselines at once on this branch (2,401,547
 * pixels changed shade, `29 passed`).
 *
 * These assertions are about the DEFECT, not about the number. They are
 * computed from pixelmatch's own scoring function — the one Playwright's image
 * comparator calls — so they say "the threshold must be able to see the change
 * #280 is about, and must not be able to see the rasteriser rounding" rather
 * than "the threshold must be 0.01". Any value in the measured corridor passes;
 * 0.2, and 0, do not.
 */

/**
 * pixelmatch scores a pixel pair by weighted YIQ distance and ignores anything
 * at or under `35215 * threshold^2`. Both halves are reproduced here because a
 * test that re-imported them from Playwright's bundle would pass whatever the
 * bundle did, including the default this test exists to forbid.
 */
const RGB2Y = [0.29889531, 0.58662247, 0.11448223];
const RGB2I = [0.59597799, -0.2741761, -0.32180189];
const RGB2Q = [0.21147017, -0.52261711, 0.31114694];

function yiqDelta(a: string, b: string): number {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [p, q] = [rgb(a), rgb(b)];
  const axis = (w: number[]) => w[0] * (p[0] - q[0]) + w[1] * (p[1] - q[1]) + w[2] * (p[2] - q[2]);
  const [y, i, qq] = [axis(RGB2Y), axis(RGB2I), axis(RGB2Q)];
  return 0.5053 * y * y + 0.299 * i * i + 0.1957 * qq * qq;
}

/** The largest YIQ distance the declared threshold scores as "identical". */
function ceilingFor(threshold: number): number {
  return 35215 * threshold * threshold;
}

describe("the visual per-pixel threshold", () => {
  const declaration = CONFIG.filter((l) => l.includes("toHaveScreenshot"));
  const declared = /threshold:\s*([0-9.]+)/.exec(declaration[0] ?? "");
  // NaN when it is absent, so the two corridor assertions below report their own
  // message instead of throwing on a null match. An undeclared threshold is the
  // 0.2 default in force, which is the defect, and every one of these fails.
  const threshold = Number(declared?.[1] ?? NaN);

  it("is declared in playwright.config.ts, never left to Playwright's default", () => {
    expect(declaration, "no toHaveScreenshot options in playwright.config.ts").toHaveLength(1);
    expect(
      declared,
      `the per-pixel threshold must be stated, not inherited (#280). Got: ${declaration[0]}`,
    ).not.toBeNull();
  });

  it("is low enough to see a whole-surface tint — the #280 defect", () => {
    // The exact change #278 measured and handed back: the nav rail's background
    // token. 188,981 pixels went this far and the suite counted none of them.
    const tint = yiqDelta("#ffffff", "#f6f6f4");
    expect(
      ceilingFor(threshold),
      `a background token can move #ffffff->#f6f6f4 (YIQ ${tint.toFixed(2)}) under this ` +
        `threshold and no pixel will count. That is #280, and at Playwright's default of ` +
        `0.2 the first shade change counted is 53 units — the estate could go #ffffff to ` +
        `#cccccc unnoticed.`,
    ).toBeLessThan(tint);
  });

  it("is high enough to absorb a rasteriser that rounds differently", () => {
    // The other direction, and it is the one that would make this suite flake
    // rather than lie. MEASURED in the pinned container: two full runs of
    // identical code differ on 61 pixels by up to 2 units on one channel, and a
    // synthetic +-2 on every channel of every pixel (28.2M) counts 28,168,673
    // at threshold 0.005 and 0 at 0.01. So the floor is not a preference:
    // threshold 0 turns the whole estate red the first time a font stack or a
    // GPU rounds one unit differently.
    const wobble = yiqDelta("#ffffff", "#fdfdfd");
    expect(
      ceilingFor(threshold),
      `a 2-unit rounding difference (YIQ ${wobble.toFixed(2)}) would count as a real ` +
        `difference at this threshold. That is the measured rendering floor of the pinned ` +
        `container, so this is a flake, not a regression.`,
    ).toBeGreaterThan(wobble);
  });

  it("is the same threshold for every shot — no surface sets its own", () => {
    // The budget's rule, for the same reason: a per-shot `threshold` re-exempts
    // one surface from the corridor above, and "just this once" is how the
    // queue's absolute budget had to exist as a special case for two PRs.
    const overrides = SPEC.filter((l) => l.includes("threshold"));
    expect(
      overrides,
      "visual.spec.ts sets its own per-pixel threshold; the suite's threshold is the config's",
    ).toEqual([]);
  });
});
