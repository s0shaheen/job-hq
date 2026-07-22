import { beforeEach, describe, expect, it } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import type { SaveViewInput } from "@/lib/data/source";

/**
 * The fixture's saved-view store must reject exactly what Postgres rejects.
 *
 * This project has been bitten repeatedly by a fake more forgiving than the
 * real thing — a store that accepted a write the database refuses lets the UI
 * ship a gesture that fails only in production. `app_save_view` (0005) refuses
 * a nameless view, a duplicate name (case-insensitive), and a stale version;
 * it keeps at most one default per surface; and it replays an idempotency key.
 * tests/db/test_saved_views.py proves the SQL does all of that; this proves the
 * fixture the tests and the demo run against does the same.
 */

function input(over: Partial<SaveViewInput> = {}): SaveViewInput {
  return {
    id: null,
    name: "Payments",
    surface: "jobs",
    state: { q: "pay" },
    isDefault: false,
    idempotencyKey: crypto.randomUUID(),
    expectedUpdatedAt: null,
    ...over,
  };
}

let src: FixtureDataSource;
beforeEach(() => {
  src = new FixtureDataSource();
});

describe("create", () => {
  it("stores a view and lists it back", async () => {
    const r = await src.saveView(input());
    expect(r.ok).toBe(true);
    const views = await src.savedViews("jobs");
    expect(views.map((v) => v.name)).toEqual(["Payments"]);
    expect(views[0].state).toEqual({ q: "pay" });
  });

  it("refuses a nameless view, like the CHECK does", async () => {
    const r = await src.saveView(input({ name: "   " }));
    expect(r.ok).toBe(false);
  });

  it("refuses a duplicate name case-insensitively, like the unique index does", async () => {
    await src.saveView(input({ name: "Payments" }));
    const r = await src.saveView(input({ name: "payments" }));
    expect(r.ok).toBe(false);
  });

  it("scopes name uniqueness to the surface", async () => {
    await src.saveView(input({ name: "Shared", surface: "jobs" }));
    const r = await src.saveView(input({ name: "Shared", surface: "pipeline" }));
    expect(r.ok).toBe(true);
  });
});

describe("default", () => {
  it("keeps at most one default per surface", async () => {
    await src.saveView(input({ name: "First", isDefault: true }));
    await src.saveView(input({ name: "Second", isDefault: true }));
    const defaults = (await src.savedViews("jobs")).filter((v) => v.isDefault);
    expect(defaults.map((v) => v.name)).toEqual(["Second"]);
  });
});

describe("update and concurrency", () => {
  it("updates in place, keeping the id and moving the version", async () => {
    const created = await src.saveView(input({ name: "V", state: { q: "a" } }));
    if (!created.ok) throw new Error("setup failed");
    const updated = await src.saveView(
      input({ id: created.view.id, name: "V", state: { q: "b" }, expectedUpdatedAt: created.view.updatedAt }),
    );
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.view.id).toBe(created.view.id);
      expect(updated.view.state).toEqual({ q: "b" });
    }
    expect(await src.savedViews("jobs")).toHaveLength(1);
  });

  it("conflicts on a stale expectedUpdatedAt", async () => {
    const created = await src.saveView(input({ name: "V" }));
    if (!created.ok) throw new Error("setup failed");
    const stale = created.view.updatedAt;
    await src.saveView(input({ id: created.view.id, name: "V", state: { q: "x" }, expectedUpdatedAt: stale }));
    const second = await src.saveView(
      input({ id: created.view.id, name: "V", state: { q: "y" }, expectedUpdatedAt: stale }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.kind).toBe("conflict");
  });
});

describe("idempotency", () => {
  it("replays a save key rather than writing twice", async () => {
    const idem = crypto.randomUUID();
    const first = await src.saveView(input({ name: "Once", idempotencyKey: idem }));
    const again = await src.saveView(input({ name: "Once", idempotencyKey: idem }));
    expect(again).toEqual(first);
    expect(await src.savedViews("jobs")).toHaveLength(1);
  });
});

describe("delete", () => {
  it("removes a view", async () => {
    const created = await src.saveView(input({ name: "Doomed" }));
    if (!created.ok) throw new Error("setup failed");
    const r = await src.deleteView({ id: created.view.id, idempotencyKey: crypto.randomUUID() });
    expect(r.ok).toBe(true);
    expect(await src.savedViews("jobs")).toHaveLength(0);
  });
});
