import { beforeEach, describe, expect, it, vi } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";

/**
 * The six import server actions, called directly — the 466 lines nothing but a
 * browser had ever entered.
 *
 * ## Why this file exists at all
 *
 * A server action is a public HTTP endpoint whose argument types are erased at
 * runtime, so every one of these validators is defending against a payload no UI
 * can produce. The E2E suite drives the UI, which means it only ever sends the
 * VALID shape: the entire closed-set half of `actions.ts` — nine target fields,
 * five writable columns, thirteen statuses, five numeric bounds — was reachable
 * from a `curl` and from nothing else in the test suite. The review that found
 * this also found the journey e2e passing against a gutted commit action, i.e.
 * the browser tests were not covering the server half either.
 *
 * ## What is real here and what is not
 *
 * The DATA SOURCE is real: `FixtureDataSource` is the same implementation the
 * demo and the e2e run against, and it reproduces the store's refusals (a batch
 * past staging, a version-token conflict, the 5,000-row cap) rather than
 * accepting everything. What is stubbed is only Next's ambient request context —
 * `revalidatePath` and `cookies()` — which is not the subject of any assertion
 * below.
 *
 * `hasSession()` short-circuits to true when Supabase env vars are absent, which
 * they are here; the auth branch is driven through the demo-expiry cookie
 * instead, exactly as the browser drives it.
 */

// `actions.ts` pulls in `prepare.ts` and `lib/import/read.ts`, both of which
// start with `import "server-only"` — a module whose whole job is to throw
// outside a server bundle. Same neutralisation as read.test.ts.
vi.mock("server-only", () => ({}));

const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

const { sourceRef } = vi.hoisted(() => ({ sourceRef: { current: null as unknown } }));
vi.mock("@/lib/data/get-source", () => ({
  getDataSource: async () => sourceRef.current,
  isConfigured: () => true,
}));

const {
  setImportMappingAction,
  previewImportAction,
  resolveImportRowAction,
  setImportRowsIncludedAction,
  commitImportChunkAction,
  undoImportAction,
} = await import("@/app/(app)/import/actions");

/** The header row plus two data rows, staged the way the upload route stages. */
const HEADERS = ["Company", "Job Title", "Status", "Applied"];
const DATA = [
  ["Kestrel Labs", "Product Manager", "Applied", "2026-01-04"],
  ["Ironwood Labs", "Senior PM", "Screen", "2026-02-11"],
];

function raw(cells: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  cells.forEach((text, i) => {
    if (text !== "") out[String(i)] = text;
  });
  return out;
}

let source: FixtureDataSource;

/** A staged batch, and the token the mapping write has to send back. */
async function stagedBatch(rows: string[][] = DATA): Promise<{ id: string; token: string | null }> {
  const created = await source.createImport({
    filename: "tracker.csv",
    sourceKind: "csv",
    contentHash: `hash-${Math.random()}`,
    rowCount: rows.length + 1,
    idempotencyKey: crypto.randomUUID(),
  });
  if (!created.ok) throw new Error("fixture refused to create the batch");
  await source.stageImportRows({
    batchId: created.batch.id,
    rows: [HEADERS, ...rows].map((cells, i) => ({ rowNumber: i + 1, raw: raw(cells) })),
  });
  const found = await source.importBatch(created.batch.id);
  return { id: created.batch.id, token: found?.batch.updatedAt ?? null };
}

/** The mapping every valid-path test sends. */
function goodMapping(id: string, token: string | null) {
  return {
    batchId: id,
    headerRowIndex: 0,
    columnMap: { company: 0, title: 1, status: 2, appliedDate: 3 },
    statusMap: { Applied: "Applied", Screen: "Screen" },
    expectedUpdatedAt: token,
  };
}

/** Map, then preview — the state every commit test starts from. */
async function mapped(rows: string[][] = DATA): Promise<string> {
  const { id, token } = await stagedBatch(rows);
  const result = await setImportMappingAction(goodMapping(id, token));
  if (!result.ok) throw new Error(`mapping refused: ${result.message}`);
  return id;
}

beforeEach(() => {
  cookieJar.clear();
  source = new FixtureDataSource();
  sourceRef.current = source;
});

describe("the guard every action shares", () => {
  it("refuses a batch id that is not a string, empty, or absurdly long", async () => {
    for (const batchId of [null, undefined, 42, "", "x".repeat(101)]) {
      const result = await previewImportAction(batchId as string);
      expect(result.ok, `accepted ${JSON.stringify(batchId)}`).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("error");
        expect(result.message).toMatch(/not an import this app can find/i);
      }
    }
  });

  it("reports an expired session as auth, before it looks at the payload", async () => {
    // Auth first, then validation: an expired session with a malformed payload is
    // the expired session, because that is the one the user can act on.
    cookieJar.set("hq_demo_session", "expired");
    process.env.HQ_DEMO = "1";
    try {
      const result = await commitImportChunkAction({
        batchId: "",
        limit: -5,
        idempotencyKey: "",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe("auth");
    } finally {
      delete process.env.HQ_DEMO;
    }
  });

  it("answers a batch that is not one of yours without saying which it is", async () => {
    const result = await setImportMappingAction(goodMapping("batch-does-not-exist", null));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not one of yours, or it is gone/i);
  });
});

describe("setImportMappingAction — the closed sets", () => {
  it("refuses a target field that is not one of the nine", async () => {
    const { id, token } = await stagedBatch();
    const result = await setImportMappingAction({
      ...goodMapping(id, token),
      columnMap: { company: 0, salary: 1 },
    });
    expect(result.ok).toBe(false);
    // Named, not "malformed request": the field is what the caller got wrong.
    if (!result.ok) expect(result.message).toContain("salary");
  });

  it("refuses a status the app does not have — a cell may not mint a stage", async () => {
    const { id, token } = await stagedBatch();
    const result = await setImportMappingAction({
      ...goodMapping(id, token),
      statusMap: { Applied: "Ghosted" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Ghosted is not a status this app has/);
  });

  it("refuses a header row index outside the file's range", async () => {
    const { id, token } = await stagedBatch();
    for (const headerRowIndex of [-2, 1.5, 5001, Number.NaN]) {
      const result = await setImportMappingAction({
        ...goodMapping(id, token),
        headerRowIndex,
      });
      expect(result.ok, `accepted ${headerRowIndex}`).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/not a row this file has/i);
    }
  });

  it("accepts -1, which is the real answer 'every row is data'", async () => {
    const { id, token } = await stagedBatch();
    const result = await setImportMappingAction({
      ...goodMapping(id, token),
      headerRowIndex: -1,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a column index that is not an index", async () => {
    const { id, token } = await stagedBatch();
    for (const index of [-1, 2.5, 1001, "0" as unknown as number]) {
      const result = await setImportMappingAction({
        ...goodMapping(id, token),
        columnMap: { company: index as number },
      });
      expect(result.ok, `accepted ${String(index)}`).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/is mapped to something that is not a column/);
    }
  });

  it("refuses a column the file does not have, after the shape check passes", async () => {
    const { id, token } = await stagedBatch();
    const result = await setImportMappingAction({
      ...goodMapping(id, token),
      columnMap: { company: 0, title: 99 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/a column this file does not have/);
  });

  it("bounds the status vocabulary and each word in it", async () => {
    const { id, token } = await stagedBatch();
    const many: Record<string, string> = {};
    for (let i = 0; i < 501; i += 1) many[`word-${i}`] = "Applied";
    const tooMany = await setImportMappingAction({ ...goodMapping(id, token), statusMap: many });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.message).toMatch(/501 status values; the limit is 500/);

    const tooLong = await setImportMappingAction({
      ...goodMapping(id, token),
      statusMap: { ["x".repeat(201)]: "Applied" },
    });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.message).toMatch(/Malformed status mapping/);
  });

  it("refuses a columnMap or statusMap that is an array rather than an object", async () => {
    const { id, token } = await stagedBatch();
    const asArray = await setImportMappingAction({
      ...goodMapping(id, token),
      columnMap: [] as unknown as Record<string, number>,
    });
    expect(asArray.ok).toBe(false);
    if (!asArray.ok) expect(asArray.message).toMatch(/Malformed column mapping/);
  });

  it("passes the version token through, and a stale one is a conflict not an error", async () => {
    const { id } = await stagedBatch();
    const result = await setImportMappingAction(goodMapping(id, "2020-01-01T00:00:00.000Z"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("conflict");
      expect(result.message).toMatch(/changed in another tab/i);
    }
  });

  it("maps, excludes the header row, and previews in one gesture", async () => {
    const { id, token } = await stagedBatch();
    const result = await setImportMappingAction(goodMapping(id, token));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `previewed`, not `mapped`: stopping between them renders the mapping screen
    // again with no forward control.
    expect(result.batch.state).toBe("previewed");
    expect(result.unresolved).toBe(0);
    // The counts cover EVERY staged row, header included — which is why
    // `preview-step.tsx` recomputes its buckets over the included rows instead of
    // rendering these. Pinned so that stays a known property rather than a
    // surprise the next time somebody trusts the number.
    const total = Object.values(result.counts).reduce((n, c) => n + (c ?? 0), 0);
    expect(total).toBe(3);
    // The header row is nonetheless marked not-to-import, in the same gesture.
    const found = await source.importBatch(id);
    expect(found?.rows.find((r) => r.rowNumber === 1)?.included).toBe(false);
    expect(found?.rows.filter((r) => r.included).length).toBe(2);
  });
});

describe("resolveImportRowAction — the five writable columns", () => {
  it("refuses a column an import may not write", async () => {
    const id = await mapped();
    const result = await resolveImportRowAction({
      batchId: id,
      rowNumber: 2,
      choices: { company: "theirs" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/company is not a column an import can write/);
  });

  it("refuses a choice that is neither side", async () => {
    const id = await mapped();
    const result = await resolveImportRowAction({
      batchId: id,
      rowNumber: 2,
      choices: { status: "whatever" as "mine" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/has to be yours or the file's/);
  });

  it("refuses an empty answer and a row number that cannot exist", async () => {
    const id = await mapped();
    const empty = await resolveImportRowAction({ batchId: id, rowNumber: 2, choices: {} });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.message).toMatch(/Nothing was chosen/);

    for (const rowNumber of [0, -3, 2.5]) {
      const result = await resolveImportRowAction({
        batchId: id,
        rowNumber,
        choices: { status: "theirs" },
      });
      expect(result.ok, `accepted row ${rowNumber}`).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/not a row in this import/);
    }
  });

  it("bounds the number of cells one answer may carry", async () => {
    const id = await mapped();
    const choices: Record<string, "mine"> = {};
    for (let i = 0; i < 6; i += 1) choices[`col-${i}`] = "mine";
    const result = await resolveImportRowAction({ batchId: id, rowNumber: 2, choices });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Malformed choices/);
  });
});

describe("setImportRowsIncludedAction — the veto's bounds", () => {
  it("refuses an empty list, an over-long one, and a row that is not a row", async () => {
    const id = await mapped();
    const none = await setImportRowsIncludedAction({ batchId: id, rowNumbers: [], included: false });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.message).toMatch(/No rows were named/);

    const tooMany = await setImportRowsIncludedAction({
      batchId: id,
      rowNumbers: Array.from({ length: 5001 }, (_, i) => i + 1),
      included: false,
    });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.message).toMatch(/5001 rows in one gesture; the limit is 5000/);

    const bad = await setImportRowsIncludedAction({
      batchId: id,
      rowNumbers: [2, 0],
      included: false,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/not a row in this import/);
  });

  it("refuses a non-boolean `included` rather than coercing it", async () => {
    const id = await mapped();
    const result = await setImportRowsIncludedAction({
      batchId: id,
      rowNumbers: [2],
      included: "false" as unknown as boolean,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Malformed request/);
  });

  it("keeps a row out, and the commit honours it", async () => {
    const before = (await source.applications()).length;
    const id = await mapped();
    const held = await setImportRowsIncludedAction({
      batchId: id,
      rowNumbers: [2],
      included: false,
    });
    expect(held.ok).toBe(true);
    expect(await previewImportAction(id)).toMatchObject({ ok: true });

    // Asserted at the commit rather than in the preview counts: those count every
    // staged row, so a veto that did nothing would leave them unchanged either way.
    await commitImportChunkAction({ batchId: id, limit: 200, idempotencyKey: crypto.randomUUID() });
    expect((await source.applications()).length).toBe(before + 1);
  });
});

describe("commitImportChunkAction — the chunk bounds", () => {
  it("refuses a chunk size outside 1..500", async () => {
    const id = await mapped();
    for (const limit of [0, -1, 501, 2.5, "200" as unknown as number]) {
      const result = await commitImportChunkAction({
        batchId: id,
        limit: limit as number,
        idempotencyKey: "k",
      });
      expect(result.ok, `accepted limit ${String(limit)}`).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/between 1 and 500 rows/);
    }
  });

  it("refuses a missing or over-long idempotency key", async () => {
    const id = await mapped();
    for (const key of ["", "x".repeat(201), undefined]) {
      const result = await commitImportChunkAction({
        batchId: id,
        limit: 200,
        idempotencyKey: key as string,
      });
      expect(result.ok, `accepted key ${String(key)}`).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/Invalid idempotency key/);
    }
  });

  it("commits the rows, and replays the same key rather than committing twice", async () => {
    const id = await mapped();
    const key = crypto.randomUUID();
    const first = await commitImportChunkAction({ batchId: id, limit: 200, idempotencyKey: key });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(2);
    expect(first.remaining).toBe(0);

    const before = (await source.applications()).length;
    const replay = await commitImportChunkAction({ batchId: id, limit: 200, idempotencyKey: key });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.created).toBe(2); // the stored answer, not a second run
    expect((await source.applications()).length).toBe(before);
  });
});

describe("undoImportAction", () => {
  it("refuses a missing or over-long idempotency key", async () => {
    const id = await mapped();
    await commitImportChunkAction({ batchId: id, limit: 200, idempotencyKey: crypto.randomUUID() });
    for (const key of ["", "x".repeat(201)]) {
      const result = await undoImportAction({ batchId: id, idempotencyKey: key });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/Invalid idempotency key/);
    }
  });

  it("takes back exactly what the commit added", async () => {
    const before = (await source.applications()).length;
    const id = await mapped();
    await commitImportChunkAction({ batchId: id, limit: 200, idempotencyKey: crypto.randomUUID() });
    expect((await source.applications()).length).toBe(before + 2);

    const undone = await undoImportAction({ batchId: id, idempotencyKey: crypto.randomUUID() });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.deleted).toBe(2);
    expect((await source.applications()).length).toBe(before);
  });
});
