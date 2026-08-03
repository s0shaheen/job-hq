import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The claims `docs/plans/TRACKER-LANE-DISPOSITION.md` rests on, pinned.
 *
 * That document decides whether five `tracker/` lanes are deleted, ported or
 * parked, and two of its verdicts turn entirely on whether the web app already
 * does the lane's job. "The web app's triage is the analogue" and "the web
 * app's add/paste is the analogue" were written in `SHEET-INVENTORY.md` as the
 * same kind of claim; one is true and one is not, and nothing in the repo could
 * tell them apart.
 *
 * A deletion decided by a claim nobody can re-check is a deletion decided once.
 * These are cheap because the answers are all in source: an RPC body, a
 * placeholder page, and a validation branch in the importer. If any of them
 * changes, the disposition changes with it, and this file is where that
 * surfaces.
 *
 * Deliberately source-level rather than behavioural. The behaviour of
 * `app_set_triage` is covered by `tests/db`; what is unpinned is the narrower
 * question of whether the capability EXISTS at all — which is what a delete-or-
 * port decision needs and what no behavioural test asserts, because you cannot
 * write a test for a surface that is not there.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (...parts: string[]) => readFileSync(path.join(REPO, ...parts), "utf8");

const WRITE_PATH_SQL = read("db", "migrations", "0003_write_path.sql");
const IMPORT_SQL = read("db", "migrations", "0011_import.sql");
const ADD_PAGE = read("webapp", "app", "(app)", "add", "page.tsx");
const NAV = read("webapp", "app", "(app)", "nav-links.tsx");
const DATA_SOURCE = read("webapp", "lib", "data", "source.ts");

describe("tracker/promote.py has an analogue: app_set_triage", () => {
  /**
   * promote.py's two live branches are "interested -> append a Queued Pipeline
   * row" and "un-ticked -> delete it, but only while still Queued". Both exist
   * in the RPC. This is the evidence for PARK-then-delete rather than PORT: a
   * port would be a second implementation of a command that already ships.
   */
  it("creates the Queued application when the triage is interested", () => {
    expect(WRITE_PATH_SQL).toContain("if p_triage = 'interested' then");
    expect(WRITE_PATH_SQL).toContain(
      "insert into public.applications (user_id, posting_key, company, title, url, status)",
    );
    // The status the row is born in. promote.py appends `status: "Queued"`.
    expect(WRITE_PATH_SQL).toMatch(/select v_user, p\.key,[\s\S]{0,120}'Queued'/);
  });

  it("removes it again on any move away from interested, while still Queued", () => {
    expect(WRITE_PATH_SQL).toContain("if p_triage <> 'interested' then");
    expect(WRITE_PATH_SQL).toMatch(
      /delete from public\.applications[\s\S]{0,200}and status = 'Queued'/,
    );
  });
});

describe("tracker/quickadd.py has NO analogue", () => {
  /**
   * The load-bearing one. If this file ever goes green while `/add` is a real
   * surface, the Quick Add lane becomes deletable and the disposition's PORT
   * verdict is stale — which is exactly the state this test exists to catch.
   */
  it("the Add page is a placeholder that directs the user to the Quick Add tab", () => {
    expect(ADD_PAGE).toContain("Quick Add tab of the HQ sheet");
    expect(ADD_PAGE).toContain("isn't built here yet");
  });

  it("the nav marks the route as not yet built", () => {
    expect(NAV).toMatch(/href: "\/add"[^}]*soon: true/);
  });

  it("no DataSource method ingests a pasted URL", () => {
    // Method names on the interface, e.g. `  setTriage(input: ...)`.
    const methods = [...DATA_SOURCE.matchAll(/^ {2}([a-zA-Z]+)\(/gm)].map((m) => m[1]);
    expect(methods).toContain("setTriage"); // the extraction works at all
    expect(methods.filter((m) => /^(add|quick|paste|fetch|ingest)/i.test(m))).toEqual([
      "addNote",
    ]);
  });

  it("the CSV importer is not the analogue: it requires a company AND a title", () => {
    // quickadd's premise is the opposite — the row is created from the URL
    // alone, even when extraction returns nothing.
    expect(IMPORT_SQL).toContain("a row needs both a company and a title");
  });
});
