import { beforeEach, describe, expect, it } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import { FIXTURE_APPLICATIONS } from "@/lib/data/fixtures";
import { APPLICATION_COLUMNS } from "@/lib/export/columns";
import { blankTrim, exportNote, noteAuthorLabel } from "@/lib/data/view-models";
import type { ApplicationView } from "@/lib/data/view-models";

/**
 * Notes as an append-only entity (migration 0010).
 *
 * `applications.notes` was one text column with no history, so the second note
 * overwrote the first with no trace — matrix row 43. The fix has two halves that
 * both need proving: the history is kept (here), and the export column that
 * reads the OLD flat column did not go blank when the entity arrived (row 44,
 * the last describe block).
 */

const PLAID = 2;          // notes: null in the fixture set
const STRIPE = 1;         // notes: "Recruiter screen went well. Panel is 3 rounds."

let src: FixtureDataSource;
let seq = 0;
const idem = () => `note-key-${++seq}`;

beforeEach(() => {
  src = new FixtureDataSource();
  seq = 0;
});

async function get(id: number): Promise<ApplicationView> {
  const row = (await src.applications()).find((a) => a.id === id);
  if (!row) throw new Error(`no fixture application ${id}`);
  return row;
}

describe("addNote", () => {
  it("appends, and the first note survives the second verbatim", async () => {
    await src.addNote({ applicationId: PLAID, body: "Panel is 3 rounds", idempotencyKey: idem() });
    await src.addNote({ applicationId: PLAID, body: "Moved to Thursday", idempotencyKey: idem() });

    const notes = await src.notes(PLAID);
    expect(notes.map((n) => n.body)).toEqual(["Moved to Thursday", "Panel is 3 rounds"]);
    // Verbatim, not merely present: the failure this replaces was a silent
    // overwrite, so identity of the older row is the assertion that matters.
    expect(notes[1].body).toBe("Panel is 3 rounds");
  });

  it("reads newest-first, which is what the dialog and latestNote both take", async () => {
    await src.addNote({ applicationId: PLAID, body: "first", idempotencyKey: idem() });
    await src.addNote({ applicationId: PLAID, body: "second", idempotencyKey: idem() });
    const row = await get(PLAID);
    expect(row.latestNote?.body).toBe("second");
    expect((await src.notes(PLAID))[0].body).toBe("second");
  });

  it("keeps noteCount in step with the history", async () => {
    expect((await get(PLAID)).noteCount).toBe(0);
    await src.addNote({ applicationId: PLAID, body: "one", idempotencyKey: idem() });
    expect((await get(PLAID)).noteCount).toBe(1);
    await src.addNote({ applicationId: PLAID, body: "two", idempotencyKey: idem() });
    expect((await get(PLAID)).noteCount).toBe(2);
  });

  it("refuses an empty body before any write", async () => {
    for (const body of ["", "   "]) {
      const res = await src.addNote({ applicationId: PLAID, body, idempotencyKey: idem() });
      expect(res.ok).toBe(false);
      if (!res.ok && res.kind === "error") expect(res.message).toMatch(/something in it/i);
    }
    expect(await src.notes(PLAID)).toEqual([]);
  });

  it("refuses a body that is only tabs and newlines", async () => {
    // The bug this exists for: SQL's bare `btrim(x)` trims SPACES ONLY, so
    // `btrim(E'\n\t')` is not '' and a note of one newline passed every
    // emptiness check into a table that cannot delete it. Found by running the
    // migration, not by reading it.
    for (const body of ["\n", "\t", "\n\t\r ", " ", "​"]) {
      const res = await src.addNote({ applicationId: PLAID, body, idempotencyKey: idem() });
      expect(res.ok, JSON.stringify(body)).toBe(false);
    }
    expect(await src.notes(PLAID)).toEqual([]);
  });

  it("refuses an oversized body", async () => {
    const res = await src.addNote({
      applicationId: PLAID,
      body: "x".repeat(4001),
      idempotencyKey: idem(),
    });
    expect(res.ok).toBe(false);
  });

  it("does not bump the application's version token", async () => {
    // A note is not a change to the application row. Bumping updatedAt would
    // invalidate every open tab's token and produce a phantom conflict on the
    // next real gesture — for typing a comment.
    const before = await get(PLAID);
    await src.addNote({ applicationId: PLAID, body: "hello", idempotencyKey: idem() });
    expect((await get(PLAID)).updatedAt).toBe(before.updatedAt);
  });

  it("writes once when replayed under the same key", async () => {
    const key = idem();
    await src.addNote({ applicationId: PLAID, body: "once", idempotencyKey: key });
    await src.addNote({ applicationId: PLAID, body: "once", idempotencyKey: key });
    expect((await src.notes(PLAID)).length).toBe(1);
  });

  it("reports an unknown application rather than inventing a history for it", async () => {
    const res = await src.addNote({ applicationId: 9999, body: "x", idempotencyKey: idem() });
    expect(res.ok).toBe(false);
    expect(await src.notes(9999)).toEqual([]);
  });

  it("keeps each application's history to itself", async () => {
    await src.addNote({ applicationId: PLAID, body: "plaid only", idempotencyKey: idem() });
    expect((await src.notes(STRIPE)).some((n) => n.body === "plaid only")).toBe(false);
  });
});

describe("the 0010 backfill, as the fake reproduces it", () => {
  it("seeds one import-authored note per non-empty flat column", async () => {
    // Without this the fake starts with an empty history for rows that visibly
    // have a note, so the dialog's populated state is unreachable through the
    // only source the tests can drive — matrix row 15's failure on a new surface.
    const notes = await src.notes(STRIPE);
    expect(notes.length).toBe(1);
    expect(notes[0].author).toBe("import");
    expect(notes[0].body).toBe("Recruiter screen went well. Panel is 3 rounds.");
  });

  it("leaves the flat column in place", async () => {
    expect((await get(STRIPE)).notes).toBe("Recruiter screen went well. Panel is 3 rounds.");
  });

  it("seeds nothing for a row whose column is empty", async () => {
    expect(await src.notes(PLAID)).toEqual([]);
  });
});

describe("noteAuthorLabel", () => {
  it("names the four authors the schema documents", () => {
    expect(noteAuthorLabel("user")).toBe("you");
    expect(noteAuthorLabel("import")).toBe("imported");
    expect(noteAuthorLabel("scout")).toBe("the scout");
    expect(noteAuthorLabel("system")).toBe("the system");
  });

  it("renders an unrecognised author verbatim rather than hiding it", () => {
    // `author` has no CHECK for the same reason `companies.source` has none: a
    // future writer may legitimately mint a tag, and hiding it loses provenance.
    expect(noteAuthorLabel("digest-bot")).toBe("digest-bot");
    expect(noteAuthorLabel("")).toBe("unknown");
  });
});

describe("blankTrim — the mirror of hq_blank_trim", () => {
  it("treats tabs and newlines as blank, which bare btrim does not", () => {
    expect(blankTrim("\n\t ")).toBe("");
    expect(blankTrim("  hello  ")).toBe("hello");
    expect(blankTrim("\n hello \t")).toBe("hello");
  });

  it("treats unicode separators and zero-widths as blank", () => {
    // 0008's lesson: a string pasted out of a web page carries NBSP, which is
    // not whitespace to btrim() either.
    expect(blankTrim(" ")).toBe("");
    expect(blankTrim("　 ")).toBe("");
    expect(blankTrim("​")).toBe("");
  });

  it("does not touch the interior of a string", () => {
    // Trim, not collapse: "a  b" is what the person typed.
    expect(blankTrim("a  b")).toBe("a  b");
    expect(blankTrim(" a\nb ")).toBe("a\nb");
  });

  it("handles null and undefined", () => {
    expect(blankTrim(null)).toBe("");
    expect(blankTrim(undefined)).toBe("");
  });
});

// ------------------------------------------------------------ matrix row 44

describe("the export column the backfill could have blanked", () => {
  const columnFor = (a: ApplicationView) =>
    APPLICATION_COLUMNS.find((c) => c.key === "notes")!.value(a);

  const base = FIXTURE_APPLICATIONS[0];

  it("still reads the flat column on a row that predates the migration", () => {
    // The BEFORE state: a column, no notes entity. This is the read that would
    // have gone blank if 0010 had cleared the column.
    const preMigration: ApplicationView = {
      ...base,
      notes: "Auto-rejection 3 weeks after applying.",
      noteCount: 0,
      latestNote: null,
    };
    expect(columnFor(preMigration)).toBe("Auto-rejection 3 weeks after applying.");
  });

  it("reads the same text through the entity once backfilled", () => {
    // The AFTER state: both populated, same value. The exported bytes do not
    // change on the day the migration runs, which is the actual promise.
    const backfilled: ApplicationView = {
      ...base,
      notes: "Auto-rejection 3 weeks after applying.",
      noteCount: 1,
      latestNote: {
        id: 1,
        body: "Auto-rejection 3 weeks after applying.",
        author: "import",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    };
    expect(columnFor(backfilled)).toBe("Auto-rejection 3 weeks after applying.");
  });

  it("prefers the newest note once the history has moved past the column", () => {
    const moved: ApplicationView = {
      ...base,
      notes: "Auto-rejection 3 weeks after applying.",
      noteCount: 2,
      latestNote: {
        id: 2,
        body: "Recruiter reopened it.",
        author: "user",
        createdAt: "2026-07-20T00:00:00.000Z",
      },
    };
    expect(columnFor(moved)).toBe("Recruiter reopened it.");
  });

  it("is null, not empty string, when there is nothing to say", () => {
    // Consumers write different fallbacks for the two, and the XLSX writer
    // treats them differently.
    expect(columnFor({ ...base, notes: null, noteCount: 0, latestNote: null })).toBeNull();
    expect(columnFor({ ...base, notes: "   ", noteCount: 0, latestNote: null })).toBeNull();
  });

  it("falls back to the column when the newest note is somehow blank", () => {
    // Belt and braces: the table's CHECK makes a blank body impossible, but a
    // reader that returned "" here would silently drop a real column value.
    const odd: ApplicationView = {
      ...base,
      notes: "the column still has this",
      noteCount: 1,
      latestNote: { id: 1, body: "   ", author: "user", createdAt: null },
    };
    expect(exportNote(odd)).toBe("the column still has this");
  });

  it("keeps the column set unchanged — no header moved or was added", () => {
    // The export's shape is a contract with every spreadsheet already open on
    // someone's machine; changing what "Notes" MEANS is allowed, changing where
    // it sits is not.
    expect(APPLICATION_COLUMNS.map((c) => c.header)).toEqual([
      "Company",
      "Title",
      "Status",
      "Applied",
      "Next action",
      "Next action date",
      "Notes",
      "URL",
    ]);
  });
});
