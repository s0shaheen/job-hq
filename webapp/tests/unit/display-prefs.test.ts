/**
 * Display preferences: the parser, and the fake's parity with migration 0025.
 *
 * The store moved off the `hq_display` cookie and `saved_views.state` onto
 * `profiles` (E5, doc 07 §4). Two things can go wrong silently after a move
 * like that, and both get cases here:
 *
 *   1. the parser stops surviving a value it does not know, so a preference
 *      written by a later version of the app crashes this one;
 *   2. the FAKE drifts from the SQL, at which point every vitest case and every
 *      e2e journey is green against semantics production does not have. The
 *      fake is what the demo and the whole browser suite run on, so its
 *      no-op/partial/conflict/replay behaviour is asserted clause by clause
 *      against what `tests/db/test_display_prefs.py` proves of the function.
 */
import { describe, expect, it } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import { toDisplayPrefsView } from "@/lib/data/supabase-source";
import {
  DEFAULT_DISPLAY_PREFS,
  DENSITIES,
  LANDING_VIEW_MAX,
  THEMES,
  TYPE_SCALES,
  displayAttributes,
  displayPrefsEqual,
  parseDisplayPrefs,
} from "@/lib/display/prefs";
import { DEFAULT_DISPLAY } from "@/lib/grid/view-state";

const key = () => `k-${Math.random().toString(36).slice(2)}`;

// ------------------------------------------------------------- the parser

describe("parseDisplayPrefs", () => {
  it("reads a row the way the database stores it", () => {
    expect(
      parseDisplayPrefs({
        display_density: "comfortable",
        display_type_scale: "large",
        display_keyboard_hints: false,
        display_landing_view: "jobs",
        display_theme: "dark",
      }),
    ).toEqual({
      density: "comfortable",
      typeScale: "large",
      keyboardHints: false,
      landingView: "jobs",
      theme: "dark",
    });
  });

  it("resolves anything it does not recognise to the defaults, and never throws", () => {
    // A preference saved by a future version must still OPEN in this one — the
    // rule `parseViewState` already follows for the same knobs on the grid.
    for (const raw of [
      null,
      undefined,
      42,
      "junk",
      [],
      {},
      { display_density: "cozy", display_type_scale: 9, display_theme: "sepia" },
      { display_landing_view: "autopilot" },
      { display_landing_view: "x".repeat(LANDING_VIEW_MAX + 1) },
    ]) {
      expect(parseDisplayPrefs(raw)).toEqual(DEFAULT_DISPLAY_PREFS);
    }
  });

  it("a missing keyboard_hints means hints ON, not hints off", () => {
    // MUTATION REASON: `Boolean(o.display_keyboard_hints)` passes every case
    // above and turns every read that lost the column into hints-off — the
    // keyboard shortcuts vanishing with no error anywhere.
    expect(parseDisplayPrefs({}).keyboardHints).toBe(true);
    expect(parseDisplayPrefs({ display_keyboard_hints: false }).keyboardHints).toBe(false);
  });

  it("the defaults are the values the app rendered before 0025", () => {
    // The property that let the migration land without re-recording a visual
    // baseline, asserted where a careless edit to either side would show up.
    expect(DEFAULT_DISPLAY_PREFS.density).toBe(DEFAULT_DISPLAY.density);
    expect(DEFAULT_DISPLAY_PREFS.typeScale).toBe(DEFAULT_DISPLAY.typeScale);
    expect(DEFAULT_DISPLAY_PREFS.keyboardHints).toBe(DEFAULT_DISPLAY.hints);
    expect(DEFAULT_DISPLAY_PREFS.theme).toBe("system");
  });

  it("the profile vocabulary and the grid's are the same words", () => {
    // /jobs still carries its own per-view density and scale until the Jobs
    // surface build retires them into this store. Two vocabularies for one
    // stylesheet selector is how `data-density="compact"` ends up matching
    // nothing at all, so the sets are pinned equal rather than assumed.
    expect([...DENSITIES].sort()).toEqual(["comfortable", "dense"]);
    expect([...TYPE_SCALES].sort()).toEqual(["default", "large"]);
    expect([...THEMES].sort()).toEqual(["dark", "light", "system"]);
  });
});

describe("displayAttributes", () => {
  it("emits nothing for a default, so the DOM is unchanged for an untouched account", () => {
    // `:root[data-density="comfortable"]` is the only density rule in
    // globals.css. Writing `data-density="dense"` would be an attribute with no
    // rule behind it — and would change the rendered markup of every committed
    // visual baseline for no behavioural reason.
    expect(displayAttributes(DEFAULT_DISPLAY_PREFS)).toEqual({
      "data-type-scale": undefined,
      "data-density": undefined,
    });
  });

  it("emits the values globals.css actually selects on", () => {
    expect(
      displayAttributes({ ...DEFAULT_DISPLAY_PREFS, density: "comfortable", typeScale: "large" }),
    ).toEqual({ "data-type-scale": "large", "data-density": "comfortable" });
  });
});

// ------------------------------------------------------- the fake's parity

describe("the fixture store implements app_set_display_prefs", () => {
  it("starts at the server's defaults with no version token", () => {
    // No `profiles` row exists until the first write, so "nothing saved yet"
    // has to be a state the fake can be IN — a fake that started with a token
    // would make every first write send an expectation production cannot match.
    return expect(new FixtureDataSource().displayPrefs()).resolves.toEqual({
      ...DEFAULT_DISPLAY_PREFS,
      updatedAt: null,
    });
  });

  it("an omitted value leaves its column alone", async () => {
    // The reason every value is optional. A call that restated all five would
    // replay whatever this tab last READ into the other four, so flipping
    // density on the phone would revert the type scale the laptop just set.
    //
    // MUTATION REASON: `input.density || row.display_density` passes this and
    // breaks `keyboardHints: false` / `landingView: ""`, both of which are
    // falsy and both of which mean something.
    const src = new FixtureDataSource();
    await src.setDisplayPrefs({
      typeScale: "large",
      keyboardHints: false,
      landingView: "jobs",
      idempotencyKey: key(),
      expectedUpdatedAt: null,
    });
    await src.setDisplayPrefs({
      density: "comfortable",
      idempotencyKey: key(),
      expectedUpdatedAt: null,
    });
    const got = await src.displayPrefs();
    expect(displayPrefsEqual(got, {
      density: "comfortable",
      typeScale: "large",
      keyboardHints: false,
      landingView: "jobs",
      theme: "system",
    })).toBe(true);
  });

  it("a write that changes nothing reports changed:false and holds the token still", async () => {
    // Autosave fires on gestures that are frequently no-ops. The token holding
    // still is what stops a tab invalidating its own expectation.
    //
    // MUTATION REASON: drop the `DISPLAY_COLUMNS.some(...)` guard and both
    // assertions go red — `changed` reads true and the token moves.
    const src = new FixtureDataSource();
    await src.setDisplayPrefs({
      density: "comfortable",
      idempotencyKey: key(),
      expectedUpdatedAt: null,
    });
    const token = (await src.displayPrefs()).updatedAt;

    const out = await src.setDisplayPrefs({
      density: "comfortable",
      idempotencyKey: key(),
      expectedUpdatedAt: null,
    });

    expect(out).toMatchObject({ ok: true, changed: false });
    expect((await src.displayPrefs()).updatedAt).toBe(token);
  });

  it("a real change reports changed:true and moves the token", async () => {
    // The positive control. Without it, a store that refused every write would
    // pass the case above.
    const src = new FixtureDataSource();
    const first = await src.setDisplayPrefs({
      density: "comfortable",
      idempotencyKey: key(),
      expectedUpdatedAt: null,
    });
    expect(first).toMatchObject({ ok: true, changed: true });
    expect((await src.displayPrefs()).updatedAt).not.toBeNull();
  });

  it("a stale token is a conflict carrying what the server has", async () => {
    const src = new FixtureDataSource();
    await src.setDisplayPrefs({
      theme: "dark",
      idempotencyKey: key(),
      expectedUpdatedAt: null,
    });
    const out = await src.setDisplayPrefs({
      theme: "light",
      idempotencyKey: key(),
      expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(out).toMatchObject({ ok: false, kind: "conflict" });
    // The conflict carries the CURRENT row, so a caller can adopt the other
    // device's answer rather than guessing.
    expect(out.ok === false && out.kind === "conflict" && out.current.theme).toBe("dark");
    expect((await src.displayPrefs()).theme).toBe("dark");
  });

  it("a matching token is accepted", async () => {
    const src = new FixtureDataSource();
    await src.setDisplayPrefs({
      theme: "dark",
      idempotencyKey: key(),
      expectedUpdatedAt: null,
    });
    const token = (await src.displayPrefs()).updatedAt;
    const out = await src.setDisplayPrefs({
      theme: "light",
      idempotencyKey: key(),
      expectedUpdatedAt: token,
    });
    expect(out).toMatchObject({ ok: true, changed: true });
  });

  it("replaying a key returns the first answer rather than writing twice", async () => {
    const src = new FixtureDataSource();
    const idem = key();
    const first = await src.setDisplayPrefs({
      typeScale: "large",
      idempotencyKey: idem,
      expectedUpdatedAt: null,
    });
    const second = await src.setDisplayPrefs({
      typeScale: "large",
      idempotencyKey: idem,
      expectedUpdatedAt: null,
    });
    expect(second).toEqual(first);
  });

  it("refuses a blank idempotency key, including one made of whitespace", async () => {
    // 0025 uses `hq_blank_trim`, so a key of one NEWLINE is blank there the way
    // it is blank to a person. A fake using `length === 0` would accept it and
    // then have every LATER blank key replay the first gesture forever.
    const src = new FixtureDataSource();
    for (const bad of ["", " ", "\n"]) {
      expect(
        await src.setDisplayPrefs({
          density: "comfortable",
          idempotencyKey: bad,
          expectedUpdatedAt: null,
        }),
      ).toMatchObject({ ok: false, kind: "error" });
    }
  });

  it("refuses a value the CHECK constraints refuse", async () => {
    // A fake more forgiving than the database lets a demo — and every e2e
    // journey that drives one — prove a write production rejects.
    const src = new FixtureDataSource();
    const cases = [
      { density: "cozy" as never },
      { typeScale: "enormous" as never },
      { theme: "sepia" as never },
      { landingView: "x".repeat(LANDING_VIEW_MAX + 1) },
    ];
    for (const c of cases) {
      expect(
        await src.setDisplayPrefs({ ...c, idempotencyKey: key(), expectedUpdatedAt: null }),
      ).toMatchObject({ ok: false, kind: "error" });
    }
    expect(await src.displayPrefs()).toMatchObject(DEFAULT_DISPLAY_PREFS);
  });

  it("the arming seam still turns the next write into a failure", async () => {
    // `failNextWrite` is how the e2e suite proves an optimistic control reverts
    // rather than leaving a phantom. A write path that skipped it would be the
    // one gesture in the app with no failure journey.
    const src = new FixtureDataSource();
    src.failNextWrite("nope");
    expect(
      await src.setDisplayPrefs({
        theme: "dark",
        idempotencyKey: key(),
        expectedUpdatedAt: null,
      }),
    ).toMatchObject({ ok: false, kind: "error", message: "nope" });
    expect((await src.displayPrefs()).theme).toBe("system");
  });

  it("a display write leaves the Search Profile's version token alone", async () => {
    // The TypeScript half of the bug 0025's trigger clause fixes: the two lanes
    // carry independent tokens, so an autosaved preference cannot make a
    // half-finished profile edit un-saveable.
    const src = new FixtureDataSource();
    const before = (await src.profile()).updatedAt;
    await src.setDisplayPrefs({
      typeScale: "large",
      idempotencyKey: key(),
      expectedUpdatedAt: null,
    });
    expect((await src.profile()).updatedAt).toBe(before);
  });
});

// ------------------------------------------------- the read mapper's shape

describe("toDisplayPrefsView", () => {
  it("maps a jsonb write result and a plain select identically", () => {
    // `app_display_prefs_row` emits the COLUMN names so one mapper serves both.
    // A replay that answered a differently-shaped object than the original
    // write is the difference nothing catches until the UI renders blanks.
    const row = {
      display_density: "comfortable",
      display_type_scale: "large",
      display_keyboard_hints: false,
      display_landing_view: "pipeline",
      display_theme: "light",
      display_updated_at: "2026-07-21T15:00:00.000Z",
    };
    expect(toDisplayPrefsView(row)).toEqual({
      density: "comfortable",
      typeScale: "large",
      keyboardHints: false,
      landingView: "pipeline",
      theme: "light",
      updatedAt: "2026-07-21T15:00:00.000Z",
    });
  });

  it("a missing row is the defaults with no token, not a throw", () => {
    expect(toDisplayPrefsView(null)).toEqual({ ...DEFAULT_DISPLAY_PREFS, updatedAt: null });
  });
});
