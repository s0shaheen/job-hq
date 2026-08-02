import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import type { ApplicationView, JobView } from "@/lib/data/view-models";
import { MAPPED_KEY, WRITABLE_COLUMNS } from "@/lib/import/round-trip";
import type { MappedImportRow } from "@/lib/data/source";

/**
 * The import half of the fixture store, compared against migration 0011.
 *
 * The entire `/import` E2E journey runs against this fake, so a fake that
 * succeeds where Postgres refuses ships a wizard whose blocked states nobody has
 * ever seen. `docs/WEBAPP-BUILD.md` records what that has already cost three
 * times: the auto-growing sheet grid, the unconditional health fixture, and the
 * store that existed three times over. Every rule below is a rule the migration
 * enforces, asserted here against the fake AND, where it is a message a person
 * reads, pinned to the migration's own words.
 *
 * `tests/db/test_import.py` is the other half of this pair: it runs the same
 * rules against real Postgres. Neither file replaces the other — this one is
 * what CI can run with no database, and it is what makes the E2E's expectations
 * legitimate.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const IMPORT_SQL = readFileSync(path.join(REPO, "db", "migrations", "0011_import.sql"), "utf8");

// ---------------------------------------------------------------- helpers

function app(over: Partial<ApplicationView> = {}): ApplicationView {
  return {
    id: 1,
    postingKey: null,
    company: "Ramp",
    title: "Product Manager",
    url: null,
    status: "Applied",
    statusActor: "system",
    suggestedStatus: null,
    evidence: null,
    appliedDate: null,
    nextAction: null,
    nextActionDate: null,
    notes: null,
    noteCount: 0,
    latestNote: null,
    postingStatus: null,
    updatedAt: "2026-07-20T10:00:00.000Z",
    ...over,
  };
}

function store(apps: ApplicationView[] = [], jobs: JobView[] = []): FixtureDataSource {
  return new FixtureDataSource(jobs, apps, [], []);
}

type Row = { mapped: Record<string, string>; jobKey: string; strength: "strong" | "weak" | "none" };

/** Upload → stage → map → preview → commit, the way the wizard does it. */
async function runImport(src: FixtureDataSource, rows: Row[], mappingOver = {}) {
  const created = await src.createImport({
    filename: "tracker.xlsx",
    sourceKind: "xlsx",
    contentHash: "sha",
    rowCount: rows.length,
    idempotencyKey: `create-${Math.random()}`,
  });
  if (!created.ok) throw new Error(`createImport failed: ${JSON.stringify(created)}`);
  const batchId = created.batch.id;

  await src.stageImportRows({
    batchId,
    rows: rows.map((r, i) => ({ rowNumber: i + 1, raw: { n: String(i) } })),
  });
  const mapped: MappedImportRow[] = rows.map((r, i) => ({
    rowNumber: i + 1,
    mapped: r.mapped,
    jobKey: r.jobKey,
    keyStrength: r.strength,
  }));
  const set = await src.setImportMapping({
    batchId,
    rows: mapped,
    mapping: {
      headers: ["Company", "Title"],
      headerRowIndex: 0,
      columnMap: { company: 0, title: 1 },
      statusMap: {},
      roundTrip: false,
      unmapped: [],
      ...mappingOver,
    },
    final: true,
    expectedUpdatedAt: null,
  });
  if (!set.ok) throw new Error(`setImportMapping failed: ${JSON.stringify(set)}`);

  const preview = await src.previewImport(batchId);
  if (!preview.ok) throw new Error(`previewImport failed: ${JSON.stringify(preview)}`);
  const commit = await src.commitImportChunk({
    batchId,
    limit: 200,
    idempotencyKey: `commit-${Math.random()}`,
  });
  return { batchId, preview, commit };
}

// ---------------------------------------------------------------- AC 20

describe("a file imported twice adds its rows once (AC 20)", () => {
  const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({
    mapped: { company: `Company ${i}`, title: "PM", status: "Applied" },
    jobKey: `greenhouse-${100 + i}`,
    strength: "strong",
  }));

  it("the first import creates every row", async () => {
    const src = store();
    const { commit } = await runImport(src, rows);
    expect(commit.ok && commit.created).toBe(5);
    expect(await src.applications()).toHaveLength(5);
  });

  it("the second import updates instead of duplicating", async () => {
    const src = store();
    await runImport(src, rows);
    const { commit, preview } = await runImport(src, rows);
    expect(preview.ok && preview.counts["matches-existing"]).toBe(5);
    expect(commit.ok && commit.created).toBe(0);
    expect(commit.ok && commit.updated).toBe(5);
    expect(await src.applications()).toHaveLength(5);
  });

  it("a repeat inside one file is skipped, and the FIRST occurrence wins", async () => {
    const src = store();
    const { commit, batchId } = await runImport(src, [
      { mapped: { company: "Ramp", title: "PM", status: "Applied" }, jobKey: "greenhouse-1", strength: "strong" },
      { mapped: { company: "Ramp", title: "PM", status: "Screen" }, jobKey: "greenhouse-1", strength: "strong" },
    ]);
    expect(commit.ok && commit.created).toBe(1);
    expect(commit.ok && commit.skipped).toBe(1);
    const loaded = await src.importBatch(batchId);
    expect(loaded?.rows[1].matchKind).toBe("duplicate-in-file");
    expect((await src.applications())[0].status).toBe("Applied");
  });
});

// -------------------------------------------------- weak keys never merge

describe("only a strong key may merge", () => {
  it("a weak key produces a suggestion, and the existing row is untouched", async () => {
    const src = store([app({ id: 7, status: "Interview" })]);
    const { batchId, commit } = await runImport(src, [
      {
        mapped: { company: "Ramp", title: "Product Manager", status: "Applied" },
        jobKey: "norm-ramp|product-manager|",
        strength: "weak",
      },
    ]);
    const loaded = await src.importBatch(batchId);
    expect(loaded?.rows[0].matchKind).toBe("suggestion");
    expect(loaded?.rows[0].notice).toMatch(/prove/);
    expect(commit.ok && commit.updated).toBe(0);
    const rows = await src.applications();
    expect(rows.find((r) => r.id === 7)!.status).toBe("Interview");
  });

  it("the name fallback folds an interior NBSP run, so a paste is not a duplicate", async () => {
    // M5, on the fake's side. The strong-key name fallback goes through
    // `companyNameKey`, which collapses every run of space-like characters to one
    // space before folding case; `toLowerCase()` alone folds case and nothing
    // else. Every other case in this file differs only by case, so swapping one
    // for the other left them all green. "Goldman<NBSP>Sachs" is what pasting
    // out of a web page puts in a cell.
    const src = store([app({ id: 30, company: "Goldman Sachs", title: "Product  Manager" })]);
    const { commit, batchId } = await runImport(src, [
      {
        mapped: { company: "Goldman\u00a0Sachs", title: "Product\u00a0Manager", status: "Screen" },
        jobKey: "greenhouse-9500",
        strength: "strong",
      },
    ]);
    expect(commit.ok && commit.created, "an NBSP in the name created a duplicate").toBe(0);
    expect(commit.ok && commit.updated).toBe(1);
    expect((await src.importBatch(batchId))?.rows[0].matchKind).toBe("matches-existing");
    expect(await src.applications()).toHaveLength(1);
  });

  it("a suggestion really is inserted separately when it can be", async () => {
    // The outcome the docs promised and no test showed. The case above ends in
    // `skipped`, because its look-alike has the same (company, title) with no
    // posting key and 0002's manual-dedup index forbids a second one — correct,
    // and it left the "inserted separately" half never executed. Here the
    // existing row came from the SWEEP (it carries a posting key), so the partial
    // index does not apply and the suggestion lands as its own row.
    const job = {
      key: "greenhouse-9600",
      company: "Ramp",
      title: "Product Manager",
    } as unknown as JobView;
    const src = store([app({ id: 40, postingKey: "greenhouse-9600", status: "Interview" })], [job]);
    const { batchId, commit } = await runImport(src, [
      {
        mapped: { company: "Ramp", title: "Product Manager", status: "Applied" },
        jobKey: "norm-ramp|product-manager|",
        strength: "weak",
      },
    ]);
    expect((await src.importBatch(batchId))?.rows[0].matchKind).toBe("suggestion");
    expect(commit.ok && commit.updated, "a weak key merged").toBe(0);
    expect(commit.ok && commit.created, "the suggestion was not inserted separately").toBe(1);
    const rows = await src.applications();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === 40)!.status).toBe("Interview");
  });

  it("a weak key with nothing to match is simply imported", async () => {
    const src = store();
    const { batchId, commit } = await runImport(src, [
      {
        mapped: { company: "Unheard Of", title: "PM", status: "Applied" },
        jobKey: "norm-unheard-of|pm|",
        strength: "weak",
      },
    ]);
    expect((await src.importBatch(batchId))?.rows[0].matchKind).toBe("unkeyable");
    expect(commit.ok && commit.created).toBe(1);
  });
});

// -------------------------------------------------------- the human lock

describe("0010's human-status lock, from the import side", () => {
  it("a bulk import leaves a status a human chose, and reports the skip", async () => {
    const src = store([app({ id: 3, status: "Offer", statusActor: "user" })]);
    const { batchId, commit } = await runImport(src, [
      {
        mapped: { company: "Ramp", title: "Product Manager", status: "Rejected", nextAction: "chase" },
        jobKey: "greenhouse-500",
        strength: "strong",
      },
    ]);
    expect(commit.ok && commit.failed).toBe(0);
    const row = (await src.applications()).find((a) => a.id === 3)!;
    expect(row.status).toBe("Offer");
    // The lock is on `status`, not on the row: everything else still imported.
    expect(row.nextAction).toBe("chase");
    const report = await src.importReport(batchId);
    expect(report).toEqual(
      expect.arrayContaining([expect.objectContaining({ column: "Status", disposition: "locked", rows: 1 })]),
    );
  });

  it("an imported row stays advanceable by the engine, on both paths", async () => {
    const src = store();
    await runImport(src, [
      { mapped: { company: "Ramp", title: "PM", status: "Applied" }, jobKey: "greenhouse-600", strength: "strong" },
    ]);
    const created = (await src.applications())[0];
    expect(created.statusActor).toBe("system");

    await runImport(src, [
      { mapped: { company: "Ramp", title: "PM", status: "Screen" }, jobKey: "greenhouse-600", strength: "strong" },
    ]);
    const updated = (await src.applications()).find((a) => a.id === created.id)!;
    expect(updated.status).toBe("Screen");
    expect(updated.statusActor).toBe("system");
  });
});

// ---------------------------------------------------------- the round trip

describe("the Excel round trip", () => {
  async function roundTrip(src: FixtureDataSource, token: string, over: Record<string, string> = {}) {
    return runImport(src, [
      {
        mapped: {
          company: "Ramp",
          title: "Product Manager",
          status: "Interview",
          nextAction: "prep loop",
          hqId: "9",
          hqVersion: token,
          ...over,
        },
        jobKey: "greenhouse-700",
        strength: "strong",
      },
    ]);
  }

  it("a matching token writes the writable columns and claims the row", async () => {
    const src = store([app({ id: 9, updatedAt: "2026-07-20T10:00:00.000Z" })]);
    const { batchId, commit } = await roundTrip(src, "2026-07-20T10:00:00.000Z");
    expect((await src.importBatch(batchId))?.rows[0].matchKind).toBe("round-trip");
    expect(commit.ok && commit.updated).toBe(1);
    const row = (await src.applications())[0];
    expect(row.status).toBe("Interview");
    expect(row.nextAction).toBe("prep loop");
    // The file carried this row's own version token, which is the same proof
    // `app_set_status` demands of the pipeline UI.
    expect(row.statusActor).toBe("user");
  });

  it("may change a status the same human had already locked", async () => {
    // The combination 0010's trigger actually governs, and the one the other
    // cases miss. In SQL, an undeclared write here raises 42501 and takes the
    // whole chunk down on the one row somebody cared most about; a declaration on
    // every import would let a bulk file overwrite it silently. The version token
    // is what separates the two, and it is present.
    const src = store([
      app({ id: 9, status: "Offer", statusActor: "user", updatedAt: "2026-07-20T10:00:00.000Z" }),
    ]);
    const { commit } = await roundTrip(src, "2026-07-20T10:00:00.000Z", {
      status: "Offer-Accepted",
    });
    expect(commit.ok && commit.failed).toBe(0);
    expect(commit.ok && commit.updated).toBe(1);
    const row = (await src.applications())[0];
    expect(row.status).toBe("Offer-Accepted");
    expect(row.statusActor).toBe("user");
  });

  it("a token in a different but equal rendering is not a conflict", async () => {
    // The trap this pins: `+00:00` and `+00` are the same instant and two
    // strings. A string comparison reports every row of every round-trip file
    // as stale, which reads as the feature being broken.
    const src = store([app({ id: 9, updatedAt: "2026-07-20T10:00:00.000Z" })]);
    const { preview } = await roundTrip(src, "2026-07-20T10:00:00.000+00:00");
    expect(preview.ok && preview.unresolved).toBe(0);
  });

  it("a stale token blocks the whole commit, and names the count (AC 23)", async () => {
    const src = store([app({ id: 9, status: "Screen", updatedAt: "2026-07-21T09:00:00.000Z" })]);
    const { preview, commit } = await roundTrip(src, "2026-07-20T10:00:00.000Z");
    expect(preview.ok && preview.unresolved).toBe(1);
    expect(commit.ok).toBe(false);
    expect(!commit.ok && commit.kind === "error" && commit.message).toMatch(/unresolved conflicts/);
    expect((await src.applications())[0].status).toBe("Screen");
  });

  it("resolving cell by cell writes only what was chosen", async () => {
    const src = store([app({ id: 9, status: "Screen", nextAction: "mine", updatedAt: "2026-07-21T09:00:00.000Z" })]);
    const created = await src.createImport({
      filename: "rt.xlsx", sourceKind: "xlsx", contentHash: "s", rowCount: 1,
      idempotencyKey: "c1",
    });
    if (!created.ok) throw new Error("createImport failed");
    const batchId = created.batch.id;
    await src.stageImportRows({ batchId, rows: [{ rowNumber: 1, raw: {} }] });
    await src.setImportMapping({
      batchId,
      rows: [{
        rowNumber: 1,
        mapped: {
          company: "Ramp", title: "Product Manager", status: "Rejected",
          nextAction: "theirs", hqId: "9", hqVersion: "2026-07-20T10:00:00.000Z",
        },
        jobKey: "greenhouse-700", keyStrength: "strong",
      }],
      mapping: {
        headers: [], headerRowIndex: 0, columnMap: {}, statusMap: {},
        roundTrip: true, unmapped: [],
      },
      final: true,
      expectedUpdatedAt: null,
    });
    await src.previewImport(batchId);
    const resolved = await src.resolveImportRow({
      batchId, rowNumber: 1, choices: { status: "mine", next_action: "theirs" },
    });
    expect(resolved.ok && resolved.unresolved).toBe(0);
    const commit = await src.commitImportChunk({ batchId, limit: 200, idempotencyKey: "k1" });
    expect(commit.ok && commit.updated).toBe(1);
    const row = (await src.applications())[0];
    expect(row.status).toBe("Screen");
    expect(row.nextAction).toBe("theirs");
  });

  it("an hq_id matching nothing is a new row, and says so", async () => {
    const src = store([app({ id: 9 })]);
    const { batchId } = await runImport(src, [
      {
        mapped: { company: "Other Co", title: "PM", status: "Applied", hqId: "424242" },
        jobKey: "greenhouse-800",
        strength: "strong",
      },
    ]);
    const row = (await src.importBatch(batchId))!.rows[0];
    expect(row.matchKind).not.toBe("round-trip");
    expect(row.notice).toMatch(/matched none/);
  });

  it("a round trip with no version column claims nothing (matrix row 40)", async () => {
    const src = store([app({ id: 9, status: "Offer", statusActor: "user" })]);
    const { batchId } = await runImport(src, [
      {
        mapped: { company: "Ramp", title: "Product Manager", status: "Rejected", hqId: "9" },
        jobKey: "greenhouse-900",
        strength: "strong",
      },
    ]);
    expect((await src.importBatch(batchId))!.rows[0].matchKind).toBe("round-trip");
    const row = (await src.applications())[0];
    expect(row.status).toBe("Offer");
    expect(row.statusActor).toBe("user");
  });
});

// ------------------------------------------------------------- never destroy

describe("an import never destroys", () => {
  it("a blank cell leaves the value alone", async () => {
    const src = store([
      app({ id: 4, status: "Interview", nextAction: "call Priya", appliedDate: "2026-06-01" }),
    ]);
    await runImport(src, [
      {
        mapped: { company: "Ramp", title: "Product Manager", status: "", nextAction: "", appliedDate: "" },
        jobKey: "greenhouse-1000",
        strength: "strong",
      },
    ]);
    const row = (await src.applications())[0];
    expect(row.status).toBe("Interview");
    expect(row.nextAction).toBe("call Priya");
    expect(row.appliedDate).toBe("2026-06-01");
  });

  /**
   * The cell that LOOKS blank, in the characters a spreadsheet actually contains.
   *
   * `hq_blank_trim` (0010) strips zero-widths and every exotic separator, and the
   * SQL reads every mapped cell through it. The fake read them through bare
   * `.trim()`, which leaves U+200B alone — so a cell holding one zero-width space
   * was BLANK to Postgres and CONTENT to the fake, and the fake was the more
   * forgiving of the two in the direction that writes. Both halves are asserted
   * here; `tests/db/test_import.py` asserts the same cells against real Postgres.
   */
  it.each([
    ["a tab and a newline", "\t\n"],
    ["a non-breaking space", " "],
    ["a zero-width space", "​"],
    ["an ideographic space", "　"],
    ["a BOM", "﻿"],
  ])("a cell holding only %s leaves the value alone", async (_name, blank) => {
    const src = store([
      app({ id: 4, status: "Interview", nextAction: "call Priya", appliedDate: "2026-06-01" }),
    ]);
    await runImport(src, [
      {
        mapped: {
          company: "Ramp",
          title: "Product Manager",
          status: blank,
          nextAction: blank,
          appliedDate: blank,
          notes: blank,
        },
        jobKey: "greenhouse-1000",
        strength: "strong",
      },
    ]);
    const row = (await src.applications())[0];
    expect(row.status).toBe("Interview");
    expect(row.nextAction).toBe("call Priya");
    expect(row.appliedDate).toBe("2026-06-01");
    // And nothing invisible landed in the append-only note trail, which cannot
    // be deleted once it is there.
    expect(await src.notes(4)).toHaveLength(0);
  });

  it("a round-trip cell holding only a zero-width space is not a conflict", async () => {
    // The other half of the same bug: the fake compared its own non-empty reading
    // of an invisible cell against the row's real value and reported a conflict
    // the database would never raise — a wizard blocked on a cell nobody can see.
    const src = store([app({ id: 6, status: "Screen", updatedAt: "2026-07-20T10:00:00.000Z" })]);
    const { preview } = await runImport(
      src,
      [
        {
          mapped: {
            company: "Ramp",
            title: "Product Manager",
            status: "​",
            hqId: "6",
            hqVersion: "2020-01-01T00:00:00.000Z",
          },
          jobKey: "greenhouse-1200",
          strength: "strong",
        },
      ],
      { roundTrip: true },
    );
    expect(preview.ok && preview.counts["round-trip"]).toBe(1);
    expect(preview.ok && preview.unresolved).toBe(0);
    expect((await src.applications())[0].status).toBe("Screen");
  });

  it("a note is appended as `import`, and the flat column is untouched", async () => {
    const src = store([app({ id: 5, notes: "my own note" })]);
    await runImport(src, [
      {
        mapped: { company: "Ramp", title: "Product Manager", notes: "the file's note" },
        jobKey: "greenhouse-1100",
        strength: "strong",
      },
    ]);
    const row = (await src.applications())[0];
    expect(row.notes).toBe("my own note");
    const notes = await src.notes(5);
    expect(notes.map((n) => [n.body, n.author])).toEqual(
      expect.arrayContaining([["the file's note", "import"]]),
    );
  });
});

// ------------------------------------------------------------------ undo

describe("undo (AC 21)", () => {
  const two: Row[] = [
    { mapped: { company: "First", title: "PM", status: "Applied" }, jobKey: "greenhouse-1200", strength: "strong" },
    { mapped: { company: "Second", title: "PM", status: "Applied" }, jobKey: "greenhouse-1201", strength: "strong" },
  ];

  it("removes exactly what the batch created and nothing else", async () => {
    const src = store([app({ id: 2, company: "Pre-existing" })]);
    const { batchId } = await runImport(src, two);
    expect(await src.applications()).toHaveLength(3);
    const undone = await src.undoImport({ batchId, idempotencyKey: "u1" });
    expect(undone.ok && undone.deleted).toBe(2);
    const left = await src.applications();
    expect(left).toHaveLength(1);
    expect(left[0].company).toBe("Pre-existing");
  });

  it("restores the values an update overwrote", async () => {
    const src = store([app({ id: 6, status: "Applied", nextAction: "original" })]);
    const { batchId } = await runImport(src, [
      {
        mapped: { company: "Ramp", title: "Product Manager", status: "Screen", nextAction: "imported" },
        jobKey: "greenhouse-1300",
        strength: "strong",
      },
    ]);
    await src.undoImport({ batchId, idempotencyKey: "u2" });
    const row = (await src.applications())[0];
    expect(row.status).toBe("Applied");
    expect(row.nextAction).toBe("original");
  });

  it("keeps a row edited after the import, and lists it", async () => {
    const src = store();
    const { batchId } = await runImport(src, two);
    const keep = (await src.applications()).find((a) => a.company === "First")!;
    const moved = await src.setStatus({
      applicationId: keep.id,
      status: "Interview",
      idempotencyKey: "s1",
      expectedUpdatedAt: keep.updatedAt,
    });
    expect(moved.ok).toBe(true);

    const undone = await src.undoImport({ batchId, idempotencyKey: "u3" });
    expect(undone.ok && undone.deleted).toBe(1);
    expect(undone.ok && undone.kept).toBe(1);
    expect(undone.ok && undone.keptIds).toContain(keep.id);
    const left = await src.applications();
    expect(left.map((a) => a.company)).toEqual(["First"]);
    expect(left[0].status).toBe("Interview");
  });

  it("is idempotent on its key, and refuses a genuinely second gesture", async () => {
    const src = store();
    const { batchId } = await runImport(src, two);
    const first = await src.undoImport({ batchId, idempotencyKey: "u4" });
    const replay = await src.undoImport({ batchId, idempotencyKey: "u4" });
    expect(replay).toEqual(first);
    const second = await src.undoImport({ batchId, idempotencyKey: "u5" });
    expect(second.ok).toBe(false);
    expect(!second.ok && second.kind === "error" && second.message).toMatch(/already been undone/);
  });

  it("refuses once the window has closed, and deletes nothing", async () => {
    const src = store();
    const { batchId } = await runImport(src, two);
    // The window lives on the BATCH, so moving it is the honest way to test it.
    const loaded = await src.importBatch(batchId);
    expect(loaded!.batch.undoExpiresAt).not.toBeNull();
    (loaded!.batch as { undoExpiresAt: string | null }).undoExpiresAt = null;
    const internal = await src.importBatch(batchId);
    // Mutating the copy must not reach the store — if it did, this whole file
    // would be asserting against its own edits.
    expect(internal!.batch.undoExpiresAt).not.toBeNull();

    const past = new Date(Date.now() - 60_000).toISOString();
    // Reach into the store the way the clock would: the only supported way to
    // expire a batch is time passing, so the test moves the batch instead.
    const store_ = src as unknown as { batches: Map<string, { undoExpiresAt: string | null }> };
    store_.batches.get(batchId)!.undoExpiresAt = past;

    const refused = await src.undoImport({ batchId, idempotencyKey: "u6" });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.kind === "error" && refused.message).toMatch(/undo window/);
    expect(await src.applications()).toHaveLength(2);
  });
});

// ------------------------------------------------------------ chunk + resume

describe("chunked commit", () => {
  const many: Row[] = Array.from({ length: 25 }, (_, i) => ({
    mapped: { company: `Company ${i}`, title: "PM", status: "Applied" },
    jobKey: `greenhouse-${2000 + i}`,
    strength: "strong",
  }));

  it("reports `committing` until the last row lands", async () => {
    const src = store();
    const created = await src.createImport({
      filename: "big.xlsx", sourceKind: "xlsx", contentHash: "s", rowCount: 25,
      idempotencyKey: "c-many",
    });
    if (!created.ok) throw new Error("createImport failed");
    const batchId = created.batch.id;
    await src.stageImportRows({
      batchId,
      rows: many.map((_, i) => ({ rowNumber: i + 1, raw: {} })),
    });
    await src.setImportMapping({
      batchId,
      rows: many.map((r, i) => ({
        rowNumber: i + 1, mapped: r.mapped, jobKey: r.jobKey, keyStrength: r.strength,
      })),
      mapping: { headers: [], headerRowIndex: 0, columnMap: {}, statusMap: {}, roundTrip: false, unmapped: [] },
      final: true,
      expectedUpdatedAt: null,
    });
    await src.previewImport(batchId);

    const first = await src.commitImportChunk({ batchId, limit: 10, idempotencyKey: "k-1" });
    expect(first.ok && first.created).toBe(10);
    expect(first.ok && first.remaining).toBe(15);
    // The whole point of the state: a half-imported batch must not look finished.
    expect(first.ok && first.batch.state).toBe("committing");
    expect(first.ok && first.batch.committedCount).toBe(10);

    await src.commitImportChunk({ batchId, limit: 10, idempotencyKey: "k-2" });
    const last = await src.commitImportChunk({ batchId, limit: 10, idempotencyKey: "k-3" });
    expect(last.ok && last.remaining).toBe(0);
    expect(last.ok && last.batch.state).toBe("committed");
    expect(await src.applications()).toHaveLength(25);
  });

  it("a replayed chunk key returns the stored answer instead of committing again", async () => {
    /**
     * This test used to replay nothing.
     *
     * `runImport` mints its own `commit-${Math.random()}` key and this sent a
     * FRESH one afterwards, so what it exercised was the "already committed,
     * nothing pending" early return — not the idempotency map at all. Deleting
     * the fake's two replay lines left the whole suite green.
     *
     * A real replay needs the key the first call used AND a batch with rows still
     * pending, or the early return answers first and the replay is once again not
     * the thing under test. So: 25 rows, one chunk of 10, then the SAME key.
     */
    const src = store();
    const created = await src.createImport({
      filename: "big.xlsx", sourceKind: "xlsx", contentHash: "s", rowCount: 25,
      idempotencyKey: "c-replay",
    });
    if (!created.ok) throw new Error("createImport failed");
    const batchId = created.batch.id;
    await src.stageImportRows({
      batchId,
      rows: many.map((_, i) => ({ rowNumber: i + 1, raw: {} })),
    });
    await src.setImportMapping({
      batchId,
      rows: many.map((r, i) => ({
        rowNumber: i + 1, mapped: r.mapped, jobKey: r.jobKey, keyStrength: r.strength,
      })),
      mapping: { headers: [], headerRowIndex: 0, columnMap: {}, statusMap: {}, roundTrip: false, unmapped: [] },
      final: true,
      expectedUpdatedAt: null,
    });
    await src.previewImport(batchId);

    const first = await src.commitImportChunk({ batchId, limit: 10, idempotencyKey: "replay-me" });
    expect(first.ok && first.created).toBe(10);
    expect(first.ok && first.remaining).toBe(15);
    const after = (await src.applications()).length;

    const replay = await src.commitImportChunk({ batchId, limit: 10, idempotencyKey: "replay-me" });
    // The STORED answer, byte for byte — including `remaining: 15`, which is the
    // tell: a second real chunk would have committed the next ten and answered 5.
    expect(replay).toEqual(first);
    expect((await src.applications()).length).toBe(after);
  });

  it("an excluded row is not written, and does not leave the batch pending", async () => {
    const src = store();
    const created = await src.createImport({
      filename: "x.csv", sourceKind: "csv", contentHash: "s", rowCount: 2,
      idempotencyKey: "c-ex",
    });
    if (!created.ok) throw new Error("createImport failed");
    const batchId = created.batch.id;
    await src.stageImportRows({ batchId, rows: [{ rowNumber: 1, raw: {} }, { rowNumber: 2, raw: {} }] });
    await src.setImportMapping({
      batchId,
      rows: [
        { rowNumber: 1, mapped: { company: "Wanted", title: "PM" }, jobKey: "greenhouse-3000", keyStrength: "strong" },
        { rowNumber: 2, mapped: { company: "Vetoed", title: "PM" }, jobKey: "greenhouse-3001", keyStrength: "strong" },
      ],
      mapping: { headers: [], headerRowIndex: 0, columnMap: {}, statusMap: {}, roundTrip: false, unmapped: [] },
      final: true,
      expectedUpdatedAt: null,
    });
    await src.previewImport(batchId);
    await src.setImportRowsIncluded({ batchId, rowNumbers: [2], included: false });
    const commit = await src.commitImportChunk({ batchId, limit: 200, idempotencyKey: "k-ex" });
    expect(commit.ok && commit.created).toBe(1);
    expect(commit.ok && commit.batch.state).toBe("committed");
    expect((await src.applications()).map((a) => a.company)).toEqual(["Wanted"]);
  });

  it("an armed failure reaches the commit path", async () => {
    // `failNextWrite` had zero callers once already (matrix row 99). A capability
    // this suite counts must be exercised, or it is a test that cannot fail.
    const src = store();
    const created = await src.createImport({
      filename: "f.csv", sourceKind: "csv", contentHash: "s", rowCount: 1,
      idempotencyKey: "c-f",
    });
    if (!created.ok) throw new Error("createImport failed");
    const batchId = created.batch.id;
    await src.stageImportRows({ batchId, rows: [{ rowNumber: 1, raw: {} }] });
    await src.setImportMapping({
      batchId,
      rows: [{ rowNumber: 1, mapped: { company: "A", title: "PM" }, jobKey: "greenhouse-4000", keyStrength: "strong" }],
      mapping: { headers: [], headerRowIndex: 0, columnMap: {}, statusMap: {}, roundTrip: false, unmapped: [] },
      final: true,
      expectedUpdatedAt: null,
    });
    await src.previewImport(batchId);
    src.failNextWrite("Network unavailable");
    const failed = await src.commitImportChunk({ batchId, limit: 200, idempotencyKey: "k-f" });
    expect(failed.ok).toBe(false);
    expect(await src.applications()).toHaveLength(0);
    // And the batch is still committable afterwards — a failed chunk is not a
    // dead import.
    const retry = await src.commitImportChunk({ batchId, limit: 200, idempotencyKey: "k-f2" });
    expect(retry.ok && retry.created).toBe(1);
  });
});

// ------------------------------------------------------------------ bounds

describe("bounds and refusals, in the migration's own words", () => {
  it("a file over the row cap is refused with the SQL's message", async () => {
    const src = store();
    const result = await src.createImport({
      filename: "huge.xlsx", sourceKind: "xlsx", contentHash: "", rowCount: 5001,
      idempotencyKey: "c-huge",
    });
    expect(result.ok).toBe(false);
    const message = !result.ok && result.kind === "error" ? result.message : "";
    expect(message).toMatch(/the limit is 5000/);
    // Pinned to the migration, because a fake with a friendlier ceiling means the
    // UI never renders the message a real 6,000-row file produces.
    expect(IMPORT_SQL).toContain("the limit is %");
    expect(IMPORT_SQL).toMatch(/MAX_ROWS\s+constant integer := 5000/);
  });

  it("an unsupported source kind is refused", async () => {
    const src = store();
    const result = await src.createImport({
      filename: "x.numbers",
      // Deliberately outside the type: the input type is erased at runtime and
      // this function is reachable from a server action.
      sourceKind: "numbers" as "csv",
      contentHash: "", rowCount: 1, idempotencyKey: "c-n",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind === "error" && result.message).toMatch(
      /unsupported import source/,
    );
  });

  it("a resolver choice outside the writable set is refused", async () => {
    const src = store([app({ id: 9, status: "Screen", updatedAt: "2026-07-21T09:00:00.000Z" })]);
    const created = await src.createImport({
      filename: "r.xlsx", sourceKind: "xlsx", contentHash: "", rowCount: 1, idempotencyKey: "c-r",
    });
    if (!created.ok) throw new Error("createImport failed");
    await src.stageImportRows({ batchId: created.batch.id, rows: [{ rowNumber: 1, raw: {} }] });
    await src.setImportMapping({
      batchId: created.batch.id,
      rows: [{
        rowNumber: 1,
        mapped: {
          company: "Ramp", title: "Product Manager", status: "Rejected",
          hqId: "9", hqVersion: "2026-07-20T10:00:00.000Z",
        },
        jobKey: "greenhouse-5000", keyStrength: "strong",
      }],
      mapping: { headers: [], headerRowIndex: 0, columnMap: {}, statusMap: {}, roundTrip: true, unmapped: [] },
      final: true, expectedUpdatedAt: null,
    });
    await src.previewImport(created.batch.id);
    const bad = await src.resolveImportRow({
      batchId: created.batch.id, rowNumber: 1, choices: { company: "theirs" },
    });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.kind === "error" && bad.message).toMatch(/not one an import may write/);
  });

  it("a mapping that missed rows is refused before anything commits", async () => {
    const src = store();
    const created = await src.createImport({
      filename: "m.csv", sourceKind: "csv", contentHash: "", rowCount: 2, idempotencyKey: "c-m",
    });
    if (!created.ok) throw new Error("createImport failed");
    await src.stageImportRows({
      batchId: created.batch.id,
      rows: [{ rowNumber: 1, raw: {} }, { rowNumber: 2, raw: {} }],
    });
    const set = await src.setImportMapping({
      batchId: created.batch.id,
      rows: [{ rowNumber: 1, mapped: { company: "A", title: "PM" }, jobKey: "greenhouse-6000", keyStrength: "strong" }],
      mapping: { headers: [], headerRowIndex: 0, columnMap: {}, statusMap: {}, roundTrip: false, unmapped: [] },
      final: true, expectedUpdatedAt: null,
    });
    expect(set.ok).toBe(false);
    expect(!set.ok && set.kind === "error" && set.message).toMatch(/never got a mapping/);
  });

  it("a second tab re-mapping the same batch conflicts rather than clobbering", async () => {
    const src = store();
    const created = await src.createImport({
      filename: "c.csv", sourceKind: "csv", contentHash: "", rowCount: 1, idempotencyKey: "c-c",
    });
    if (!created.ok) throw new Error("createImport failed");
    const batchId = created.batch.id;
    const stale = created.batch.updatedAt;
    await src.stageImportRows({ batchId, rows: [{ rowNumber: 1, raw: {} }] });
    const row = { rowNumber: 1, mapped: { company: "A", title: "PM" }, jobKey: "greenhouse-7000", keyStrength: "strong" as const };
    const mapping = { headers: [], headerRowIndex: 0, columnMap: {}, statusMap: {}, roundTrip: false, unmapped: [] };
    await src.setImportMapping({ batchId, rows: [row], mapping, final: true, expectedUpdatedAt: stale });
    const second = await src.setImportMapping({
      batchId, rows: [row], mapping, final: true, expectedUpdatedAt: stale,
    });
    expect(second.ok).toBe(false);
    expect(!second.ok && second.kind).toBe("conflict");
  });

  it("a committed batch can no longer be re-mapped", async () => {
    const src = store();
    const { batchId } = await runImport(src, [
      { mapped: { company: "A", title: "PM" }, jobKey: "greenhouse-8000", strength: "strong" },
    ]);
    const again = await src.setImportMapping({
      batchId,
      rows: [{ rowNumber: 1, mapped: { company: "B", title: "PM" }, jobKey: "greenhouse-8001", keyStrength: "strong" }],
      mapping: { headers: [], headerRowIndex: 0, columnMap: {}, statusMap: {}, roundTrip: false, unmapped: [] },
      final: true, expectedUpdatedAt: null,
    });
    expect(again.ok).toBe(false);
    expect(!again.ok && again.kind === "error" && again.message).toMatch(/no longer be re-mapped/);
  });
});

// --------------------------------------------------------------- discard

describe("discarding an unfinished import", () => {
  it("removes it, and a committed one is refused", async () => {
    const src = store();
    const created = await src.createImport({
      filename: "abandoned.csv", sourceKind: "csv", contentHash: "", rowCount: 1,
      idempotencyKey: "c-d",
    });
    if (!created.ok) throw new Error("createImport failed");
    await src.stageImportRows({ batchId: created.batch.id, rows: [{ rowNumber: 1, raw: {} }] });
    const gone = await src.discardImport({ batchId: created.batch.id, idempotencyKey: "d1" });
    expect(gone.ok).toBe(true);
    expect(await src.importBatch(created.batch.id)).toBeNull();
    expect(await src.imports()).toHaveLength(0);

    const { batchId } = await runImport(src, [
      { mapped: { company: "A", title: "PM" }, jobKey: "greenhouse-9500", strength: "strong" },
    ]);
    const refused = await src.discardImport({ batchId, idempotencyKey: "d2" });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.kind === "error" && refused.message).toMatch(/undo it instead/);
    expect(await src.applications()).toHaveLength(1);
  });

  it("the in-progress cap has a way out", async () => {
    // Asserted as a pair. The cap alone is a claim about a number; the pair is a
    // claim about a person not being permanently stuck.
    const src = store();
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const r = await src.createImport({
        filename: `f${i}.csv`, sourceKind: "csv", contentHash: "", rowCount: 0,
        idempotencyKey: `open-${i}`,
      });
      if (!r.ok) throw new Error(`createImport ${i} failed`);
      ids.push(r.batch.id);
    }
    const blocked = await src.createImport({
      filename: "one-too-many.csv", sourceKind: "csv", contentHash: "", rowCount: 0,
      idempotencyKey: "open-20",
    });
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.kind === "error" && blocked.message).toMatch(/still in progress/);

    await src.discardImport({ batchId: ids[0], idempotencyKey: "d-cap" });
    const through = await src.createImport({
      filename: "now-fine.csv", sourceKind: "csv", contentHash: "", rowCount: 0,
      idempotencyKey: "open-21",
    });
    expect(through.ok).toBe(true);
  });
});

// --------------------------------------------------------------- the report

describe("the per-column report (G13)", () => {
  it("names an engine-owned column that differed, with samples, and does not write it", async () => {
    const src = store(
      [app({ id: 11, postingKey: "greenhouse-9000", title: "Product Manager", url: "https://real/job" })],
      [
        {
          key: "greenhouse-9000", company: "Ramp", title: "Product Manager",
          url: "https://real/job", location: null, metro: null, market: null, country: null, remote: false,
          workModel: null, compRange: null, compMinK: null, compMaxK: null, minYoe: null,
          seniority: null, industry: null, roleFocus: null, skills: [], posted: null,
          firstSeen: null, taggedAt: null, status: "New", disposition: "qualified", dispositionReason: "",
          triage: "", snoozeUntil: null, companyDomain: null, updatedAt: null,
        },
      ],
    );
    const { batchId } = await runImport(
      src,
      [{
        mapped: {
          company: "Ramp", title: "Senior PM", url: "https://stale/job", status: "Screen",
        },
        jobKey: "greenhouse-9000",
        strength: "strong",
      }],
      { unmapped: [{ name: "Recruiter", disposition: "unknown-column" }] },
    );
    const report = await src.importReport(batchId);
    const byColumn = new Map(report.map((r) => [`${r.column}:${r.disposition}`, r]));
    expect(byColumn.get("Title:read-only")?.rows).toBe(1);
    expect(byColumn.get("Title:read-only")?.sample).toEqual(["Senior PM"]);
    expect(byColumn.has("URL:read-only")).toBe(true);
    expect(byColumn.has("Recruiter:unknown-column")).toBe(true);
    expect(byColumn.has("Status:imported")).toBe(true);
    expect((await src.applications())[0].title).toBe("Product Manager");
  });

  it("one column can carry two verdicts", async () => {
    const src = store([
      app({ id: 12, company: "Locked Co", status: "Offer", statusActor: "user" }),
    ]);
    const { batchId } = await runImport(src, [
      { mapped: { company: "Locked Co", title: "Product Manager", status: "Rejected" }, jobKey: "greenhouse-9100", strength: "strong" },
      { mapped: { company: "Open Co", title: "PM", status: "Applied" }, jobKey: "greenhouse-9101", strength: "strong" },
    ]);
    const status = (await src.importReport(batchId)).filter((r) => r.column === "Status");
    expect(status.map((r) => r.disposition).sort()).toEqual(["imported", "locked"]);
    // And the two lines account for two DIFFERENT rows. The `imported` count read
    // the FILE rather than what landed, so the locked row appeared on both lines
    // — one row, two verdicts, and a report adding up to more than the batch.
    expect(Object.fromEntries(status.map((r) => [r.disposition, r.rows]))).toEqual({
      imported: 1,
      locked: 1,
    });
  });

  it("a cell the resolver kept is not reported as imported", async () => {
    // "Keep mine" discards the file's value. Counting the file's value said a
    // value was imported while the row still holds the old one — checkable, and
    // wrong, which is worse than saying nothing.
    const src = store([
      app({ id: 13, status: "Screen", nextAction: "call Priya", updatedAt: "2026-07-20T10:00:00.000Z" }),
    ]);
    const created = await src.createImport({
      filename: "rt.csv",
      sourceKind: "csv",
      contentHash: "rt",
      rowCount: 1,
      idempotencyKey: "rt-report-1",
    });
    if (!created.ok) throw new Error("no batch");
    const batchId = created.batch.id;
    await src.stageImportRows({ batchId, rows: [{ rowNumber: 1, raw: { n: "1" } }] });
    await src.setImportMapping({
      batchId,
      rows: [
        {
          rowNumber: 1,
          mapped: {
            company: "Ramp",
            title: "Product Manager",
            status: "Final",
            nextAction: "book the panel",
            hqId: "13",
            hqVersion: "2020-01-01T00:00:00.000Z",
          },
          jobKey: "greenhouse-9400",
          keyStrength: "strong",
        },
      ],
      mapping: {
        headers: ["Company", "Title"],
        headerRowIndex: 0,
        columnMap: { company: 0, title: 1 },
        statusMap: {},
        roundTrip: true,
        unmapped: [],
      },
      final: true,
      expectedUpdatedAt: null,
    });
    const preview = await src.previewImport(batchId);
    expect(preview.ok && preview.unresolved).toBe(1);
    await src.resolveImportRow({
      batchId,
      rowNumber: 1,
      choices: { status: "mine", next_action: "theirs" },
    });
    await src.commitImportChunk({ batchId, limit: 200, idempotencyKey: "rt-report-c1" });

    const row = (await src.applications())[0];
    expect([row.status, row.nextAction]).toEqual(["Screen", "book the panel"]);

    const report = await src.importReport(batchId);
    expect(report.find((r) => r.column === "Next action" && r.disposition === "imported")).toBeTruthy();
    expect(
      report.find((r) => r.column === "Status" && r.disposition === "imported"),
      "a cell the person chose to keep was reported as imported",
    ).toBeUndefined();
  });
});

// ------------------------------------------------------------ the twin lists

describe("the twin lists stay twins", () => {
  it("WRITABLE_COLUMNS matches hq_import_writable_columns()", () => {
    const m = /hq_import_writable_columns[\s\S]*?select array\[(.*?)\]/.exec(IMPORT_SQL);
    expect(m, "hq_import_writable_columns() not found in 0011").toBeTruthy();
    const fromSql = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect([...WRITABLE_COLUMNS]).toEqual(fromSql);
  });

  it("MAPPED_KEY matches hq_import_mapped_value()'s CASE arms", () => {
    // The failure this prevents is invisible: a mapped key the SQL does not
    // recognise reads as an absent cell, so the value is silently not imported
    // and nothing anywhere says so.
    // Anchored on the CREATE, not on the name: the name appears first inside
    // `hq_import_writable_columns`'s own comment, so a loose match captured that
    // function's body and every arm below "failed" against the wrong text. A
    // parser that matches the wrong thing is the same class of defect as a guard
    // that cannot see its columns (matrix row 92).
    const body =
      /create or replace function public\.hq_import_mapped_value[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(
        IMPORT_SQL,
      );
    expect(body, "hq_import_mapped_value() not found in 0011").toBeTruthy();
    for (const column of WRITABLE_COLUMNS) {
      const arm = new RegExp(`when '${column}'\\s+then '${MAPPED_KEY[column]}'`);
      expect(body![1]).toMatch(arm);
    }
  });

  it("the fixture's state machine uses the migration's own state names", async () => {
    // The first version compared the SQL against a HARDCODED array in this file
    // and never touched `FixtureDataSource` at all — a "twin lists" test with one
    // twin. It would have stayed green with the fake renaming every state.
    const m = /state in \((.*?)\)/s.exec(IMPORT_SQL);
    expect(m).toBeTruthy();
    const fromSql = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(fromSql).toEqual([
      "uploaded", "mapped", "previewed", "committing", "committed", "rolled_back", "failed",
    ]);

    // Now the same names, walked out of the fake by driving it through the states
    // a batch really reaches. `failed` is not among them by design: nothing in
    // either implementation sets it, which is worth saying rather than faking.
    const src = store([app({ id: 20 })]);
    const seen: string[] = [];
    const stateOf = async (id: string) => (await src.importBatch(id))!.batch.state;

    const created = await src.createImport({
      filename: "s.csv", sourceKind: "csv", contentHash: "s", rowCount: 2,
      idempotencyKey: "states-1",
    });
    if (!created.ok) throw new Error("createImport failed");
    const batchId = created.batch.id;
    seen.push(await stateOf(batchId)); // uploaded
    await src.stageImportRows({
      batchId,
      rows: [1, 2].map((n) => ({ rowNumber: n, raw: {} })),
    });
    const rows = [0, 1].map((i) => ({
      rowNumber: i + 1,
      mapped: { company: `Co ${i}`, title: "PM", status: "Applied" },
      jobKey: `greenhouse-950${i}`,
      keyStrength: "strong" as const,
    }));
    await src.setImportMapping({
      batchId,
      rows,
      mapping: { headers: [], headerRowIndex: 0, columnMap: {}, statusMap: {}, roundTrip: false, unmapped: [] },
      final: true,
      expectedUpdatedAt: null,
    });
    seen.push(await stateOf(batchId)); // mapped
    await src.previewImport(batchId);
    seen.push(await stateOf(batchId)); // previewed
    await src.commitImportChunk({ batchId, limit: 1, idempotencyKey: "states-c1" });
    seen.push(await stateOf(batchId)); // committing — one row still pending
    await src.commitImportChunk({ batchId, limit: 1, idempotencyKey: "states-c2" });
    seen.push(await stateOf(batchId)); // committed
    await src.undoImport({ batchId, idempotencyKey: "states-u1" });
    seen.push(await stateOf(batchId)); // rolled_back

    expect(seen).toEqual(fromSql.filter((s) => s !== "failed"));
  });
});
