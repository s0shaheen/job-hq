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
const FIXTURE_SOURCE = read("webapp", "lib", "data", "fixture-source.ts");
const SUPABASE_SOURCE = read("webapp", "lib", "data", "supabase-source.ts");
const QUICK_ADD = read("webapp", "app", "(app)", "add", "quick-add.tsx");
const ADD_ACTIONS = read("webapp", "app", "(app)", "add", "actions.ts");

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

describe("tracker/quickadd.py HAS an analogue now", () => {
  /**
   * The load-bearing one, inverted — and the inversion is the deliverable.
   *
   * This block asserted the placeholder for as long as the placeholder was the
   * reason `TRACKER-LANE-DISPOSITION.md` marked `quickadd` PORT rather than
   * PARK: "the web app's Add page is an explicit placeholder that tells the
   * user to use the Quick Add tab. There is no analogue." A surface that
   * shipped while these assertions still described a placeholder would have
   * left the disposition stale in the safe-looking direction — the lane kept
   * alive by a document nobody re-derived.
   *
   * It is still a source-level test, for the reason the file header gives: the
   * question a delete-or-port decision needs answered is whether the capability
   * EXISTS, and no behavioural test can be written for a surface that is not
   * there. The behaviour is covered by `tests/e2e/quickadd.spec.ts`.
   *
   * What this does NOT license: deleting `tracker/quickadd.py`. The lane still
   * reads the sheet's Quick Add tab, and `tests/core/test_sheet_containment.py`
   * still lists it. What has gone is the reason it could not be retired.
   */
  it("the Add page carries no instruction to use the sheet", () => {
    expect(ADD_PAGE).not.toContain("Quick Add tab of the HQ sheet");
    expect(ADD_PAGE).not.toContain("isn't built here yet");
    // Belt and braces on the whole class, not just the one sentence: no live
    // surface may tell a user to open a spreadsheet.
    expect(ADD_PAGE).not.toMatch(/paste .{0,40}(sheet|spreadsheet)/i);
  });

  it("the nav no longer marks the route as not yet built", () => {
    expect(NAV).toMatch(/href: "\/add"/);
    expect(NAV).not.toMatch(/href: "\/add"[^}]*soon: true/);
  });

  it("the DataSource ingests a pasted URL, in both implementations", () => {
    // Method names on the interface, e.g. `  setTriage(input: ...)`.
    const methods = [...DATA_SOURCE.matchAll(/^ {2}([a-zA-Z]+)\(/gm)].map((m) => m[1]);
    expect(methods).toContain("setTriage"); // the extraction works at all
    expect(methods).toContain("addJob");
    expect(methods).toContain("resolveJobLinks");
    for (const impl of [FIXTURE_SOURCE, SUPABASE_SOURCE]) {
      expect(impl).toMatch(/async addJob\(/);
      expect(impl).toMatch(/async resolveJobLinks\(/);
    }
  });

  it("keeps the lane's three load-bearing behaviours", () => {
    // 1. The row is created even when extraction fails — the URL is the
    //    valuable part. The surface says so in the owner's words.
    expect(QUICK_ADD).toContain("The link is saved; details fill in on");
    // 2. A duplicate is REPORTED, never resolved by guessing.
    expect(QUICK_ADD).toContain("Already tracked.");
    // 3. Extraction is never accepted silently: the fields are editable and
    //    their provenance is on screen.
    expect(QUICK_ADD).toContain("provenance(draft)");
  });

  it("the CSV importer is still not the analogue: it requires a company AND a title", () => {
    // quickadd's premise is the opposite — the row is created from the URL
    // alone, even when extraction returns nothing — and the new surface keeps
    // it: `addJobAction` refuses only when there is neither a link nor a name.
    expect(IMPORT_SQL).toContain("a row needs both a company and a title");
    expect(ADD_ACTIONS).toContain("Add a link, or a company and a title.");
  });
});
