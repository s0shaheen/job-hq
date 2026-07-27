// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { FixtureDataSource } from "@/lib/data/fixture-source";
import { toCsv } from "@/lib/export/delimited";
import { ROUND_TRIP_COLUMNS } from "@/lib/import/round-trip";
import { readDelimited, readWorkbook, cellText, isBlankCell, type Cell } from "@/lib/import/read";
import { isCanonicalStatus } from "@/lib/status";
import {
  grid,
  headerGuess,
  mapModel,
  mapRows,
  previewRows,
  unmappedFor,
  headersOf,
} from "@/app/(app)/import/prepare";

const DIR = join(process.cwd(), "tests/fixtures/import");

/**
 * The whole import journey, over the REAL committed fixture files, with no
 * browser.
 *
 * It exists because the Playwright journey and this one answer different
 * questions and neither substitutes for the other. Playwright proves the screens
 * wire up; this proves the PIPELINE — `read.ts` -> `prepare.ts` -> the data
 * source -> the outcome — over bytes that are actually on disk. It is also the
 * only thing that exercises `clean-40.xlsx`, `weak-keys.csv`,
 * `engine-columns.xlsx` and `big-2000.xlsx` at all: a fixture nothing reads is a
 * file that rots silently until the day somebody trusts it.
 *
 * It started life as a probe — five cases of `console.log` and a closing
 * `expect(true).toBe(true)`. That is the shape this repo bans outright: a test
 * that cannot fail is worse than no test, because it is counted. Every number
 * below was read off that probe's output and then turned into an assertion, and
 * each one was watched go red against a real mutant before being kept.
 *
 * What it deliberately does NOT cover: anything about the SCREENS (Playwright),
 * and anything about SQL (`tests/db/test_import.py`). The fixture store is a
 * faithful model of the migration, pinned by `import-fixture.test.ts` — this file
 * leans on that pin rather than re-proving it.
 */

function rawOf(cells: readonly Cell[]): Record<string, string> {
  const raw: Record<string, string> = {};
  cells.forEach((c, i) => {
    const t = cellText(c);
    if (t !== "") raw[String(i)] = t;
  });
  return raw;
}

async function upload(src: FixtureDataSource, name: string, key: string) {
  const bytes = readFileSync(join(DIR, name));
  const rows: Cell[][] = name.endsWith(".xlsx")
    ? (await readWorkbook(bytes))[0].rows
    : readDelimited(bytes).rows;
  const numbered = rows
    .map((cells, i) => ({ rowNumber: i + 1, cells }))
    .filter((r) => r.cells.some((c) => !isBlankCell(c)));
  const created = await src.createImport({
    filename: name,
    sourceKind: name.endsWith(".xlsx") ? "xlsx" : "csv",
    contentHash: "hash-" + name,
    rowCount: numbered.length,
    idempotencyKey: key,
  });
  if (!created.ok) throw new Error("createImport failed");
  const batchId = created.batch.id;
  for (let at = 0; at < numbered.length; at += 1000) {
    await src.stageImportRows({
      batchId,
      rows: numbered
        .slice(at, at + 1000)
        .map((r) => ({ rowNumber: r.rowNumber, raw: rawOf(r.cells) })),
    });
  }
  return batchId;
}

async function mapAndPreview(src: FixtureDataSource, batchId: string) {
  const found = await src.importBatch(batchId);
  if (!found) throw new Error("no batch");
  const guess = headerGuess(grid(found.rows));
  const model = mapModel(found.rows, guess.headerRowIndex);
  const columnMap: Record<string, number> = {};
  for (const [f, i] of Object.entries(model.suggestion)) if (i !== null) columnMap[f] = i;
  const statusMap: Record<string, string> = {};
  const col = columnMap.status;
  if (col !== undefined) {
    for (const v of model.statusColumns[col].values) {
      statusMap[v.value] = model.statusColumns[col].suggested[v.value].status;
    }
  }
  const mapped = mapRows(found.rows, guess.headerRowIndex, columnMap, statusMap);
  for (let at = 0; at < mapped.rows.length; at += 1000) {
    const final = at + 1000 >= mapped.rows.length;
    const res = await src.setImportMapping({
      batchId,
      rows: mapped.rows.slice(at, at + 1000),
      mapping: {
        headers: headersOf(found.rows, guess.headerRowIndex),
        headerRowIndex: guess.headerRowIndex,
        columnMap,
        statusMap,
        roundTrip: columnMap.hqId !== undefined && columnMap.hqVersion !== undefined,
        unmapped: unmappedFor(model.headers, columnMap),
      },
      final,
      expectedUpdatedAt: final ? found.batch.updatedAt : null,
    });
    if (!res.ok) throw new Error("setMapping: " + JSON.stringify(res));
  }
  if (mapped.excluded.length > 0) {
    await src.setImportRowsIncluded({ batchId, rowNumbers: mapped.excluded, included: false });
  }
  const preview = await src.previewImport(batchId);
  if (!preview.ok) throw new Error("preview: " + JSON.stringify(preview));
  return { preview, columnMap, statusMap, model };
}

async function commitAll(src: FixtureDataSource, batchId: string) {
  const tally = { created: 0, updated: 0, skipped: 0, failed: 0, chunks: 0 };
  for (let i = 0; i < 40; i += 1) {
    const res = await src.commitImportChunk({
      batchId,
      limit: 200,
      idempotencyKey: `${batchId}-chunk-${i}`,
    });
    if (!res.ok) throw new Error("commit: " + JSON.stringify(res));
    tally.created += res.created;
    tally.updated += res.updated;
    tally.skipped += res.skipped;
    tally.failed += res.failed;
    tally.chunks += 1;
    if (res.remaining === 0) break;
  }
  return tally;
}


describe("the whole journey, over the real fixture files", () => {
  it("clean-40.xlsx: 40 rows in, and a re-import adds none of them again (AC 20)", async () => {
    const src = new FixtureDataSource();
    const before = (await src.applications()).length;

    const batchId = await upload(src, "clean-40.xlsx", "k1");
    const { preview, model, statusMap } = await mapAndPreview(src, batchId);

    // 40 data rows plus the header, which the mapping excludes rather than
    // importing as an application called "Company".
    expect(preview.counts).toEqual({ new: 40, unkeyable: 1 });
    expect(preview.unresolved).toBe(0);

    // The status column is real data: four words this app knows and one it does
    // not. The unknown one goes to Inbox — an import may not mint a stage
    // (matrix row 43), and the file's own word is kept in the notes.
    expect(statusMap["Awaiting recruiter"]).toBe("Inbox");
    expect(statusMap.Applied).toBe("Applied");

    // The ambiguous-date sample the mapping screen warns on. `03/04/2026` is 3
    // April or 4 March and the file does not say which, so it is not a date.
    const appliedSamples = model.samples[3];
    expect(appliedSamples.find((s) => s.text === "03/04/2026")?.date).toBe(false);
    expect(appliedSamples.find((s) => s.text === "2026-02-02")?.date).toBe(true);

    expect(await commitAll(src, batchId)).toMatchObject({ created: 40, updated: 0, failed: 0 });
    expect((await src.applications()).length).toBe(before + 40);

    const again = await upload(src, "clean-40.xlsx", "k2");
    const second = await mapAndPreview(src, again);
    expect(second.preview.counts).toEqual({ "matches-existing": 40, unkeyable: 1 });
    expect(await commitAll(src, again)).toMatchObject({ created: 0, updated: 40 });
    expect((await src.applications()).length).toBe(before + 40);
  });

  it("clean-40.xlsx: undo takes back exactly what it added (AC 21)", async () => {
    const src = new FixtureDataSource();
    const before = (await src.applications()).length;
    const batchId = await upload(src, "clean-40.xlsx", "u-k1");
    await mapAndPreview(src, batchId);
    await commitAll(src, batchId);

    const undo = await src.undoImport({ batchId, idempotencyKey: "u1" });
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.deleted).toBe(40);
    expect(undo.kept).toBe(0);
    expect((await src.applications()).length).toBe(before);
  });

  it("clean-40.xlsx: a SECOND import moves the rows, so the first undo keeps them", async () => {
    // The half of row 33 that is easy to get backwards. Those rows were edited
    // after batch one wrote them — by batch two — so batch one's undo must leave
    // them alone and SAY it did, rather than deleting rows a later gesture owns.
    const src = new FixtureDataSource();
    const before = (await src.applications()).length;
    const first = await upload(src, "clean-40.xlsx", "kk1");
    await mapAndPreview(src, first);
    await commitAll(src, first);
    const second = await upload(src, "clean-40.xlsx", "kk2");
    await mapAndPreview(src, second);
    await commitAll(src, second);

    const undo = await src.undoImport({ batchId: first, idempotencyKey: "uu1" });
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.deleted).toBe(0);
    expect(undo.kept).toBe(40);
    expect(undo.keptIds.length).toBeGreaterThan(0);
    expect((await src.applications()).length).toBe(before + 40);
  });

  it("weak-keys.csv: a look-alike is flagged and added, never merged", async () => {
    const src = new FixtureDataSource();
    const stripeBefore = (await src.applications()).find((a) => a.company === "Stripe");
    expect(stripeBefore, "the fixture set must contain the row we refuse to merge into").toBeTruthy();

    const batchId = await upload(src, "weak-keys.csv", "w1");
    const { preview } = await mapAndPreview(src, batchId);
    expect(preview.counts).toEqual({ suggestion: 1, unkeyable: 2 });

    const rows = (await src.importBatch(batchId))!.rows;
    const suggested = rows.find((r) => r.matchKind === "suggestion")!;
    expect(suggested.keyStrength).toBe("weak");
    expect(suggested.jobKey.startsWith("norm-")).toBe(true);
    expect(suggested.notice).toMatch(/prove/);

    expect(await commitAll(src, batchId)).toMatchObject({ created: 2, updated: 0 });
    const stripe = (await src.applications()).filter((a) => a.company === "Stripe");
    // Two rows, not one merged row — and the original's status is untouched.
    expect(stripe.length).toBe(2);
    expect(stripe.find((a) => a.id === stripeBefore!.id)!.status).toBe(stripeBefore!.status);
  });

  it("engine-columns.xlsx: every column gets a verdict, and engine-owned ones are not written (G13)", async () => {
    const src = new FixtureDataSource();
    const batchId = await upload(src, "engine-columns.xlsx", "e1");
    const { model, columnMap } = await mapAndPreview(src, batchId);

    // The fixture has TWO columns called "Notes". Only one can feed the field,
    // and the mapping is by INDEX — a by-name lookup would pick one at random and
    // the loser would be silently not imported.
    expect(model.headers.filter((h) => h === "Notes").length).toBe(2);
    expect(typeof columnMap.notes).toBe("number");

    await commitAll(src, batchId);
    const report = await src.importReport(batchId);
    const at = (column: string, disposition: string) =>
      report.find((r) => r.column === column && r.disposition === disposition);

    expect(at("Company", "read-only")?.sample).toEqual(["Stripe Payments, Inc."]);
    expect(at("Title", "read-only")?.sample).toEqual(["PM - Billing Platform"]);
    // ONE, not two. The Stripe row's URL now AGREES with the application this
    // store already holds — the fixture applications carry real board links since
    // Prepare started reading them — and a column reaches this list only when the
    // file disagreed with what the engine owns. The sample names the row that
    // still does, so the number cannot drift into meaning nothing.
    expect(at("URL", "read-only")?.rows).toBe(1);
    expect(at("URL", "read-only")?.sample).toEqual([
      "https://boards.greenhouse.io/brex/jobs/7788991",
    ]);
    // The second "Notes" column, and a column this app has never heard of.
    expect(at("Notes", "unmapped")).toBeTruthy();
    expect(at("Recruiter", "unknown-column")).toBeTruthy();
    // One column, two verdicts — the line that says something did NOT land must
    // survive beside the line that says everything did.
    expect(at("Status", "imported")).toBeTruthy();
    expect(at("Status", "locked")?.sample).toEqual(["waiting on referral -> Offer"]);

    const apps = await src.applications();
    // The engine owns these, so the file's versions were compared and discarded.
    expect(apps.find((a) => a.id === 1)!.company).toBe("Stripe");
    expect(apps.find((a) => a.id === 1)!.title).not.toBe("PM - Billing Platform");
    // And the status a human had chosen is still theirs.
    expect(apps.find((a) => a.status === "waiting on referral")).toBeTruthy();
  });

  it("big-2000.xlsx: commits in chunks and lands every row (G12)", async () => {
    const src = new FixtureDataSource();
    const before = (await src.applications()).length;
    const batchId = await upload(src, "big-2000.xlsx", "b1");
    const { preview } = await mapAndPreview(src, batchId);
    expect(preview.counts.new).toBe(2000);

    const tally = await commitAll(src, batchId);
    expect(tally.created).toBe(2000);
    // 200 rows per transaction, so this cannot have been one big write.
    expect(tally.chunks).toBeGreaterThan(1);
    expect((await src.applications()).length).toBe(before + 2000);
  });

  it("a round-trip edit against a stale version blocks the commit, then writes only what was chosen (AC 23)", async () => {
    const src = new FixtureDataSource();
    const app = (await src.applications())[0];
    const notesBefore = (await src.notes(app.id)).length;
    const csv = [
      "Company,Title,Status,Notes,hq_id,hq_version",
      `"${app.company}","${app.title}",Final,"Panel moved to Friday",${app.id},2020-01-01T00:00:00.000Z`,
      "",
    ].join("\n");
    const rows = readDelimited(csv).rows;
    const created = await src.createImport({
      filename: "rt.csv", sourceKind: "csv", contentHash: "rt",
      rowCount: rows.length, idempotencyKey: "rt1",
    });
    if (!created.ok) throw new Error("no batch");
    const batchId = created.batch.id;
    await src.stageImportRows({
      batchId,
      rows: rows.map((cells, i) => ({ rowNumber: i + 1, raw: rawOf(cells) })),
    });

    const { preview } = await mapAndPreview(src, batchId);
    expect(preview.counts["round-trip"]).toBe(1);
    expect(preview.unresolved).toBe(1);

    const blocked = await src.commitImportChunk({
      batchId, limit: 200, idempotencyKey: "rt-c1",
    });
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.kind === "error" && blocked.message).toMatch(/unresolved/);
    // Refused means refused: nothing moved.
    expect((await src.applications()).find((a) => a.id === app.id)!.status).toBe(app.status);

    const resolved = await src.resolveImportRow({
      batchId, rowNumber: 2, choices: { status: "theirs", notes: "mine" },
    });
    expect(resolved.ok && resolved.unresolved).toBe(0);
    expect(await commitAll(src, batchId)).toMatchObject({ updated: 1 });

    const after = (await src.applications()).find((a) => a.id === app.id)!;
    expect(after.status).toBe("Final");
    // A round-trip status change carries the row's own token, so it claims the row.
    expect(after.statusActor).toBe("user");
    // "keep mine" on notes means the file's note was not appended at all.
    expect((await src.notes(app.id)).length).toBe(notesBefore);
  });

  /**
   * The loop, end to end, over a file this app WROTE rather than one a test typed.
   *
   * Every round-trip test above hand-builds its CSV, and for a whole phase that
   * was the only kind there was: `ROUND_TRIP_COLUMNS` had zero callers, the
   * export route emitted `APPLICATION_COLUMNS`, and nothing anywhere produced a
   * file carrying an `hq_id`. Both halves agreed with a hand-written third thing
   * instead of with each other, which is exactly how AC 23 came to be recorded as
   * discharged with half of it unbuilt.
   */
  it("an export of the pipeline imports back as the same rows (AC 23, both halves)", async () => {
    const src = new FixtureDataSource();
    const before = await src.applications();

    // The bytes the route would send for `{dataset: "applications", roundTrip: true}`.
    const csv = toCsv(before, ROUND_TRIP_COLUMNS);
    const rows = readDelimited(csv).rows;
    const created = await src.createImport({
      filename: "job-search-hq-applications-2026-07-26.csv",
      sourceKind: "csv",
      contentHash: "rt-export",
      rowCount: rows.length,
      idempotencyKey: "rt-export-1",
    });
    if (!created.ok) throw new Error("no batch");
    await src.stageImportRows({
      batchId: created.batch.id,
      rows: rows.map((cells, i) => ({ rowNumber: i + 1, raw: rawOf(cells) })),
    });

    const { preview, columnMap } = await mapAndPreview(src, created.batch.id);
    // The mapping recognised its own two columns, unprompted.
    expect(columnMap.hqId).toBeDefined();
    expect(columnMap.hqVersion).toBeDefined();

    // EVERY row comes back as itself. Not "new", which is what an export missing
    // its id columns produces — and what a user would see as their pipeline
    // doubling.
    expect(preview.counts["round-trip"]).toBe(before.length);
    expect(preview.counts.new ?? 0).toBe(0);
    // Nothing changed between export and import, so nothing to answer. The token
    // is the row's own `updated_at`, so a comparison that were merely a string
    // compare of two renderings of the same instant would show up right here.
    expect(preview.unresolved).toBe(0);

    await commitAll(src, created.batch.id);
    const after = await src.applications();
    expect(after.length, "a round trip added rows").toBe(before.length);
    expect(after.map((a) => a.id)).toEqual(before.map((a) => a.id));

    // Every row whose status is a word this app HAS comes back as itself —
    // `normalizeStatus` folds our own spellings, which is what makes
    // `Offer-Accepted` survive the trip instead of collapsing.
    const canonical = before.filter((a) => isCanonicalStatus(a.status));
    expect(canonical.length).toBeGreaterThan(0);
    for (const was of canonical) {
      expect(after.find((a) => a.id === was.id)!.status, `${was.company} moved`).toBe(was.status);
    }

    // KNOWN DEFECT, pinned here rather than asserted away, and found by writing
    // this test: a round trip is NOT value-preserving for a status a person
    // invented. `waiting on referral` exports verbatim, the status map cannot
    // express it (the vocabulary is closed on purpose — matrix row 43, a
    // spreadsheet cell may not mint a stage), so it maps to Inbox; and because
    // the file carries the row's own fresh token the round-trip exception writes
    // it back as a human gesture. Export your pipeline, import it back untouched,
    // and that row silently moves to the start of the ladder.
    //
    // The mapping does what it is supposed to and the commit does what it is
    // supposed to; the combination loses data. Asserted as-is so it cannot get
    // quietly worse, and so the fix has a test waiting for it.
    const invented = before.filter((a) => !isCanonicalStatus(a.status));
    for (const was of invented) {
      expect(after.find((a) => a.id === was.id)!.status).toBe("Inbox");
    }
  });
});
