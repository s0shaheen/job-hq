import { expect, test, type Page } from "@playwright/test";
import { collectSlop, describeSlop, type SlopOffender } from "./computed-slop";

/**
 * The anti-slop gate, dynamic half.
 *
 * The copy lint (`scripts/copy-lint/`) reads the SOURCE and catches a banned
 * word in a branch nothing happens to render. This reads the RENDERED PAGE and
 * catches what no source string can express: a text-transform inherited from a
 * parent, a gradient arriving through a third-party stylesheet, a radius that is
 * fine in the token file and 9999px after a `rounded-full`. Neither subsumes the
 * other; a violation that survives both is one nobody wrote down.
 *
 * Same harness and same conventions as `layout.spec.ts`: demo mode, walk the
 * DOM inside `page.evaluate`, fail with the offending element named. This one
 * additionally quotes the violated rule, because the design's instruction for a
 * rejected screen is "regenerate with the violated rule quoted" and a failure
 * reading "gradient found" makes that impossible.
 *
 * BOTH THEMES. Item 2 (violet) and item 4 (coloured shadows) are properties of
 * a palette, and this product ships two of them — a check that only ever looked
 * at light mode would be blind to half the tokens it is guarding.
 */

/**
 * Every route with real content. Deliberately the same shape as layout.spec's
 * list rather than a crawl: a static list is auditable, and matrix row 170's
 * lesson is that a sweep which cannot reach the screen it names is a sweep
 * credited with work it never did.
 */
const PAGES = [
  "/queue",
  "/jobs",
  "/jobs?set=all",
  "/pipeline",
  "/pipeline?open=Applied",
  "/companies",
  "/companies/add",
  "/connections",
  "/health",
  "/settings",
  "/settings/answers",
  "/apply/1",
  "/import",
];

/**
 * Subtrees the sweep does not own.
 *
 * Empty, and that is the intended steady state: the one legitimate kind of
 * entry is markup this app renders but does not author, and there is none. An
 * entry added here needs the same thing an allowlist entry in the copy lint
 * needs — a reason, in a comment, naming what will resolve it.
 */
const SKIP: string[] = [];

async function sweep(page: Page, path: string, theme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(path);
  await page.waitForLoadState("load");
  const offenders = (await page.evaluate(collectSlop, { skip: SKIP })) as SlopOffender[];
  expect(offenders, `${path} (${theme})\n${describeSlop(offenders)}`).toEqual([]);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`no generated-UI tells in the computed styles — ${theme}`, () => {
    for (const path of PAGES) {
      test(`${path}`, async ({ page }) => {
        await sweep(page, path, theme);
      });
    }
  });
}

/**
 * The overlay layer, opened.
 *
 * A dialog and a popover are the two places a shadow is legitimate and the two
 * places a radius, a gradient or an uppercase label most often hides, because
 * they render into a portal outside the page tree the sweep above walks while
 * they are closed. Opening them is the difference between checking the app and
 * checking its resting state.
 */
test("the export dialog carries no tells", async ({ page }) => {
  await page.goto("/queue");
  await expect(page.locator('[data-testid="export-open"][data-ready="true"]')).toBeAttached();
  await page.getByTestId("export-open").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const offenders = (await page.evaluate(collectSlop, { skip: SKIP })) as SlopOffender[];
  expect(offenders, describeSlop(offenders)).toEqual([]);
});

test("the source popover carries no tells", async ({ page }) => {
  await page.goto("/companies");
  await page.getByTestId("provenance-chip").first().click();
  await expect(page.getByTestId("provenance-popover")).toBeVisible();
  const offenders = (await page.evaluate(collectSlop, { skip: SKIP })) as SlopOffender[];
  expect(offenders, describeSlop(offenders)).toEqual([]);
});

/**
 * ═══ THE CHECK, CHECKED ═══════════════════════════════════════════════════════
 *
 * A sweep that returns an empty array is indistinguishable from a sweep that
 * never ran, a selector that matches nothing, or a rule whose regex was written
 * wrong — and all three report green. So every rule is fired at a fixture
 * element built to violate it, in the same browser, through the same
 * `page.evaluate` path the real sweep uses.
 *
 * The control halves matter as much as the violations: a rule that matched
 * everything would satisfy every positive assertion here, and only the negative
 * cases separate "the rule works" from "the rule is a wildcard".
 */
type Fixture = { name: string; rule: string; html: string; clean: string };

/**
 * The foundations document names these checklist items as the mechanically
 * enforced set. Keep this literal independent of the detector: if an item is
 * dropped from both the implementation and its fixtures, this assertion still
 * fails instead of blessing the smaller set.
 *
 * Item 0 is not a checklist number. It marks the rules that come from the OTHER
 * design source — the build conventions in `project/README.md` — so that
 * widening the gate can never be mistaken for the foundations' eleven having
 * grown, and so the eleven can still be asserted exactly.
 */
const REQUIRED_CHECKLIST_ITEMS: Readonly<Record<string, number>> = {
  gradient: 1,
  violet: 2,
  shadow: 4,
  italic: 7,
  titleCase: 8,
  uppercase: 9,
  tracking: 9,
  figures: 12,
  accentBorder: 16,
  radius: 19,
  opacity: 25,
  glue: 27,
  weight: 0,
  emDash: 0,
};

const FIXTURES: Fixture[] = [
  {
    name: "gradient",
    rule: "gradient",
    html: `<div style="background-image:linear-gradient(90deg,#fff,#000);width:40px;height:40px">x</div>`,
    clean: `<div style="background-color:#f6f6f4;width:40px;height:40px">x</div>`,
  },
  {
    name: "violet text",
    rule: "violet",
    html: `<p style="color:#7c3aed">Interested</p>`,
    clean: `<p style="color:#3f5f4b">Interested</p>`,
  },
  {
    name: "violet left border with no top border",
    rule: "violet",
    html: `<div style="border-left:1px solid #7c3aed;border-top:0;width:40px;height:40px">x</div>`,
    clean: `<div style="border-left:1px solid #e6e6e3;border-top:0;width:40px;height:40px">x</div>`,
  },
  {
    name: "violet SVG paint",
    rule: "violet",
    html: `<svg width="20" height="20" style="fill:#7c3aed;stroke:#7c3aed"><circle cx="10" cy="10" r="8"/></svg>`,
    clean: `<svg width="20" height="20" style="fill:#3f5f4b;stroke:#3f5f4b"><circle cx="10" cy="10" r="8"/></svg>`,
  },
  {
    name: "resting shadow",
    rule: "shadow",
    html: `<div style="box-shadow:0 1px 2px rgba(0,0,0,.2);width:40px;height:40px">x</div>`,
    clean: `<div style="border:1px solid #e6e6e3;width:40px;height:40px">x</div>`,
  },
  {
    name: "italics",
    rule: "italic",
    html: `<em>See all employees</em>`,
    clean: `<span>See all employees</span>`,
  },
  {
    name: "title-case button",
    rule: "titleCase",
    html: `<button>Save Changes</button>`,
    clean: `<button>Save changes</button>`,
  },
  {
    name: "title-case heading",
    rule: "titleCase",
    html: `<h2>Search Profile</h2>`,
    clean: `<h2>Search profile</h2>`,
  },
  {
    name: "title-case table header",
    rule: "titleCase",
    html: `<table><thead><tr><th>First Seen</th></tr></thead></table>`,
    clean: `<table><thead><tr><th>First seen</th></tr></thead></table>`,
  },
  {
    name: "uppercase transform",
    rule: "uppercase",
    html: `<p style="text-transform:uppercase">Account</p>`,
    clean: `<p>Account</p>`,
  },
  {
    name: "positive tracking",
    rule: "tracking",
    html: `<p style="letter-spacing:0.05em">Account</p>`,
    clean: `<p style="letter-spacing:0">Account</p>`,
  },
  {
    name: "numeric amount",
    rule: "figures",
    html: `<div role="gridcell" style="font-variant-numeric:normal">$185,000</div>`,
    clean: `<div role="gridcell" style="font-variant-numeric:tabular-nums">$185,000</div>`,
  },
  {
    name: "numeric date",
    rule: "figures",
    html: `<div role="gridcell" style="font-variant-numeric:normal">Jul 12, 2026</div>`,
    clean: `<div role="gridcell" style="font-variant-numeric:tabular-nums">Jul 12, 2026</div>`,
  },
  {
    name: "scoped count",
    rule: "figures",
    html: `<div role="gridcell" style="font-variant-numeric:normal">12 of 47 roles</div>`,
    clean: `<div role="gridcell" style="font-variant-numeric:tabular-nums">12 of 47 roles</div>`,
  },
  {
    name: "numeric range",
    rule: "figures",
    html: `<div role="gridcell" style="font-variant-numeric:normal">$120k–$150k</div>`,
    clean: `<div role="gridcell" style="font-variant-numeric:tabular-nums">$120k–$150k</div>`,
  },
  {
    name: "accent border",
    rule: "accentBorder",
    html: `<div style="border-left:3px solid #2f6b45;border-right:0;width:40px;height:40px">x</div>`,
    clean: `<div style="border:1px solid #e6e6e3;width:40px;height:40px">x</div>`,
  },
  {
    name: "pill radius",
    rule: "radius",
    html: `<div style="border-radius:9999px;width:80px;height:24px">Interested</div>`,
    clean: `<div style="border-radius:6px;width:80px;height:24px">Interested</div>`,
  },
  {
    name: "direct text opacity",
    rule: "opacity",
    html: `<p style="opacity:.6">Not listed</p>`,
    clean: `<p style="color:#707067">Not listed</p>`,
  },
  {
    name: "ancestor opacity affecting text",
    rule: "opacity",
    html: `<div style="opacity:.6"><span>Not listed</span></div>`,
    clean: `<div><span style="color:#707067">Not listed</span></div>`,
  },
  {
    name: "glue glyph",
    rule: "glue",
    html: `<p>Ramp · Product Manager</p>`,
    clean: `<p>Ramp, Product Manager</p>`,
  },
  {
    name: "digit outside a table cell",
    rule: "figures",
    html: `<button style="font-variant-numeric:normal">Export 47 roles</button>`,
    clean: `<button style="font-variant-numeric:tabular-nums">Export 47 roles</button>`,
  },
  {
    name: "bold-700 text",
    rule: "weight",
    html: `<p style="font-weight:700">Interested</p>`,
    clean: `<p style="font-weight:600">Interested</p>`,
  },
  {
    name: "em dash in rendered text",
    rule: "emDash",
    html: `<p>Applied — no reply yet</p>`,
    clean: `<p>Applied, no reply yet</p>`,
  },
  {
    // The en dash is the rule's stated exception ("En dash only inside numeric
    // ranges"), so it must NOT trip emDash — otherwise every salary band on the
    // jobs grid becomes a violation and the rule gets allowlisted into silence.
    name: "en dash range is not an em dash",
    rule: "figures",
    html: `<span style="font-variant-numeric:normal">$120k–$150k</span>`,
    clean: `<span style="font-variant-numeric:tabular-nums">$120k–$150k</span>`,
  },
];

test("fixtures cover every required mechanically checked checklist item", () => {
  const fromChecklist = [
    ...new Set(
      FIXTURES.map((fixture) => REQUIRED_CHECKLIST_ITEMS[fixture.rule]).filter((n) => n !== 0),
    ),
  ].sort((a, b) => a - b);
  expect(fromChecklist).toEqual([1, 2, 4, 7, 8, 9, 12, 16, 19, 25, 27]);
  expect(Object.keys(REQUIRED_CHECKLIST_ITEMS).sort()).toEqual(
    [...new Set(FIXTURES.map((fixture) => fixture.rule))].sort(),
  );
});

test("the en dash in a numeric range is left alone", async ({ page }) => {
  await page.goto("/queue");
  const offenders = (await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "slop-fixture";
    host.innerHTML = `<p style="font-variant-numeric:tabular-nums">$120k–$150k</p>`;
    document.body.appendChild(host);
    // @ts-expect-error injected in beforeEach
    const out = window.__collectSlop({ skip: [], root: "#slop-fixture" });
    host.remove();
    return out;
  })) as SlopOffender[];

  expect(offenders.map((o) => o.rule)).not.toContain("emDash");
});

test.describe("every rule in the sweep can fail", () => {
  for (const f of FIXTURES) {
    test(f.name, async ({ page }) => {
      // The fixture is scoped away from the surface behind it: this is testing
      // the detector, and a page regression must not masquerade as a detector
      // failure.
      await page.goto("/queue");
      const dirty = (await page.evaluate(
        ({ html, opts }) => {
          const host = document.createElement("div");
          host.id = "slop-fixture";
          host.innerHTML = html;
          document.body.appendChild(host);
          // @ts-expect-error injected below
          const out = window.__collectSlop(opts);
          host.remove();
          return out;
        },
        { html: f.html, opts: { skip: SKIP, root: "#slop-fixture" } },
      )) as SlopOffender[];

      expect(
        dirty.map((o) => o.rule),
        `fixture "${f.name}" for "${f.rule}" did not trip it: ${f.html}`,
      ).toContain(f.rule);
      expect(dirty.find((o) => o.rule === f.rule)?.item).toBe(
        REQUIRED_CHECKLIST_ITEMS[f.rule],
      );

      // And the fixed version must be silent — otherwise the rule is a wildcard
      // and its "can fail" proof above proves nothing.
      const clean = (await page.evaluate(
        ({ html, opts }) => {
          const host = document.createElement("div");
          host.id = "slop-fixture";
          host.innerHTML = html;
          document.body.appendChild(host);
          // @ts-expect-error injected below
          const out = window.__collectSlop(opts);
          host.remove();
          return out;
        },
        { html: f.clean, opts: { skip: SKIP, root: "#slop-fixture" } },
      )) as SlopOffender[];

      expect(
        clean.map((o) => o.rule),
        `the fix for fixture "${f.name}" still trips "${f.rule}": ${f.clean}`,
      ).not.toContain(f.rule);
    });
  }
});

test("the root element itself is included in the walk", async ({ page }) => {
  await page.goto("/queue");
  const offenders = (await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "slop-root-fixture";
    host.style.backgroundImage = "linear-gradient(90deg, #fff, #000)";
    host.textContent = "x";
    document.body.appendChild(host);
    // @ts-expect-error injected in beforeEach
    const out = window.__collectSlop({ skip: [], root: "#slop-root-fixture" });
    host.remove();
    return out;
  })) as SlopOffender[];

  expect(offenders.map((o) => o.rule)).toContain("gradient");
});

test("the failure message names the element and quotes the rule", async ({ page }) => {
  await page.goto("/queue");
  const offenders = (await page.evaluate(
    ({ opts }) => {
      const host = document.createElement("div");
      host.id = "slop-fixture";
      host.setAttribute("data-testid", "slop-probe");
      host.innerHTML = `<p style="text-transform:uppercase">Account</p>`;
      document.body.appendChild(host);
      // @ts-expect-error injected below
      const out = window.__collectSlop(opts);
      host.remove();
      return out;
    },
    { opts: { skip: SKIP, root: "#slop-fixture" } },
  )) as SlopOffender[];

  const message = describeSlop(offenders);
  // The three things a fix needs: where, what, and which rule.
  expect(message).toContain('data-testid="slop-probe"');
  expect(message).toContain("text-transform: uppercase");
  expect(message).toContain("No exemptions.");
  expect(offenders[0].item).toBe(9);
});

test("the skip list suppresses only its own subtree", async ({ page }) => {
  await page.goto("/queue");
  const [withSkip, without] = (await page.evaluate(() => {
    const scope = document.createElement("div");
    scope.id = "slop-scope";
    document.body.appendChild(scope);
    const host = document.createElement("div");
    host.id = "vendor-widget";
    host.innerHTML = `<p style="text-transform:uppercase">Account</p>`;
    scope.appendChild(host);
    const sibling = document.createElement("p");
    sibling.id = "ours";
    sibling.style.textTransform = "uppercase";
    sibling.textContent = "Account";
    scope.appendChild(sibling);
    // @ts-expect-error injected below
    const a = window.__collectSlop({ skip: ["#vendor-widget"], root: "#slop-scope" });
    // @ts-expect-error injected below
    const b = window.__collectSlop({ skip: [], root: "#slop-scope" });
    scope.remove();
    return [a, b];
  })) as [SlopOffender[], SlopOffender[]];

  // Skipping the vendor subtree must NOT skip our own sibling: a skip that
  // silences the page is a gate that is off.
  expect(withSkip.filter((o) => o.rule === "uppercase")).toHaveLength(1);
  expect(without.filter((o) => o.rule === "uppercase")).toHaveLength(2);
});

/**
 * `collectSlop` is a module function, and the fixture tests above need to call
 * it from inside a browser callback that cannot close over an import. Exposing
 * it on `window` once per page is how they get it, and it is the SAME function
 * object the real sweep serialises — if it were a copy, the self-test would be
 * proving a different detector than the one that guards the build.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(`window.__collectSlop = ${collectSlop.toString()};`);
});
