import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_COMPANIES } from "@/lib/data/company-fixtures";
import { FIXTURE_CONNECTIONS } from "@/lib/data/connection-fixtures";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import { MAX_CONNECTION_CHUNK, type ConnectionImportRow } from "@/lib/data/source";

/**
 * The referral half of the fixture store, compared against migration 0013.
 *
 * The demo and the whole E2E journey run against this fake, so a fake that
 * succeeds where Postgres refuses ships a paste box and an upload whose blocked
 * states nobody has ever seen. `docs/WEBAPP-BUILD.md` records what that has cost
 * four times already — the auto-growing sheet grid, the unconditional health
 * fixture, the store that existed three times over, and the three import
 * divergences of matrix row 172.
 *
 * Every rule below is a rule `0013_referral.sql` enforces. `parity.test.ts` pins
 * the numbers and the words to the migration text; this file proves the fake
 * BEHAVES the way those words describe.
 */

const RAMP = FIXTURE_COMPANIES.find((c) => c.name === "Ramp")!;
const DATABRICKS = FIXTURE_COMPANIES.find((c) => c.name === "Databricks")!;

let src: FixtureDataSource;
let seq = 0;
const idem = () => `conn-${++seq}`;

beforeEach(() => {
  src = new FixtureDataSource();
});

/** A store with no connections at all — day one for every user. */
function emptyStore(): FixtureDataSource {
  return new FixtureDataSource(undefined, undefined, undefined, undefined, undefined, []);
}

function row(over: Partial<ConnectionImportRow> = {}): ConnectionImportRow {
  return {
    fullName: "",
    firstName: "",
    lastName: "",
    company: "",
    title: "",
    profileUrl: "",
    connectedOn: null,
    ...over,
  };
}

// ------------------------------------------------------- setLinkedinCompanyId

describe("setLinkedinCompanyId", () => {
  it("writes the id onto a company this user watches", () => {
    return src
      .setLinkedinCompanyId({
        companyId: RAMP.id,
        linkedinId: "1035",
        idempotencyKey: idem(),
        expectedUpdatedAt: RAMP.companyUpdatedAt,
      })
      .then(async (res) => {
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error("unreachable");
        expect(res.company.linkedinCompanyId).toBe("1035");
        // The write is visible on the next read, not only in the returned row.
        const stored = (await src.companies()).find((c) => c.id === RAMP.id);
        expect(stored!.linkedinCompanyId).toBe("1035");
        // And the SHARED row's token moved, so the next writer has to hold the
        // new one. Mutant: leave `companyUpdatedAt` alone on a real change —
        // two devices then both pass their conflict check.
        expect(stored!.companyUpdatedAt).not.toBe(RAMP.companyUpdatedAt);
        // …while the SUBSCRIPTION's token is untouched: they guard different
        // writes, and bumping the wrong one invalidates every open /companies tab.
        expect(stored!.updatedAt).toBe(RAMP.updatedAt);
      });
  });

  it("refuses anything that is not digits — including javascript:1", async () => {
    // The ANCHORING case, and the mutant this test exists to be red for: an
    // unanchored `/[0-9]{1,20}/` matches the `1` inside `javascript:1` and lets
    // the whole string through, which is the same anchoring bug 0010's blank-trim
    // paid for from the other direction. The SQL is anchored (`'^[0-9]{1,20}$'`);
    // a fake that was not would let the UI paste a value Postgres refuses.
    for (const bad of ["javascript:1", "1035; DROP", "ramp", "10 35", "1".repeat(21)]) {
      const res = await src.setLinkedinCompanyId({
        companyId: RAMP.id,
        linkedinId: bad,
        idempotencyKey: idem(),
        expectedUpdatedAt: null,
      });
      expect(res, bad).toMatchObject({ ok: false, kind: "error" });
      if (res.ok || res.kind !== "error") throw new Error("unreachable");
      expect(res.message).toContain("digits only");
    }
    // The positive control: 20 digits — the bound itself — is accepted, so the
    // loop above is about the pattern and not about the fake refusing everything.
    const ok = await src.setLinkedinCompanyId({
      companyId: RAMP.id,
      linkedinId: "1".repeat(20),
      idempotencyKey: idem(),
      expectedUpdatedAt: null,
    });
    expect(ok.ok).toBe(true);
  });

  it("leaves the row alone when it refuses", async () => {
    await src.setLinkedinCompanyId({
      companyId: RAMP.id,
      linkedinId: "javascript:1",
      idempotencyKey: idem(),
      expectedUpdatedAt: null,
    });
    const stored = (await src.companies()).find((c) => c.id === RAMP.id);
    expect(stored!.linkedinCompanyId).toBe(RAMP.linkedinCompanyId);
    expect(stored!.companyUpdatedAt).toBe(RAMP.companyUpdatedAt);
  });

  it("clears the id when sent an empty string", async () => {
    // The one non-digit value the closed set allows, because "I pasted the wrong
    // number" needs an undo that is not a support ticket.
    expect(DATABRICKS.linkedinCompanyId).not.toBe(""); // positive control
    const res = await src.setLinkedinCompanyId({
      companyId: DATABRICKS.id,
      linkedinId: "",
      idempotencyKey: idem(),
      expectedUpdatedAt: null,
    });
    expect(res.ok && res.company.linkedinCompanyId).toBe("");
    // A cell holding one space is blank to a person and length 1 to Postgres;
    // `hq_blank_trim` is the mirror the fake uses, so this clears too.
    const again = await src.setLinkedinCompanyId({
      companyId: RAMP.id,
      linkedinId: "   ",
      idempotencyKey: idem(),
      expectedUpdatedAt: null,
    });
    expect(again.ok && again.company.linkedinCompanyId).toBe("");
  });

  it("conflicts on a stale token and hands back the server's row", async () => {
    const first = await src.setLinkedinCompanyId({
      companyId: RAMP.id,
      linkedinId: "1035",
      idempotencyKey: idem(),
      expectedUpdatedAt: RAMP.companyUpdatedAt,
    });
    expect(first.ok).toBe(true);

    // A second device still holding the token it read before the first write.
    const stale = await src.setLinkedinCompanyId({
      companyId: RAMP.id,
      linkedinId: "9999",
      idempotencyKey: idem(),
      expectedUpdatedAt: RAMP.companyUpdatedAt,
    });
    expect(stale).toMatchObject({ ok: false, kind: "conflict" });
    if (stale.ok || stale.kind !== "conflict") throw new Error("unreachable");
    // The current row comes back, so the UI can show what it lost to rather than
    // saying "try again" over a value nobody can see.
    expect(stale.current.linkedinCompanyId).toBe("1035");
    expect((await src.companies()).find((c) => c.id === RAMP.id)!.linkedinCompanyId).toBe("1035");
  });

  it("CONFLICTS when sent the subscription's token instead of the company's", async () => {
    // The whole reason the two are named apart in `CompanyView`. Two tokens ride
    // on one grid row — `updatedAt` (the per-user subscription) and
    // `companyUpdatedAt` (the shared company row) — and they guard different
    // writes. `company-fixtures.ts` gives them DIFFERENT values on purpose so
    // this is reachable: if they were equal, a caller sending the wrong one would
    // work in the demo and conflict in production.
    expect(RAMP.updatedAt).not.toBe(RAMP.companyUpdatedAt); // the fixture's promise
    const res = await src.setLinkedinCompanyId({
      companyId: RAMP.id,
      linkedinId: "1035",
      idempotencyKey: idem(),
      expectedUpdatedAt: RAMP.updatedAt, // the WRONG token
    });
    // Mutant: check `current.updatedAt` in the fake instead of
    // `current.companyUpdatedAt`. This flips to ok and nothing else notices.
    expect(res).toMatchObject({ ok: false, kind: "conflict" });
  });

  it("skips the check entirely on a null token, for a first write", async () => {
    const res = await src.setLinkedinCompanyId({
      companyId: RAMP.id,
      linkedinId: "1035",
      idempotencyKey: idem(),
      expectedUpdatedAt: null,
    });
    expect(res.ok).toBe(true);
  });

  it("does not move the token for a write that changes nothing", async () => {
    // 0006's rule, applied to the shared row: re-pasting the id already there
    // must not invalidate every other tab's token for a row nothing changed.
    const res = await src.setLinkedinCompanyId({
      companyId: RAMP.id,
      linkedinId: RAMP.linkedinCompanyId,
      idempotencyKey: idem(),
      expectedUpdatedAt: RAMP.companyUpdatedAt,
    });
    expect(res.ok && res.company.companyUpdatedAt).toBe(RAMP.companyUpdatedAt);
  });

  it("refuses a company this user does not watch, with the migration's own words", async () => {
    // `app_set_linkedin_company_id`'s door. The column is SHARED, so the door is
    // the only thing standing between "a fact about a company" and "anybody can
    // write any company's row".
    const res = await src.setLinkedinCompanyId({
      companyId: 999_999,
      linkedinId: "1035",
      idempotencyKey: idem(),
      expectedUpdatedAt: null,
    });
    expect(res).toMatchObject({ ok: false, kind: "error" });
    if (res.ok || res.kind !== "error") throw new Error("unreachable");
    expect(res.message).toContain("no such company for this user");
  });

  it("replays one key rather than applying a second intent under it", async () => {
    const key = idem();
    const first = await src.setLinkedinCompanyId({
      companyId: RAMP.id,
      linkedinId: "1035",
      idempotencyKey: key,
      expectedUpdatedAt: null,
    });
    const again = await src.setLinkedinCompanyId({
      companyId: RAMP.id,
      linkedinId: "7777", // different intent, same key — a double-tap or an outbox flush
      idempotencyKey: key,
      expectedUpdatedAt: null,
    });
    expect(again).toEqual(first);
    expect((await src.companies()).find((c) => c.id === RAMP.id)!.linkedinCompanyId).toBe("1035");
  });

  it("honours failNextWrite, so the UI's failure path is exercisable", async () => {
    // Matrix row 99: `failNextWrite()` sat with ZERO CALLERS while rows 8 and 9
    // were both marked done. A capability nothing exercises is a capability that
    // does not work.
    src.failNextWrite("Network unavailable");
    const failed = await src.setLinkedinCompanyId({
      companyId: RAMP.id,
      linkedinId: "1035",
      idempotencyKey: idem(),
      expectedUpdatedAt: null,
    });
    expect(failed).toMatchObject({ ok: false, kind: "error", message: "Network unavailable" });
    expect((await src.companies()).find((c) => c.id === RAMP.id)!.linkedinCompanyId).toBe(
      RAMP.linkedinCompanyId,
    );
    // …and it is armed for exactly ONE write, or a demo would be stuck failing.
    const next = await src.setLinkedinCompanyId({
      companyId: RAMP.id,
      linkedinId: "1035",
      idempotencyKey: idem(),
      expectedUpdatedAt: null,
    });
    expect(next.ok).toBe(true);
  });

  // ---- provenance (0016) -------------------------------------------------

  it("stamps every write as a person's, including a clear", async () => {
    // The tombstone. `hq_fill_linkedin_company_id` refuses a company whose source is
    // 'human' EVEN WHEN THE CELL IS BLANK, which is what makes "the sweep's id is
    // wrong and I have no better one" an answer that survives the next cron. A fake
    // that cleared the value without stamping the source would show the clear
    // sticking in the demo and the harvest undoing it in production.
    const cleared = await src.setLinkedinCompanyId({
      companyId: DATABRICKS.id,
      linkedinId: "",
      idempotencyKey: idem(),
      expectedUpdatedAt: null,
    });
    expect(cleared.ok && cleared.company.linkedinCompanyId).toBe("");
    expect(cleared.ok && cleared.company.linkedinIdSource).toBe("human");
  });

  it("re-pasting the id the SWEEP found is a claim, not a no-op", async () => {
    // MUTATION REASON: drop `&& current.linkedinIdSource === "human"` from the
    // fixture's no-op branch — the mirror of the SQL's `v_before is distinct from
    // v_id OR v_row.linkedin_id_source <> 'human'` — and this is the only test that
    // fails. Every one of the 1391 vitest tests and all 44 referral e2e stay green
    // without it, which is precisely the shape of "the fake is kinder than the real
    // thing" this file's own preamble was written about.
    //
    // What the divergence would cost: somebody looks at the number the sweep found,
    // agrees with it, re-pastes it to make it theirs — and the row stays engine-owned,
    // so the next harvest is still free to overwrite it. The gesture LOOKS like it
    // worked. Databricks' fixture id came from the sweep, which is what makes this
    // reachable at all.
    expect(DATABRICKS.linkedinIdSource).toBe("engine");
    const claimed = await src.setLinkedinCompanyId({
      companyId: DATABRICKS.id,
      linkedinId: DATABRICKS.linkedinCompanyId, // the SAME value
      idempotencyKey: idem(),
      expectedUpdatedAt: null,
    });
    expect(claimed.ok && claimed.company.linkedinCompanyId).toBe(DATABRICKS.linkedinCompanyId);
    expect(claimed.ok && claimed.company.linkedinIdSource).toBe("human");
    // The row really changed, so its token moved — the SQL's `update … returning`
    // fires on this branch too, and a tab holding the old token conflicts truthfully.
    expect(claimed.ok && claimed.company.companyUpdatedAt).not.toBe(
      DATABRICKS.companyUpdatedAt,
    );
    const stored = (await src.companies()).find((c) => c.id === DATABRICKS.id);
    expect(stored!.linkedinIdSource).toBe("human");
  });

  it("re-pasting your OWN id is still a no-op that leaves the token alone", async () => {
    // The other half, and the reason the clause is `&&` rather than a replacement:
    // 0013's no-op rule survives for the case it was written for. Bumping the token
    // here would invalidate every other tab's token for a row nothing changed —
    // 0013's own words, and matrix row 96's whole subject.
    expect(RAMP.linkedinIdSource).toBe("human");
    const noop = await src.setLinkedinCompanyId({
      companyId: RAMP.id,
      linkedinId: RAMP.linkedinCompanyId,
      idempotencyKey: idem(),
      expectedUpdatedAt: null,
    });
    expect(noop.ok && noop.company.companyUpdatedAt).toBe(RAMP.companyUpdatedAt);
    expect(noop.ok && noop.company.linkedinIdSource).toBe("human");
  });
});

// ------------------------------------------------------------ importConnections

describe("importConnections", () => {
  it("inserts new people", async () => {
    const store = emptyStore();
    const res = await store.importConnections({
      rows: [
        row({ fullName: "Ada Okonkwo", company: "Ramp", title: "PM", profileUrl: "https://www.linkedin.com/in/ada", connectedOn: "2024-03-11" }),
        row({ fullName: "Bo Lindqvist", company: "Ramp", title: "EM" }),
      ],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    expect(res).toEqual({ ok: true, inserted: 2, updated: 0, skipped: 0, deduped: 0 });
    expect((await store.connections()).map((c) => c.fullName)).toEqual([
      "Ada Okonkwo",
      "Bo Lindqvist",
    ]);
  });

  it("MERGES a re-import instead of duplicating it", async () => {
    // Re-importing the export every month is the usage pattern, not the corner.
    // Mutant: drop the `existing` lookup and always insert — the store doubles
    // every month and every popover lists everybody twice.
    const store = emptyStore();
    const first = row({
      fullName: "Ada Okonkwo",
      company: "Ramp",
      title: "PM",
      profileUrl: "https://www.linkedin.com/in/ada",
    });
    await store.importConnections({ rows: [first], source: "linkedin-export", idempotencyKey: idem() });
    const again = await store.importConnections({
      rows: [{ ...first, title: "Head of Bill Pay" }],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    expect(again).toEqual({ ok: true, inserted: 0, updated: 1, skipped: 0, deduped: 0 });
    const stored = await store.connections();
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe("Head of Bill Pay");
  });

  it("matches an existing person case-insensitively on the profile URL", async () => {
    // LinkedIn's own export is inconsistent about the case of vanity slugs, and
    // the SQL's unique index is on `lower(profile_url)`.
    const store = emptyStore();
    await store.importConnections({
      rows: [row({ fullName: "Ada Okonkwo", profileUrl: "https://www.linkedin.com/in/Ada-Okonkwo" })],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    const res = await store.importConnections({
      rows: [row({ fullName: "Ada Okonkwo", profileUrl: "https://www.linkedin.com/in/ada-okonkwo" })],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    expect(res).toMatchObject({ inserted: 0, updated: 1 });
    expect(await store.connections()).toHaveLength(1);
  });

  it("treats a blank cell as 'the file did not say', never as 'delete what you have'", async () => {
    // 0011's answer verbatim, and matrix row 151: the other reading makes an
    // import unrecoverable. Mutant: apply `excluded.*` unconditionally on the
    // update path — a re-export with an empty Company column wipes every
    // employer in the store and the match silently stops working.
    const store = emptyStore();
    const url = "https://www.linkedin.com/in/ada";
    await store.importConnections({
      rows: [row({ fullName: "Ada Okonkwo", company: "Ramp", title: "PM", profileUrl: url, connectedOn: "2024-03-11" })],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    await store.importConnections({
      rows: [row({ fullName: "Ada Okonkwo", profileUrl: url })], // company/title/date all blank
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    const [stored] = await store.connections();
    expect(stored.company).toBe("Ramp");
    expect(stored.companyKey).toBe("ramp");
    expect(stored.title).toBe("PM");
    expect(stored.connectedOn).toBe("2024-03-11");
  });

  it("treats a cell holding one NBSP as blank, the way hq_blank_trim does", async () => {
    // A bare `.trim()` reads U+00A0 as CONTENT, so the fake would write an
    // invisible character over a real employer while Postgres kept the old value
    // — the exact divergence matrix row 151 records, in the place it is most
    // likely to recur (an export is full of stray whitespace).
    const store = emptyStore();
    const url = "https://www.linkedin.com/in/ada";
    await store.importConnections({
      rows: [row({ fullName: "Ada Okonkwo", company: "Ramp", profileUrl: url })],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    await store.importConnections({
      rows: [row({ fullName: "Ada Okonkwo", company: "\u00a0", title: "​", profileUrl: url })],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    const [stored] = await store.connections();
    expect(stored.company).toBe("Ramp");
    expect(stored.title).toBe("");
  });

  it("skips a nameless row and counts it, rather than refusing the file", async () => {
    // One malformed line in a 3,000-row export must not refuse the other 2,999 —
    // and it must not vanish either, or the numbers stop adding up.
    const store = emptyStore();
    const res = await store.importConnections({
      rows: [
        row({ fullName: "Ada Okonkwo", profileUrl: "https://www.linkedin.com/in/ada" }),
        row({ company: "Ghost Holdings", title: "Analyst" }),
        row({ fullName: "   " }), // blank to a person, length 3 to a naive check
        row({ fullName: "\u00a0" }), // blank to `hq_blank_trim`, content to `.trim()`
      ],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    expect(res).toEqual({ ok: true, inserted: 1, updated: 0, skipped: 3, deduped: 0 });
    expect(await store.connections()).toHaveLength(1);
  });

  it("lets the LAST occurrence win when one chunk lists a person twice", async () => {
    // What a sequence of single-row writes would have left behind, and Postgres
    // refuses an `on conflict do update` that touches one row twice in a single
    // statement — so the choice has to be made explicitly rather than by the plan.
    const store = emptyStore();
    const url = "https://www.linkedin.com/in/ada";
    const res = await store.importConnections({
      rows: [
        row({ fullName: "Ada Okonkwo", company: "Ramp", title: "first", profileUrl: url }),
        row({ fullName: "Ada Okonkwo", company: "Ramp", title: "last", profileUrl: url }),
      ],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    expect(res).toEqual({ ok: true, inserted: 1, updated: 0, skipped: 0, deduped: 1 });
    const stored = await store.connections();
    expect(stored).toHaveLength(1);
    // Mutant: `if (!byIdent.has(ident)) byIdent.set(...)` — first wins, and this
    // reads "first".
    expect(stored[0].title).toBe("last");
  });

  it("dedupes on (name, company) when the export gave no URL", async () => {
    // Both halves in ONE chunk, and that is not incidental: with the company
    // dropped from the identity (`n:${fullName}` alone) a second chunk would
    // still insert, because the store lookup compares `companyKey` separately —
    // so a two-call version of this test SURVIVES that mutant. Watched: it did.
    const store = emptyStore();
    const res = await store.importConnections({
      rows: [
        row({ fullName: "Bo Lindqvist", company: "Ramp", title: "EM" }),
        // Same person, same employer, different case — one row.
        row({ fullName: "bo lindqvist", company: "Ramp", title: "Senior EM" }),
        // Same name at a DIFFERENT employer — a different person, or the
        // identity merges half the Smiths in somebody's network.
        row({ fullName: "Bo Lindqvist", company: "Brex" }),
      ],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    expect(res).toEqual({ ok: true, inserted: 2, updated: 0, skipped: 0, deduped: 1 });
    const stored = await store.connections();
    expect(stored.map((c) => c.company).sort()).toEqual(["Brex", "Ramp"]);
    // LAST wins within the chunk, so the Ramp row carries the later title.
    expect(stored.find((c) => c.company === "Ramp")!.title).toBe("Senior EM");
  });

  it("does not mint a second row for a URL-less line the store already holds under a URL", async () => {
    // The `not exists` guard, which closes the one gap the two partial indexes
    // leave between them: `connections_by_name` is predicated on
    // `profile_url = ''`, so a row already held WITH a URL cannot conflict with a
    // URL-less line for the same human. A person who removes their public URL
    // between two monthly exports would otherwise arrive as a permanent duplicate
    // that never merges again.
    //
    // Mutant: delete the `shadowed` check — this becomes `inserted: 1` and the
    // store grows a second Ada.
    const store = emptyStore();
    await store.importConnections({
      rows: [row({ fullName: "Ada Okonkwo", company: "Ramp", profileUrl: "https://www.linkedin.com/in/ada" })],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    const res = await store.importConnections({
      rows: [row({ fullName: "Ada Okonkwo", company: "Ramp" })],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    expect(res).toEqual({ ok: true, inserted: 0, updated: 0, skipped: 0, deduped: 1 });
    expect(await store.connections()).toHaveLength(1);
  });

  it("promotes a stored URL-less row when a later export carries the URL", async () => {
    // The OTHER direction of the same gap, and the one the fake did not have at
    // all until an adversarial probe measured it: production answered
    // `{inserted: 0, updated: 1}` with ONE row, the fake answered
    // `{inserted: 1, updated: 0}` with TWO — so the demo and the whole E2E suite
    // minted exactly the permanent duplicate matrix row 229 exists to prevent,
    // and the four-number report a person reads did not match production's.
    //
    // LinkedIn withholds a connection's profile URL while they have it
    // restricted. They un-restrict it; next month's export carries it;
    // `connections_by_profile` is PARTIAL on `profile_url <> ''` and sees no
    // conflict with a row whose URL is `''`.
    //
    // Mutant: delete the promotion pass — `inserted` becomes 1 and the store
    // holds two Adas.
    const store = emptyStore();
    await store.importConnections({
      rows: [row({ fullName: "Ada Okonkwo", company: "Ramp", title: "PM", connectedOn: "2024-03-01" })],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    const res = await store.importConnections({
      rows: [row({ fullName: "Ada Okonkwo", company: "Ramp", profileUrl: "https://www.linkedin.com/in/ada" })],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    expect(res).toEqual({ ok: true, inserted: 0, updated: 1, skipped: 0, deduped: 0 });

    const stored = await store.connections();
    expect(stored).toHaveLength(1);
    // Promoted, not replaced: the second file said nothing about the title or
    // the date, and an import never destroys what the file did not say.
    expect(stored[0]).toMatchObject({
      profileUrl: "https://www.linkedin.com/in/ada",
      title: "PM",
      connectedOn: "2024-03-01",
    });
  });

  it("leaves the URL-less row alone when that URL is already held by somebody", async () => {
    // The SQL's `not exists` on the promotion. Without it the UPDATE would
    // violate `connections_by_profile` and abort the whole chunk; with it the
    // URL-less row survives as a genuine duplicate the person clears and
    // re-imports, which is the documented recovery path.
    //
    // Mutant: delete the `urlTaken` check — the promotion writes a duplicate URL
    // into the store, which Postgres could not have stored at all.
    const store = emptyStore();
    const url = "https://www.linkedin.com/in/ada";
    await store.importConnections({
      rows: [
        row({ fullName: "Ada Okonkwo", company: "Ramp", profileUrl: url }),
        row({ fullName: "Ada Okonkwo", company: "Brex" }), // different company, no URL
      ],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    // The Brex row shares a NAME with the URL-bearing Ramp row but not a company
    // key, so it is not a promotion candidate at all — the positive control that
    // the match is (name, company) and not name alone.
    expect(await store.connections()).toHaveLength(2);

    const res = await store.importConnections({
      rows: [row({ fullName: "Ada Okonkwo", company: "Brex", profileUrl: url })],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    // The URL is taken, so nothing is promoted and the line matches the existing
    // URL row instead.
    expect(res).toEqual({ ok: true, inserted: 0, updated: 1, skipped: 0, deduped: 0 });
    const stored = await store.connections();
    expect(stored).toHaveLength(2);
    expect(stored.filter((c) => c.profileUrl === url)).toHaveLength(1);
  });

  it("promotes to the LOWEST url when one chunk carries two for the same person", async () => {
    // The SQL uses `distinct on … order by lower(profile_url)` so the join
    // partner cannot be arbitrary — two lines with two different URLs whose
    // (name, company) normalize the same is legal input, and the same file has to
    // promote the same way on every run and in both implementations.
    //
    // Mutant: drop the `.sort(...)` — the answer becomes insertion-ordered and
    // this goes red on `zeta`.
    const store = emptyStore();
    await store.importConnections({
      rows: [row({ fullName: "Ada Okonkwo", company: "Ramp" })],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    await store.importConnections({
      rows: [
        row({ fullName: "Ada Okonkwo", company: "Ramp", profileUrl: "https://www.linkedin.com/in/zeta" }),
        row({ fullName: "Ada Okonkwo", company: "Ramp", profileUrl: "https://www.linkedin.com/in/alpha" }),
      ],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    const stored = await store.connections();
    expect(stored.map((c) => c.profileUrl).sort()).toEqual([
      "https://www.linkedin.com/in/alpha",
      "https://www.linkedin.com/in/zeta",
    ]);
  });

  it("returns four numbers that ADD UP to the rows sent — matrix row 169", () => {
    // A report that does not close is one nobody can check afterwards, because
    // only the commit knows which bucket a line went to. `deduped` is derived by
    // SUBTRACTION for exactly that reason: it has to absorb BOTH ways a named
    // line can land nowhere — the same person twice in this chunk, and a URL-less
    // line shadowed by a record that already has the URL. Counting the first and
    // forgetting the second is how a report starts adding up to less than the file.
    //
    // Mutant: count `deduped` as `named.length - byIdent.size` instead. The
    // shadowed line disappears from every bucket and this goes red.
    const store = emptyStore();
    const url = "https://www.linkedin.com/in/ada";
    const rows = [
      row({ fullName: "Ada Okonkwo", company: "Ramp", profileUrl: url }), // insert
      row({ fullName: "Ada Okonkwo", company: "Ramp", profileUrl: url, title: "PM" }), // dedupe (same chunk)
      row({ fullName: "Bo Lindqvist", company: "Ramp" }), // insert (no URL)
      row({ company: "Ghost Holdings" }), // skip (no name)
      row({ fullName: "  " }), // skip (blank name)
      row({ fullName: "Chandra Rao", company: "Fifth Third Bank", profileUrl: "https://www.linkedin.com/in/chandra" }), // insert
    ];
    return store
      .importConnections({ rows, source: "linkedin-export", idempotencyKey: idem() })
      .then(async (first) => {
        expect(first.ok).toBe(true);
        if (!first.ok) throw new Error("unreachable");
        expect(first.inserted + first.updated + first.skipped + first.deduped).toBe(rows.length);
        expect(first).toEqual({ ok: true, inserted: 3, updated: 0, skipped: 2, deduped: 1 });

        // And again on the SECOND import, where the buckets are different and the
        // shadowed line is the one that has to be absorbed.
        const second = await store.importConnections({
          rows: [...rows, row({ fullName: "Ada Okonkwo", company: "Ramp" })], // URL-less, already held
          source: "linkedin-export",
          idempotencyKey: idem(),
        });
        expect(second.ok).toBe(true);
        if (!second.ok) throw new Error("unreachable");
        expect(second.inserted + second.updated + second.skipped + second.deduped).toBe(
          rows.length + 1,
        );
        expect(second).toEqual({ ok: true, inserted: 0, updated: 3, skipped: 2, deduped: 2 });
        expect(await store.connections()).toHaveLength(3);
      });
  });

  it("refuses a chunk larger than the SQL accepts, at the same number", async () => {
    // Matrix row 172: a chunk larger than the function accepts is refused
    // mid-import, after some rows have already landed. The fake refusing at a
    // different number is how the UI ships a chunker Postgres rejects.
    const store = emptyStore();
    const tooMany = Array.from({ length: MAX_CONNECTION_CHUNK + 1 }, (_, i) =>
      row({ fullName: `Person ${i}` }),
    );
    const res = await store.importConnections({
      rows: tooMany,
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    expect(res).toMatchObject({ ok: false, kind: "error" });
    if (res.ok || res.kind !== "error") throw new Error("unreachable");
    expect(res.message).toContain(`limit ${MAX_CONNECTION_CHUNK}`);
    expect(await store.connections()).toEqual([]);

    // The bound itself is accepted, so the refusal is off-by-one-proof.
    const atLimit = await store.importConnections({
      rows: tooMany.slice(0, MAX_CONNECTION_CHUNK),
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    expect(atLimit).toMatchObject({ ok: true, inserted: MAX_CONNECTION_CHUNK });
  });

  it("refuses an unknown provenance tag, and defaults a blank one", async () => {
    // `source` is a reporting dimension, and a function granted to
    // `authenticated` with an unbounded string writes a novel into a group-by.
    const store = emptyStore();
    const res = await store.importConnections({
      rows: [row({ fullName: "Ada" })],
      source: "a-novel-about-provenance",
      idempotencyKey: idem(),
    });
    expect(res).toMatchObject({ ok: false, kind: "error" });
    if (res.ok || res.kind !== "error") throw new Error("unreachable");
    expect(res.message).toContain("unknown source tag");
    expect(await store.connections()).toEqual([]);

    // Blank falls back to `linkedin-export` rather than being refused — the
    // caller that omits it is the upload path, not an attack.
    const blank = await store.importConnections({
      rows: [row({ fullName: "Ada" })],
      source: "",
      idempotencyKey: idem(),
    });
    expect(blank.ok).toBe(true);
    // …and the tag is matched case-insensitively, as `lower()` does in the SQL.
    const shouty = await store.importConnections({
      rows: [row({ fullName: "Bo" })],
      source: "MANUAL",
      idempotencyKey: idem(),
    });
    expect(shouty.ok).toBe(true);
  });

  it("replays one key rather than importing the chunk twice", async () => {
    // The outbox flushes on reconnect and two tabs can flush at once. Without the
    // replay, a flaky network doubles somebody's network.
    const store = emptyStore();
    const key = idem();
    const rows = [row({ fullName: "Ada Okonkwo", profileUrl: "https://www.linkedin.com/in/ada" })];
    const first = await store.importConnections({ rows, source: "linkedin-export", idempotencyKey: key });
    const again = await store.importConnections({
      rows: [...rows, row({ fullName: "Somebody Else" })], // different payload, same key
      source: "linkedin-export",
      idempotencyKey: key,
    });
    expect(again).toEqual(first);
    expect(await store.connections()).toHaveLength(1);
  });

  it("honours failNextWrite", async () => {
    const store = emptyStore();
    store.failNextWrite("Network unavailable");
    const res = await store.importConnections({
      rows: [row({ fullName: "Ada" })],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    expect(res).toMatchObject({ ok: false, kind: "error", message: "Network unavailable" });
    expect(await store.connections()).toEqual([]);
  });

  it("does not cache a refusal for replay", async () => {
    // The database stores only successful results for idempotent replay; a fake
    // that cached the rejection would replay it after the input was corrected —
    // and the correction here is "pick a tag from the list on screen".
    const store = emptyStore();
    const key = idem();
    const bad = await store.importConnections({
      rows: [row({ fullName: "Ada" })],
      source: "nonsense",
      idempotencyKey: key,
    });
    expect(bad.ok).toBe(false);
    const retry = await store.importConnections({
      rows: [row({ fullName: "Ada" })],
      source: "linkedin-export",
      idempotencyKey: key,
    });
    expect(retry).toMatchObject({ ok: true, inserted: 1 });
  });
});

// ------------------------------------------------------------- clearConnections

describe("clearConnections", () => {
  it("deletes everything and says how much", async () => {
    // "Delete mine and upload again" is the whole recovery story, and it is what
    // the `connections_by_name` index leans on to justify its one merge risk. A
    // recovery path that points at something the system does not offer is the
    // same defect as a button that does nothing.
    expect(FIXTURE_CONNECTIONS.length).toBeGreaterThan(0); // positive control
    const res = await src.clearConnections({ idempotencyKey: idem() });
    expect(res).toEqual({ ok: true, deleted: FIXTURE_CONNECTIONS.length });
    expect(await src.connections()).toEqual([]);
  });

  it("is idempotent on its key, and honest on a second call with a new one", async () => {
    const key = idem();
    const first = await src.clearConnections({ idempotencyKey: key });
    expect(await src.clearConnections({ idempotencyKey: key })).toEqual(first);
    // A genuinely new gesture over an empty table deletes nothing and says so,
    // rather than replaying the old count.
    expect(await src.clearConnections({ idempotencyKey: idem() })).toEqual({ ok: true, deleted: 0 });
  });

  it("honours failNextWrite and leaves the rows alone", async () => {
    src.failNextWrite("Network unavailable");
    const res = await src.clearConnections({ idempotencyKey: idem() });
    expect(res).toMatchObject({ ok: false, kind: "error" });
    expect(await src.connections()).toHaveLength(FIXTURE_CONNECTIONS.length);
  });
});

// ------------------------------------------------------------------ connections

describe("connections()", () => {
  it("orders by full name, then by id — the documented contract", async () => {
    // One ordering contract, shared with `SupabaseDataSource.connections()`. A
    // tie direction left undefined is the divergence `parity.test.ts` exists to
    // pin, and the popover's first name would flip between reads.
    expect((await src.connections()).map((c) => c.fullName)).toEqual([
      "Ada Okonkwo",
      "Bo Lindqvist",
      "Chandra Rao",
      "Dev Patel",
      "Eleni Papadopoulou-Constantinidis von Habsburg-Lothringen",
    ]);

    // The tiebreak needs a store whose rows are NOT already in id order, or a
    // stable sort reproduces ascending ids for free and dropping `|| a.id - b.id`
    // survives. Watched: it did, against a version that imported the rows —
    // `connectionsById` iterates in insertion order, so an import can only ever
    // produce ascending ids. Seeded through the constructor instead, descending.
    const outOfOrder = new FixtureDataSource(undefined, undefined, undefined, undefined, undefined, [
      { id: 90, fullName: "Chris Lee", company: "Ramp", companyKey: "ramp", title: "", profileUrl: "", connectedOn: null },
      { id: 12, fullName: "Chris Lee", company: "Brex", companyKey: "brex", title: "", profileUrl: "", connectedOn: null },
      { id: 50, fullName: "Ada Okonkwo", company: "Ramp", companyKey: "ramp", title: "", profileUrl: "", connectedOn: null },
    ]);
    const stored = await outOfOrder.connections();
    expect(stored.map((c) => c.fullName)).toEqual(["Ada Okonkwo", "Chris Lee", "Chris Lee"]);
    expect(stored.map((c) => c.id)).toEqual([50, 12, 90]);
  });

  it("hands back copies, so a caller cannot edit the store by accident", async () => {
    const first = await src.connections();
    first[0].company = "Somewhere Else";
    expect((await src.connections())[0].company).toBe(FIXTURE_CONNECTIONS[0].company);
  });

  it("gives an imported row the SQL's generated company key, not the raw string", async () => {
    // `connections.company_key` is GENERATED in Postgres. A fake that stored the
    // raw name would make the whole match work in production and fail in the
    // demo — or worse, the other way round.
    const store = emptyStore();
    await store.importConnections({
      rows: [row({ fullName: "Chandra Rao", company: "  Fifth\u00a0Third   Bank " })],
      source: "linkedin-export",
      idempotencyKey: idem(),
    });
    const [stored] = await store.connections();
    expect(stored.companyKey).toBe("fifth third bank");
    expect(stored.company).toBe("Fifth\u00a0Third   Bank"); // displayed as the file spelled it
  });
});
