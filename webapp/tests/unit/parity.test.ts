import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import { IMPORT_LIST_LIMIT } from "@/lib/data/source";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";
import { CADENCE, SupabaseDataSource, toCompanyView, toJobView } from "@/lib/data/supabase-source";
import { blankTrim, companyNameKey, PROPOSE_SOURCE_TAGS } from "@/lib/data/view-models";
import type { CompanyView, JobView, ReviewState, Triage } from "@/lib/data/view-models";

/**
 * The two DataSource implementations, compared on observable behaviour.
 *
 * docs/WEBAPP-BUILD.md: "A fake must reproduce the real thing's failure
 * modes, not just its happy path." Three times now the fixture has been more
 * forgiving than production — the auto-growing sheet grid, the unconditional
 * health fixture, and the divergences pinned here. Each time, every test was
 * green while production misbehaved, because nothing compared the two
 * implementations against each other. This file is that comparison: the same
 * logical data goes through both, and any divergence in ordering, reduction,
 * or write acceptance fails here instead of in front of a user.
 *
 * The Supabase side runs against a stub client that stores rows and honestly
 * applies the filters/order/limit the source requests (PostgREST semantics:
 * to-one embedded ordering, embedded filters with !inner, Postgres null
 * placement). A stub that ignored the query would only test that the source
 * called something.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const WRITE_PATH_SQL = readFileSync(
  path.join(REPO, "db", "migrations", "0003_write_path.sql"),
  "utf8",
);
const COMPANY_REVIEW_SQL = readFileSync(
  path.join(REPO, "db", "migrations", "0008_company_review.sql"),
  "utf8",
);
const PIPELINE_SQL = readFileSync(
  path.join(REPO, "db", "migrations", "0010_pipeline.sql"),
  "utf8",
);
const IMPORT_SQL = readFileSync(
  path.join(REPO, "db", "migrations", "0011_import.sql"),
  "utf8",
);

/**
 * The company-name corpus the OTHER two ports are pinned against:
 * `tests/core/test_companykeys.py` runs it through `core/companykeys.py` with no database,
 * and `tests/db/test_universe_reconcile.py` runs it through `public.company_name_key` inside
 * real Postgres. This port was the odd one out — pinned only by the hand-written assertions
 * below, which is how three implementations of one rule end up with two of them agreeing.
 *
 * A case carrying `sql_key` is a DOCUMENTED divergence: Postgres's `lower()` is
 * locale-dependent where JS's and Python's are not (U+0130 folds to a bare 'i' there, and to
 * 'i' + U+0307 here). `key` is the JS/Python answer, so this file asserts `key` throughout.
 */
type NameKeyCase = { why: string; name: string; key: string; sql_key?: string };
const NAME_KEY_CORPUS: NameKeyCase[] = JSON.parse(
  readFileSync(
    path.join(REPO, "tests", "fixtures", "company_name_key.golden.json"),
    "utf8",
  ),
);

// ---------------------------------------------------------------- stub client

type Row = Record<string, unknown>;

function get(row: Row, pathParts: string[]): unknown {
  let v: unknown = row;
  for (const p of pathParts) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Row)[p];
  }
  return v;
}

class StubQuery implements PromiseLike<{ data: Row[]; error: null }> {
  private filters: Array<(r: Row) => boolean> = [];
  private orders: Array<{ path: string[]; ascending: boolean; nullsFirst: boolean }> = [];
  private max: number | null = null;

  constructor(private readonly rows: Row[]) {}

  select(_columns: string): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    const p = column.split(".");
    this.filters.push((r) => get(r, p) === value);
    return this;
  }

  neq(column: string, value: unknown): this {
    // An embedded-column filter ("postings.status") on an !inner join removes
    // the top-level row, which is what the sources rely on.
    const p = column.split(".");
    this.filters.push((r) => get(r, p) !== value);
    return this;
  }

  order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    // "postings(first_seen)" is PostgREST's to-one embedded ordering: it
    // orders the TOP-LEVEL rows by the joined column.
    const m = column.match(/^(\w+)\((\w+)\)$/);
    const ascending = opts?.ascending ?? true;
    this.orders.push({
      path: m ? [m[1], m[2]] : [column],
      ascending,
      // Postgres defaults: NULLS LAST ascending, NULLS FIRST descending.
      nullsFirst: opts?.nullsFirst ?? !ascending,
    });
    return this;
  }

  limit(n: number): this {
    this.max = n;
    return this;
  }

  then<T1 = { data: Row[]; error: null }, T2 = never>(
    onfulfilled?: ((value: { data: Row[]; error: null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    let out = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.orders.length) {
      out = [...out].sort((a, b) => {
        for (const o of this.orders) {
          const av = get(a, o.path) ?? null;
          const bv = get(b, o.path) ?? null;
          if (av === null || bv === null) {
            if (av === bv) continue;
            return (av === null) === o.nullsFirst ? -1 : 1;
          }
          if (av === bv) continue;
          const cmp = (av as string | number) < (bv as string | number) ? -1 : 1;
          return o.ascending ? cmp : -cmp;
        }
        return 0;
      });
    }
    if (this.max !== null) out = out.slice(0, this.max);
    return Promise.resolve({ data: structuredClone(out), error: null as null }).then(
      onfulfilled,
      onrejected,
    );
  }
}

function stubClient(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from: (table: string) => new StubQuery(tables[table] ?? []),
  } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------- seed shapes

const STAMP = "2026-07-21T00:00:00.000Z";

function jv(seed: Partial<JobView> & Pick<JobView, "key">): JobView {
  return {
    status: "Seen",
    company: "Co",
    title: "PM",
    url: `https://example.com/${seed.key}`,
    location: null,
    metro: null,
    market: null,
    remote: false,
    workModel: null,
    compRange: null,
    compMinK: null,
    compMaxK: null,
    minYoe: null,
    seniority: null,
    industry: null,
    roleFocus: null,
    skills: [],
    posted: null,
    firstSeen: null,
    disposition: "qualified",
    dispositionReason: "",
    triage: "",
    snoozeUntil: null,
    updatedAt: STAMP,
    ...seed,
  };
}

function dbRow(o: {
  key: string;
  firstSeen: string | null;
  lastSeen: string;
  userId?: string;
  disposition?: string;
  triage?: string;
  compRange?: string;
}): Row {
  return {
    user_id: o.userId ?? "u1",
    posting_key: o.key,
    disposition: o.disposition ?? "qualified",
    disposition_reason: "",
    triage: o.triage ?? "",
    snooze_until: null,
    updated_at: STAMP,
    postings: {
      key: o.key,
      company: "Co",
      title: "PM",
      location: "",
      url: `https://example.com/${o.key}`,
      posted: null,
      first_seen: o.firstSeen,
      last_seen: o.lastSeen,
      status: "New",
      tags: o.compRange === undefined ? {} : { comp_range: o.compRange },
      geo: {},
      source: "monitor",
    },
  };
}

// ---------------------------------------------------------------- ordering

describe("queue ordering parity", () => {
  // last_seen order deliberately disagrees with first_seen order (B was
  // re-seen by a later sweep — the everyday case), and B/D tie on first_seen
  // so the tiebreak is exercised. The contract is "freshest first":
  // first_seen descending, posting key descending on a tie.
  const seeds = [
    { key: "ashby-bb", firstSeen: "2026-07-18", lastSeen: "2026-07-21" },
    { key: "lever-aa", firstSeen: "2026-07-20", lastSeen: "2026-07-20" },
    { key: "greenhouse-cc", firstSeen: "2026-07-19", lastSeen: "2026-07-19" },
    { key: "workday-dd", firstSeen: "2026-07-18", lastSeen: "2026-07-18" },
  ];
  const EXPECTED = ["lever-aa", "greenhouse-cc", "workday-dd", "ashby-bb"];

  // Excluded for a different reason each: another user's row, a filtered row,
  // an already-triaged row. Both implementations must drop all three.
  const excluded = [
    dbRow({ key: "other-user", firstSeen: "2026-07-20", lastSeen: "2026-07-20", userId: "u2" }),
    dbRow({ key: "gated-out", firstSeen: "2026-07-17", lastSeen: "2026-07-17", disposition: "filtered" }),
    dbRow({ key: "already-done", firstSeen: "2026-07-16", lastSeen: "2026-07-16", triage: "interested" }),
  ];

  const supabase = () =>
    new SupabaseDataSource(
      stubClient({ user_postings: [...seeds.map(dbRow), ...excluded] }),
      "u1",
    );
  const fixture = () =>
    new FixtureDataSource(
      [
        ...seeds.map((s) => jv({ key: s.key, firstSeen: s.firstSeen })),
        jv({ key: "gated-out", firstSeen: "2026-07-17", disposition: "filtered", dispositionReason: "geo:India" }),
        jv({ key: "already-done", firstSeen: "2026-07-16", triage: "interested" }),
      ],
      [],
      [],
    );

  it("supabase orders the queue freshest-first by first_seen with a key tiebreak", async () => {
    expect((await supabase().queue()).map((j) => j.key)).toEqual(EXPECTED);
  });

  it("fixture orders the queue identically", async () => {
    expect((await fixture().queue()).map((j) => j.key)).toEqual(EXPECTED);
  });

  it("both implementations return the same queue over the same data", async () => {
    const [s, f] = await Promise.all([supabase().queue(), fixture().queue()]);
    expect(s.map((j) => j.key)).toEqual(f.map((j) => j.key));
  });

  it("jobs() is deterministic and identical in both implementations", async () => {
    // jobs() carries everything (triaged and filtered included), capped at
    // 5000 — an undefined order decides WHICH rows survive the cap, so it
    // cannot be left to the query plan.
    const [s, f] = await Promise.all([supabase().jobs(), fixture().jobs()]);
    expect(s.map((j) => j.key)).toEqual([
      "lever-aa",
      "greenhouse-cc",
      "workday-dd",
      "ashby-bb",
      "gated-out",
      "already-done",
    ]);
    expect(f.map((j) => j.key)).toEqual(s.map((j) => j.key));
  });
});

// ---------------------------------------------------------------- health

describe("health never drops a dead channel", () => {
  // At real cadences (capture ~16/day, tracker 12/day, five daily channels)
  // 200 rows cover ~5.5 days. Seed a history denser than the window: 210
  // fresh capture/tracker rows push cafe's one 300-hour-old run out of any
  // newest-200 read. The old implementation answered "everything is fine" by
  // omitting exactly the channel that was critically stale.
  const NOW = Date.parse("2026-07-21T15:00:00.000Z");
  const stamp = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

  const runs: Row[] = [];
  for (let i = 0; i < 120; i++) {
    runs.push({ channel: "capture", ran_at: stamp(i * 1.5), fetched: 40, new_rows: 2, filtered: 0, tagged: 0, errors: 0 });
  }
  for (let i = 0; i < 90; i++) {
    runs.push({ channel: "tracker", ran_at: stamp(i * 2), fetched: 0, new_rows: 0, filtered: 0, tagged: 0, errors: 0 });
  }
  const CAFE_LAST_RAN = stamp(300);
  runs.push({ channel: "cafe", ran_at: CAFE_LAST_RAN, fetched: 7, new_rows: 1, filtered: 0, tagged: 0, errors: 0 });

  const source = () => new SupabaseDataSource(stubClient({ channel_runs: runs }), "u1");

  it("a channel dead longer than the read window still reports, as critically stale", async () => {
    const cafe = (await source().health()).find((h) => h.channel === "cafe");
    expect(cafe).toBeDefined();
    expect(cafe!.ranAt).toBe(CAFE_LAST_RAN);
    expect(cafe!.fetched).toBe(7);
    expect(cafe!.ageHours).toBeGreaterThan(250);
  });

  it("every expected channel appears — one that never ran shows as never-ran, not as nothing", async () => {
    // digest.py reports the same state as "no heartbeat yet"; vanishing and
    // healthy are indistinguishable on a table that omits the row.
    const byChannel = new Map((await source().health()).map((h) => [h.channel, h]));
    for (const channel of Object.keys(CADENCE)) {
      const row = byChannel.get(channel);
      expect(row, `channel ${channel} missing from /health`).toBeDefined();
      // ageHours is null exactly when the channel has never run — the page
      // renders that pair as "never" + a stale badge.
      expect(row!.ageHours === null).toBe(row!.ranAt === null);
    }
    expect(byChannel.get("monitor")!.ranAt).toBeNull();
  });

  it("returns one row per channel, like the fixture", async () => {
    const rows = await source().health();
    expect(new Set(rows.map((h) => h.channel)).size).toBe(rows.length);
  });
});

// ---------------------------------------------------------------- writes

describe("write rejection parity with app_set_triage", () => {
  // 0003_write_path.sql refuses these before touching the row (and 0002's
  // snooze_has_a_date CHECK backstops the first). A fixture that accepted
  // them let the UI ship gestures production rejects.
  const source = () => new FixtureDataSource([jv({ key: "k1" })], [], []);

  it("snoozed with no wake date is rejected, with the migration's own words", async () => {
    const result = await source().setTriage({
      postingKey: "k1",
      triage: "snoozed",
      snoozeUntil: null,
      idempotencyKey: "idem-1",
      expectedUpdatedAt: STAMP,
    });
    expect(result).toMatchObject({ ok: false, kind: "error" });
    if (result.ok || result.kind !== "error") throw new Error("unreachable");
    // Pinned to the migration text so the fake and the database cannot drift
    // apart silently — the same technique tests/core/test_migrations.py uses
    // for the conflict message.
    expect(WRITE_PATH_SQL).toContain(result.message);
  });

  it("an out-of-enum triage value is rejected", async () => {
    const result = await source().setTriage({
      postingKey: "k1",
      triage: "banana" as Triage,
      snoozeUntil: null,
      idempotencyKey: "idem-2",
      expectedUpdatedAt: STAMP,
    });
    expect(result).toMatchObject({ ok: false, kind: "error" });
    if (result.ok || result.kind !== "error") throw new Error("unreachable");
    expect(result.message).toContain("invalid triage value");
    expect(WRITE_PATH_SQL).toContain("invalid triage value");
  });

  it("a rejected write is not stored for replay", async () => {
    // The database stores only successful results for idempotent replay; a
    // fake that cached the rejection would replay it after the input was
    // corrected.
    const s = source();
    await s.setTriage({
      postingKey: "k1",
      triage: "snoozed",
      snoozeUntil: null,
      idempotencyKey: "idem-3",
      expectedUpdatedAt: STAMP,
    });
    const retry = await s.setTriage({
      postingKey: "k1",
      triage: "snoozed",
      snoozeUntil: "2026-07-28",
      idempotencyKey: "idem-3",
      expectedUpdatedAt: STAMP,
    });
    expect(retry.ok).toBe(true);
  });

  it("a non-snooze triage clears any snooze date, as the migration does", async () => {
    // 0003: "a dismissed row carrying a stale snooze date is a row that
    // reanimates itself" — snooze_until is nulled unless the triage is
    // snoozed. The fixture used to keep whatever the caller passed.
    const result = await source().setTriage({
      postingKey: "k1",
      triage: "dismissed",
      snoozeUntil: "2026-07-28",
      idempotencyKey: "idem-4",
      expectedUpdatedAt: STAMP,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.job.snoozeUntil).toBeNull();
  });
});

// ---------------------------------------------------------------- the universe

/**
 * The /companies read path and its write guards, through both implementations.
 *
 * The same trap that produced this whole file is live here: the fixture store is
 * what the E2E suite and demo mode drive, so any way it is kinder than Postgres is
 * a class of bug no other test can see. Two guards in migration 0008 matter enough
 * to be compared directly — the review gate on `setCompanyFlags`, and the tier-3
 * floor on `proposeCompanies` — because both are places where a forgiving fake
 * would let the UI ship a control production refuses, or a claim production does
 * not make.
 */
describe("company universe parity", () => {
  function cv(seed: Partial<CompanyView> & Pick<CompanyView, "id">): CompanyView {
    return {
      key: String(seed.id),
      name: "Co",
      ats: "greenhouse",
      slug: `slug-${seed.id}`,
      source: "seed",
      tier: 1,
      resolutionMethod: "discover-greenhouse",
      reviewState: "approved",
      enabled: true,
      priority: false,
      seeded: false,
      updatedAt: STAMP,
      ...seed,
    };
  }

  function ucRow(o: {
    id: number;
    name: string;
    userId?: string;
    reviewState?: string;
    tier?: number | null;
    method?: string;
  }): Row {
    return {
      user_id: o.userId ?? "u1",
      company_id: o.id,
      monitor: true,
      priority: false,
      seeded: false,
      review_state: o.reviewState ?? "approved",
      updated_at: STAMP,
      companies: {
        id: o.id,
        name: o.name,
        ats: "greenhouse",
        slug: `slug-${o.id}`,
        source: "seed",
        reliability_tier: o.tier === undefined ? 1 : o.tier,
        resolution_method: o.method ?? "discover-greenhouse",
      },
    };
  }

  // Names deliberately out of alphabetical order, with a nameless row (Common
  // Crawl mines boards, not names) and a NAME TIE so the id tiebreak is exercised.
  const seeds = [
    { id: 30, name: "Zurich" },
    { id: 10, name: "Aon" },
    { id: 25, name: "" },
    { id: 21, name: "Ramp" },
    { id: 20, name: "Ramp" },
  ];
  const EXPECTED = [25, 10, 20, 21, 30]; // "" first, then A→Z, ids ascending on a tie

  const supabase = () =>
    new SupabaseDataSource(
      stubClient({
        user_companies: [
          ...seeds.map((s) => ucRow(s)),
          ucRow({ id: 99, name: "Someone Else Co", userId: "u2" }),
        ],
      }),
      "u1",
    );
  const fixture = (rows = seeds.map((s) => cv({ id: s.id, name: s.name }))) =>
    new FixtureDataSource([], [], [], rows);

  it("both implementations order the universe by name with an id tiebreak", async () => {
    expect((await supabase().companies()).map((c) => c.id)).toEqual(EXPECTED);
    expect((await fixture().companies()).map((c) => c.id)).toEqual(EXPECTED);
  });

  it("another user's subscription never appears", async () => {
    expect((await supabase().companies()).map((c) => c.id)).not.toContain(99);
  });

  it("toCompanyView refuses a tier the schema's CHECK could not have produced", () => {
    // reliability_tier is a smallint with `check (… in (1,2,3))`. A 4 could only
    // come from a schema drift or a write that bypassed the constraint, and
    // inventing a meaning for it is exactly the false confidence the provenance
    // vocabulary exists to prevent — so it reads as unresolved.
    expect(toCompanyView(ucRow({ id: 1, name: "Drifted", tier: 4 }))!.tier).toBeNull();
  });

  it("an unrecognised review_state lands in the review pile, not the universe", () => {
    // Fail-closed direction: an unknown state must await a human rather than join
    // the approved set that feeds the sweep.
    expect(toCompanyView(ucRow({ id: 1, name: "Odd", reviewState: "pending" }))!.reviewState).toBe(
      "proposed",
    );
  });

  it("the fixture refuses a flag change on an unapproved row, as 0008 does", async () => {
    // The review gate. Turning `monitor` on for a proposal would put it into the
    // sweep behind the user's back — the one thing the proposal state exists to
    // prevent — so a fake that allowed it would let the UI ship that control.
    const store = fixture([cv({ id: 5, reviewState: "proposed", enabled: false })]);
    const res = await store.setCompanyFlags({
      companyId: 5,
      enabled: true,
      priority: false,
      idempotencyKey: "flags-1",
      expectedUpdatedAt: STAMP,
    });
    expect(res).toMatchObject({ ok: false, kind: "error" });
    if (res.ok || res.kind !== "error") throw new Error("unreachable");
    expect(res.message).toContain("not approved");
    // Pinned to the migration text so the fake and the database cannot drift apart
    // silently — the technique parity already uses for app_set_triage.
    expect(COMPANY_REVIEW_SQL).toContain("is not approved; review it first");
  });

  it("the fixture applies a bulk review all-or-nothing, as the transaction does", async () => {
    // A conflict on the LAST row must leave the FIRST row untouched. A fake that
    // applied greedily would model a partial write the SQL cannot produce, and
    // hide the atomicity bug rather than reproduce it.
    const store = fixture([
      cv({ id: 1, reviewState: "proposed", enabled: false }),
      cv({ id: 2, reviewState: "proposed", enabled: false }),
    ]);
    const res = await store.setCompanyReviewBulk({
      companyIds: [1, 2],
      reviewState: "approved",
      idempotencyKey: "rev-1",
      expectedUpdatedAt: [STAMP, "2020-01-01T00:00:00.000Z"], // second token is stale
    });
    expect(res).toEqual({ ok: false, kind: "conflict" });
    expect((await store.companies()).map((c) => c.reviewState)).toEqual(["proposed", "proposed"]);
  });

  it("approving turns the sweep on and dismissing turns it off", async () => {
    const store = fixture([cv({ id: 1, reviewState: "proposed", enabled: false })]);
    const ok = await store.setCompanyReviewBulk({
      companyIds: [1],
      reviewState: "approved",
      idempotencyKey: "rev-2",
      expectedUpdatedAt: [null],
    });
    expect(ok.ok && ok.companies[0].enabled).toBe(true);
    const off = await store.setCompanyReviewBulk({
      companyIds: [1],
      reviewState: "dismissed",
      idempotencyKey: "rev-3",
      expectedUpdatedAt: [null],
    });
    expect(off.ok && off.companies[0].enabled).toBe(false);
  });

  it("a no-op review does not bump the version token", async () => {
    // 0006's rule: re-approving an already-approved row must not invalidate every
    // other tab's token for a row nothing changed.
    const store = fixture([cv({ id: 1, reviewState: "approved", enabled: true })]);
    const res = await store.setCompanyReviewBulk({
      companyIds: [1],
      reviewState: "approved",
      idempotencyKey: "rev-4",
      expectedUpdatedAt: [STAMP],
    });
    expect(res.ok && res.companies[0].updatedAt).toBe(STAMP);
  });

  it("a rejected review state is refused with the migration's own words", async () => {
    const res = await fixture([cv({ id: 1 })]).setCompanyReviewBulk({
      companyIds: [1],
      reviewState: "banana" as ReviewState,
      idempotencyKey: "rev-5",
      expectedUpdatedAt: [null],
    });
    expect(res).toMatchObject({ ok: false, kind: "error" });
    if (res.ok || res.kind !== "error") throw new Error("unreachable");
    expect(COMPANY_REVIEW_SQL).toContain("invalid review state");
  });

  it("a pasted name is written at tier 3 / manual in the fixture too", async () => {
    // The load-bearing claim. Nothing in the web app resolves a board, so a demo
    // store that handed back tier 1 would show a reliability promise production
    // never makes — and the demo is what the owner is shown.
    const res = await fixture([]).proposeCompanies({
      names: ["Kraft Heinz"],
      source: "paste",
      idempotencyKey: "prop-1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.added).toBe(1);
    expect(res.companies[0]).toMatchObject({
      tier: 3,
      resolutionMethod: "manual",
      reviewState: "proposed",
      enabled: false,
      ats: "",
      slug: "",
    });
    expect(COMPANY_REVIEW_SQL).toContain("values (v_name, '', '', v_source, 3, 'manual')");
  });

  it("the propose insert's ON-CONFLICT ACTION is do-nothing, never do-update", () => {
    // Pinning the ACTION, not just the row it inserts.
    //
    // `do update` here would rewrite `source`, `reliability_tier` and
    // `resolution_method` on a row the resolver already grounded — turning a
    // verified tier-1 board into a tier-3 guess, which is a fabricated DOWNGRADE
    // of real evidence and exactly as dishonest as a fabricated upgrade. The
    // conflict path is now race-only (the lookup above it binds to any existing
    // row first), so no db test can reach it; a text pin is what is left, and it
    // is the same technique parity already uses for the migration's messages.
    const propose = COMPANY_REVIEW_SQL.slice(
      COMPANY_REVIEW_SQL.indexOf("function public.app_propose_companies"),
    );
    expect(propose).toContain("values (v_name, '', '', v_source, 3, 'manual')");
    // Between the insert and the next statement there is exactly one on-conflict,
    // and it does nothing.
    const insert = propose.slice(propose.indexOf("insert into public.companies"));
    expect(insert.slice(0, insert.indexOf(";"))).toContain("on conflict do nothing");
    expect(propose).not.toMatch(/on\s+conflict[^;]*do\s+update/i);
  });

  it("a paste binds to an ALREADY-GROUNDED row instead of minting a tier-3 ghost", async () => {
    // The worst bug this feature had, and the fake reproduced it faithfully because
    // it reproduced the wrong key. The SQL's conflict key was (name, '', '') and the
    // resolver only ever writes rows with a NON-EMPTY ats+slug — so a paste of an
    // already-resolved name collided with nothing, created a second permanent
    // tier-3 row, and bound the human to a company that reads as watched and is
    // never pulled from.
    //
    // The fixture's old `find` required ats === "" && slug === "" for the same
    // reason and would now be KINDER than Postgres in the one direction that
    // matters — which is the whole failure mode this file exists to catch.
    const store = fixture([
      cv({ id: 7, name: "Ramp", ats: "ashby", slug: "ramp", tier: 1, resolutionMethod: "discover-ashby" }),
    ]);
    const res = await store.proposeCompanies({
      names: ["ramp"],
      source: "paste",
      idempotencyKey: "prop-grounded",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.added).toBe(0);
    expect(res.companies[0]).toMatchObject({ id: 7, tier: 1, resolutionMethod: "discover-ashby" });
    expect((await store.companies()).length).toBe(1);
    // And the SQL matches on the normalized name across ANY ats/slug, grounded first.
    expect(COMPANY_REVIEW_SQL).toContain("where public.company_name_key(name) = v_key");
    expect(COMPANY_REVIEW_SQL).toContain(
      "order by (ats <> '' and slug <> '') desc, reliability_tier nulls last, id",
    );
  });

  it("companyNameKey folds exactly what public.company_name_key folds", () => {
    // The fake and the database must agree about which strings are the SAME
    // company, or the demo shows a duplicate production would not create (or
    // hides one it would). The character classes are asserted against the SQL
    // text because there is no other way to compare a JS regex to a Postgres one.
    expect(companyNameKey("Aon")).toBe("aon");
    expect(companyNameKey("  aon  ")).toBe("aon");
    expect(companyNameKey("A\u00a0O\u00a0N")).toBe("a o n");
    expect(companyNameKey("Aon\u200b")).toBe("aon");
    expect(companyNameKey("Aon\u3000Group")).toBe("aon group");
    // Punctuation is NOT folded: two different registered names stay two companies.
    expect(companyNameKey("Guggenheim Partners, LLC")).not.toBe(
      companyNameKey("Guggenheim Partners LLC"),
    );
    for (const cls of [
      "[\\u200B\\u200C\\u200D\\uFEFF]",
      "[\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]+",
    ]) {
      expect(COMPANY_REVIEW_SQL, `SQL is missing the class ${cls}`).toContain(cls);
    }
  });

  it("companyNameKey agrees with the corpus the Python and SQL ports are pinned against", () => {
    // Same file, three implementations. Without this the TS port could drift from the other
    // two and every suite would stay green: the fake would call two strings one company where
    // Postgres calls them two, and the demo would disagree with production about a duplicate.
    expect(NAME_KEY_CORPUS.length).toBeGreaterThanOrEqual(35);
    expect(NAME_KEY_CORPUS.some((c) => c.sql_key !== undefined)).toBe(true);
    for (const c of NAME_KEY_CORPUS) {
      expect(companyNameKey(c.name), `${c.why} (${JSON.stringify(c.name)})`).toBe(c.key);
    }
  });

  it("pasting over an approved company leaves the human's decision alone", async () => {
    // Re-proposing an approved company would pull it back out of the swept set — a
    // silent regression of a decision already made. The SQL leaves it; so must the
    // fake.
    const store = fixture([
      cv({ id: 1, name: "Wintrust", ats: "", slug: "", reviewState: "approved", enabled: true }),
    ]);
    const res = await store.proposeCompanies({
      names: ["wintrust"],
      source: "paste",
      idempotencyKey: "prop-2",
    });
    expect(res.ok && res.added).toBe(0);
    expect((await store.companies())[0]).toMatchObject({ reviewState: "approved", enabled: true });
  });

  it("blank lines and duplicates in a paste collapse, in both", async () => {
    const res = await fixture([]).proposeCompanies({
      // Case, surrounding whitespace, an NBSP and a zero-width space are all the
      // same company — the three shapes the reviews reproduced as separate rows.
      names: ["Aon", "", "   ", "aon", " Aon\u00a0", "Aon\u200b", "Exelon"],
      source: "paste",
      idempotencyKey: "prop-3",
    });
    expect(res.ok && res.added).toBe(2);
  });

  it("an unknown source tag is refused with the migration's own vocabulary", async () => {
    const res = await fixture([]).proposeCompanies({
      names: ["Somebody"],
      source: "a-novel-about-provenance",
      idempotencyKey: "prop-src",
    });
    expect(res).toMatchObject({ ok: false, kind: "error" });
    if (res.ok || res.kind !== "error") throw new Error("unreachable");
    expect(res.message).toContain("unknown source tag");
    expect(COMPANY_REVIEW_SQL).toContain("unknown source tag");
    // Every tag the UI accepts is one the SQL accepts.
    const allowed = COMPANY_REVIEW_SQL.slice(
      COMPANY_REVIEW_SQL.indexOf("ALLOWED_SOURCES constant text[]"),
    ).slice(0, 400);
    for (const tag of PROPOSE_SOURCE_TAGS) {
      expect(allowed, `SQL does not allow the tag ${tag}`).toContain(`'${tag}'`);
    }
  });

  it("the review backlog has the same ceiling in both", async () => {
    // 500 bounds one paste; nothing bounded the total until 0008 grew this. The
    // fake has to refuse at the same number or the demo grows a pile production
    // would have stopped.
    const many = Array.from({ length: 2000 }, (_, i) =>
      cv({ id: 1000 + i, name: `Pending ${i}`, reviewState: "proposed", enabled: false }),
    );
    const res = await fixture(many).proposeCompanies({
      names: ["One More Please"],
      source: "paste",
      idempotencyKey: "prop-backlog",
    });
    expect(res).toMatchObject({ ok: false, kind: "error" });
    if (res.ok || res.kind !== "error") throw new Error("unreachable");
    expect(res.message).toContain("backlog is full");
    expect(COMPANY_REVIEW_SQL).toContain("review backlog is full");
    expect(COMPANY_REVIEW_SQL).toContain("MAX_PENDING constant int := 2000");
  });

  it("a paste past the SQL's bound is refused with the same limit", async () => {
    const res = await fixture([]).proposeCompanies({
      names: Array.from({ length: 501 }, (_, i) => `Co ${i}`),
      source: "paste",
      idempotencyKey: "prop-4",
    });
    expect(res).toMatchObject({ ok: false, kind: "error" });
    if (res.ok || res.kind !== "error") throw new Error("unreachable");
    expect(res.message).toContain("limit 500");
    expect(COMPANY_REVIEW_SQL).toContain("too many companies in one paste (limit 500)");
  });

  it("every company gesture replays under its idempotency key", async () => {
    const store = fixture([cv({ id: 1, reviewState: "proposed", enabled: false })]);
    const first = await store.setCompanyReviewBulk({
      companyIds: [1],
      reviewState: "approved",
      idempotencyKey: "same",
      expectedUpdatedAt: [null],
    });
    const again = await store.setCompanyReviewBulk({
      companyIds: [1],
      reviewState: "dismissed", // different intent, same key
      idempotencyKey: "same",
      expectedUpdatedAt: [null],
    });
    expect(again).toEqual(first);
    expect((await store.companies())[0].reviewState).toBe("approved");
  });
});

// ---------------------------------------------------------------- comp

describe("comp parsing parity", () => {
  const viaDb = (compRange: string | null): [number | null, number | null] => {
    const job = toJobView(
      dbRow({
        key: "comp-row",
        firstSeen: "2026-07-20",
        lastSeen: "2026-07-20",
        compRange: compRange ?? undefined,
      }),
    );
    if (!job) throw new Error("toJobView returned null for a row with a posting");
    return [job.compMinK, job.compMaxK];
  };

  it("production derives the comp band the demo has always displayed", async () => {
    // Every fixture job's hand-written compMinK/compMaxK must be what
    // production derives from the same comp_range string. Until this held,
    // the two numeric comp columns in every export were permanently blank in
    // production while demo showed numbers.
    for (const j of FIXTURE_JOBS) {
      expect(
        { key: j.key, band: viaDb(j.compRange) },
        `comp band for ${j.key} (${j.compRange})`,
      ).toEqual({ key: j.key, band: [j.compMinK, j.compMaxK] });
    }
  });

  it("parses the real feed's formats (monitor/comp.py is the authority)", () => {
    expect(viaDb("$151,200 - $204,600")).toEqual([151.2, 204.6]);
    expect(viaDb("$182,000 — $250,208")).toEqual([182, 250.208]); // em dash
    expect(viaDb("$160k-$190k")).toEqual([160, 190]);
    expect(viaDb("$150k+")).toEqual([150, null]); // floor only
    expect(viaDb("up to $130k")).toEqual([null, 130]); // ceiling only
    expect(viaDb("$120,000 USD - $150,000")).toEqual([120, 150]); // currency noise
    expect(viaDb("$185,000")).toEqual([185, 185]); // single stated figure
  });

  it("refuses to guess: non-annual, non-dollar, and absent stay null", () => {
    // The export column header says "$k". A £-band written under it as if it
    // were dollars is a lie; monitor/comp.py can afford to be looser because
    // it only judges a floor.
    expect(viaDb("£85,000 - £110,000")).toEqual([null, null]);
    expect(viaDb("$45/hour")).toEqual([null, null]);
    expect(viaDb("")).toEqual([null, null]);
    expect(viaDb(null)).toEqual([null, null]);
  });
});

describe("pipeline write parity with migration 0010", () => {
  /**
   * The messages the fake returns are the messages the SQL raises.
   *
   * A user meets one of these strings, so the two implementations disagreeing
   * means the demo teaches a behaviour production does not have. There is no way
   * to compare a plpgsql RAISE to a TS return except by asserting the text is in
   * both, which is what these do — the same technique the triage and company
   * blocks above use.
   */
  const src = () => new FixtureDataSource();
  let seq = 0;
  const idem = () => `parity-${++seq}`;

  it("refuses a blank status with the SQL's own message", async () => {
    const res = await src().setStatus({
      applicationId: 3,
      status: "  ",
      idempotencyKey: idem(),
      expectedUpdatedAt: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok && res.kind === "error") expect(PIPELINE_SQL).toContain(res.message);
  });

  it("refuses an empty note with the SQL's own message", async () => {
    const res = await src().addNote({
      applicationId: 3,
      body: "",
      idempotencyKey: idem(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok && res.kind === "error") expect(PIPELINE_SQL).toContain(res.message);
  });

  it("refuses a noteless reopen with the SQL's own message", async () => {
    const res = await src().setStatus({
      applicationId: 5,               // Datadog, Rejected
      status: "Applied",
      idempotencyKey: idem(),
      expectedUpdatedAt: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok && res.kind === "error") expect(PIPELINE_SQL).toContain(res.message);
  });

  it("shares the SQL's bounds, so the UI never discovers one from a Postgres error", () => {
    for (const bound of [
      "status is too long (max 80 characters)",
      "note is too long (max 4000 characters)",
      "next action is too long (max 500 characters)",
      "idempotency key required",
    ]) {
      expect(PIPELINE_SQL, `SQL is missing the bound ${bound}`).toContain(bound);
    }
  });

  it("keeps the word the conflict path matches on", () => {
    // supabase-source.ts decides between the conflict branch and a generic
    // "Couldn't save that" by matching /conflict|stale/i. Rewording the
    // exception turns a handled conflict into an unhandled error.
    expect(PIPELINE_SQL).toContain("raise exception 'conflict: this application changed");
  });

  it("blankTrim trims exactly what hq_blank_trim trims, character by character", () => {
    // The PREVIOUS version of this test asserted three substrings were present in
    // the SQL, all of them inside the unicode tail — so deleting `\t` from the
    // migration left all 444 vitest tests green. A pin that only checks the part
    // nobody edits is not a pin.
    //
    // This one extracts the SQL's own character classes by their markers, expands
    // the ranges, and runs every codepoint through BOTH implementations. It is the
    // closest thing to executing the plpgsql from here, and it is what caught the
    // `\v`-is-the-letter-v corruption staying invisible.
    const zeroWidth = /\/\* HQ_BLANK_ZERO_WIDTH \*\/ '\[([^\]]*)\]'/.exec(PIPELINE_SQL);
    // `(.*?)\]\+'` and not `[^\]]*`: the class contains `[:space:]`, whose own
    // `]` truncated the capture and made the marker look absent.
    const separators = /\/\* HQ_BLANK_SEPARATORS \*\/\s*\n\s*'\^\[(.*?)\]\+'/.exec(
      PIPELINE_SQL,
    );
    expect(zeroWidth, "HQ_BLANK_ZERO_WIDTH marker not found in the SQL").toBeTruthy();
    expect(separators, "HQ_BLANK_SEPARATORS marker not found in the SQL").toBeTruthy();

    /** Expand a Postgres regex character class into the codepoints it matches. */
    function expand(cls: string): Set<number> {
      const out = new Set<number>();
      // `[[:space:]]` is POSIX: space, tab, newline, vertical tab, form feed, CR.
      let body = cls;
      if (body.includes("[:space:]")) {
        for (const c of [0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]) out.add(c);
        body = body.replace("[:space:]", "");
      }
      // \uXXXX escapes, optionally as a range.
      const token = /\\u([0-9A-Fa-f]{4})(?:-\\u([0-9A-Fa-f]{4}))?/g;
      let m: RegExpExecArray | null;
      let consumed = 0;
      while ((m = token.exec(body)) !== null) {
        consumed += m[0].length;
        const lo = parseInt(m[1], 16);
        const hi = m[2] ? parseInt(m[2], 16) : lo;
        for (let c = lo; c <= hi; c++) out.add(c);
      }
      // Anything left over is a literal this parser does not understand, and a
      // silent skip is how the old pin failed. Fail instead.
      expect(consumed, `unparsed characters in SQL class ${JSON.stringify(cls)}`).toBe(
        body.length,
      );
      return out;
    }

    const sqlZeroWidth = expand(zeroWidth![1]);
    const sqlSeparators = expand(separators![1]);
    // Guard against a regex that matched but captured nothing.
    expect(sqlZeroWidth.size).toBeGreaterThanOrEqual(4);
    expect(sqlSeparators.size).toBeGreaterThanOrEqual(20);

    // The two halves of the SQL's second class must be identical — it is written
    // twice (once anchored at each end), and a divergence would trim one end only.
    const tail = /'\|\[(.*?)\]\+\$'/.exec(PIPELINE_SQL);
    expect(tail, "the trailing-edge class was not found").toBeTruthy();
    expect(tail![1]).toBe(separators![1]);

    // Now the actual comparison: for every codepoint either side claims, the two
    // implementations must agree about whether it is padding.
    const candidates = new Set<number>([...sqlZeroWidth, ...sqlSeparators]);
    // Plus everything JS `\s` matches below U+3001, so a character the SQL forgot
    // is caught rather than simply absent from both lists.
    for (let c = 0; c <= 0x3001; c++) if (/\s/.test(String.fromCodePoint(c))) candidates.add(c);

    const disagreements: string[] = [];
    for (const c of candidates) {
      const ch = String.fromCodePoint(c);
      const sqlTrims = sqlZeroWidth.has(c) || sqlSeparators.has(c);
      const jsTrims = blankTrim(`${ch}x${ch}`) === "x" && blankTrim(ch) === "";
      if (sqlTrims !== jsTrims) {
        disagreements.push(
          `U+${c.toString(16).toUpperCase().padStart(4, "0")}: sql=${sqlTrims} js=${jsTrims}`,
        );
      }
    }
    expect(disagreements).toEqual([]);

    // And the corruption case, spelled out: a leading letter is not padding.
    expect(blankTrim("verify comp band")).toBe("verify comp band");
    expect(blankTrim("v")).toBe("v");
    // The SQL must not carry a btrim character LIST any more — that shape is what
    // turned `\v` into the letter v, and it reads identically to a regex class.
    expect(PIPELINE_SQL).not.toMatch(/btrim\(\s*\n?\s*regexp_replace/);
  });

  it("reject leaves status alone in the SQL as well as in the fake", () => {
    // Matrix row 42, asserted on both sides. The fake's behaviour is covered in
    // pipeline-source.test.ts; this is the half that would catch someone
    // "simplifying" the SQL's two branches into one update.
    const fn = PIPELINE_SQL.slice(
      PIPELINE_SQL.indexOf("function public.app_resolve_suggestion"),
      PIPELINE_SQL.indexOf("revoke all on function public.app_resolve_suggestion"),
    );
    expect(fn).toBeTruthy();
    // Comments stripped first. The reject branch EXPLAINS itself in a comment
    // that names the columns it leaves alone, so a checker reading prose would
    // fail on the correct code — the exact trap `_strip_sql_comments` exists for
    // in tests/core/test_migrations.py.
    // Bounded to the branch's UPDATE — `else` to its `end if` — and not to the
    // rest of the body. Both branches legitimately mention `v_suggested`
    // afterwards, because the audit event records what was suggested either way;
    // a slice that ran to the end of the function would fail on that and say
    // nothing about the update.
    const branchStart = fn.indexOf("else", fn.indexOf("if p_decision = 'confirm'"));
    const reject = fn
      .slice(branchStart, fn.indexOf("end if;", branchStart))
      .replace(/--[^\n]*/g, "");
    expect(reject).toContain("set suggested_status = ''");
    expect(reject).toContain("update public.applications");
    // The two things reject must not do: apply the suggestion, or claim the row.
    expect(reject).not.toContain("v_suggested");
    expect(reject).not.toContain("status_actor");
    // And it must not declare itself a human status write, because it is not one.
    expect(reject).not.toContain("hq.status_write");
  });

  it("declares the human write and clears the flag again", () => {
    // The lock's escape hatch is a transaction-local session flag, so the thing
    // that matters is that it is CLEARED: a flag left standing unlocks every
    // later write in the same transaction. Set/clear must come in pairs.
    const setters = PIPELINE_SQL.match(/set_config\('hq\.status_write', 'human', true\)/g) ?? [];
    const clearers = PIPELINE_SQL.match(/set_config\('hq\.status_write', '', true\)/g) ?? [];
    expect(setters.length).toBeGreaterThan(0);
    expect(clearers.length).toBe(setters.length);
    // And the trigger must NOT be the naive version, which an already-locked row
    // satisfies for free because an UPDATE inherits unmentioned columns.
    expect(PIPELINE_SQL).toContain(
      "coalesce(current_setting('hq.status_write', true), '') = 'human'",
    );
    // And the latch guards ITSELF: `update … set status_actor='system'` was a
    // one-statement unlock, so the trigger refuses an undeclared change to the
    // actor column too.
    expect(PIPELINE_SQL).toContain("new.status_actor is distinct from old.status_actor");
  });

  it("every column APPLICATION_COLS reads is in app_application_row's shape", () => {
    // Two shapes reach toApplicationView — a PostgREST select and the function's
    // jsonb — and a key present in one and absent from the other renders blanks
    // only on the path nothing happened to test. `app_company_row` lost
    // `updated_at` this way once and the whole suite stayed green.
    const row = PIPELINE_SQL.slice(
      PIPELINE_SQL.indexOf("function public.app_application_row"),
      PIPELINE_SQL.indexOf("revoke all on function public.app_application_row"),
    );
    expect(row).toBeTruthy();
    for (const key of [
      "id", "posting_key", "company", "title", "url", "status", "status_actor",
      "suggested_status", "evidence", "applied_date", "next_action",
      "next_action_date", "notes", "updated_at",
      // The three derived ones the view model needs and no column supplies.
      "posting_status", "note_count", "latest_note",
    ]) {
      expect(row, `app_application_row omits '${key}'`).toContain(`'${key}'`);
    }
  });

  it("orders the note embed deterministically on both sides", () => {
    // Two notes written in the same millisecond would otherwise be ordered by
    // whatever the plan produced, and `latestNote` would flip between reads —
    // the same undefined tie that queue ordering was pinned for above.
    expect(PIPELINE_SQL).toContain("order by n.created_at desc, n.id desc");
    const ts = readFileSync(
      path.join(REPO, "webapp", "lib", "data", "supabase-source.ts"),
      "utf8",
    );
    expect(ts).toContain('referencedTable: "application_notes", ascending: false');
  });
});

describe("import parity with migration 0011", () => {
  /**
   * The import half, which had no section here at all.
   *
   * `SupabaseDataSource`'s ten import methods were never instantiated by any
   * test — the fake carried the whole feature's behaviour and nothing compared
   * the two. What can be compared without a database is what the rest of this
   * file compares: the messages a user meets, the bounds a caller can hit, and
   * the two numbers the two implementations each chose for themselves.
   */
  const src = () => new FixtureDataSource();

  it("clamps a commit chunk the way the SQL clamps it, including limit 0", async () => {
    // `least(greatest(coalesce(p_limit, 200), 1), 500)`: 0 is not NULL, so it is
    // raised to 1 — one row. The fake used `input.limit || 200`, which reads 0 as
    // absent and committed the whole batch. A caller sending 0 saw one row in
    // production and 200 in the demo.
    expect(IMPORT_SQL).toContain("least(greatest(coalesce(p_limit, 200), 1), 500)");

    const store = src();
    const created = await store.createImport({
      filename: "f.csv", sourceKind: "csv", contentHash: "h", rowCount: 3,
      idempotencyKey: "clamp-1",
    });
    if (!created.ok) throw new Error("createImport failed");
    const batchId = created.batch.id;
    await store.stageImportRows({
      batchId,
      rows: [1, 2, 3].map((n) => ({ rowNumber: n, raw: {} })),
    });
    await store.setImportMapping({
      batchId,
      rows: [1, 2, 3].map((n) => ({
        rowNumber: n,
        mapped: { company: `Co ${n}`, title: "PM", status: "Applied" },
        jobKey: `greenhouse-77${n}`,
        keyStrength: "strong" as const,
      })),
      mapping: { headers: [], headerRowIndex: 0, columnMap: {}, statusMap: {}, roundTrip: false, unmapped: [] },
      final: true,
      expectedUpdatedAt: null,
    });
    await store.previewImport(batchId);

    const chunk = await store.commitImportChunk({ batchId, limit: 0, idempotencyKey: "clamp-c1" });
    expect(chunk.ok && chunk.created, "limit 0 committed more than one row").toBe(1);
    expect(chunk.ok && chunk.remaining).toBe(2);
  });

  it("shares the SQL's own refusal messages, so the demo teaches production", async () => {
    const tooMany = await src().createImport({
      filename: "big.csv", sourceKind: "csv", contentHash: "h", rowCount: 5001,
      idempotencyKey: "parity-rows",
    });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok && tooMany.kind === "error") {
      // The SQL's sentence carries `%` placeholders, so the shared half is
      // asserted rather than the whole string.
      expect(tooMany.message).toMatch(/the limit is 5000/);
      expect(IMPORT_SQL).toContain("split it and import in parts");
    }
    for (const bound of [
      "idempotency key required",
      "unsupported import source",
      "imports still in progress",
    ]) {
      expect(IMPORT_SQL, `SQL is missing the bound ${bound}`).toContain(bound);
    }
  });

  it("the landing list is bounded to the same number on both sides", async () => {
    // `IMPORT_LIST_LIMIT` is now one constant that both implementations read; the
    // fake used to be unbounded, so a demo with 60 batches rendered a list
    // production truncates at 25.
    expect(IMPORT_LIST_LIMIT).toBe(25);
    const store = src();
    // Each batch is carried all the way to `committed`, because a batch left
    // open counts against `app_import_create`'s in-progress cap of 20 — which is
    // below the list limit, so the list can only ever exceed 25 with finished
    // batches in it. That is worth knowing and is why this loop is not three
    // lines.
    for (let i = 0; i < IMPORT_LIST_LIMIT + 5; i += 1) {
      const created = await store.createImport({
        filename: `f${i}.csv`, sourceKind: "csv", contentHash: `h${i}`, rowCount: 1,
        idempotencyKey: `list-${i}`,
      });
      if (!created.ok) throw new Error(`createImport ${i} failed: ${JSON.stringify(created)}`);
      const id = created.batch.id;
      await store.stageImportRows({ batchId: id, rows: [{ rowNumber: 1, raw: {} }] });
      await store.setImportMapping({
        batchId: id,
        rows: [{
          rowNumber: 1,
          mapped: { company: `List Co ${i}`, title: "PM", status: "Applied" },
          jobKey: `greenhouse-88${i}`,
          keyStrength: "strong" as const,
        }],
        mapping: { headers: [], headerRowIndex: 0, columnMap: {}, statusMap: {}, roundTrip: false, unmapped: [] },
        final: true,
        expectedUpdatedAt: null,
      });
      await store.previewImport(id);
      await store.commitImportChunk({ batchId: id, limit: 200, idempotencyKey: `list-c-${i}` });
    }
    expect((await store.imports()).length).toBe(IMPORT_LIST_LIMIT);
  });

  it("every hand-copied MAX_CHUNK is the same number", () => {
    // 1000 is written out in four places across two languages — the stage RPC,
    // the mapping RPC, the upload route and the mapping action — and a chunk
    // larger than the function accepts is refused mid-import, after some of the
    // rows have already landed. There was no drift test.
    const fromSql = [...IMPORT_SQL.matchAll(/MAX_CHUNK\s+constant integer := (\d+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(fromSql.length, "no MAX_CHUNK declarations found in 0011").toBeGreaterThanOrEqual(2);

    const route = readFileSync(
      path.join(REPO, "webapp", "app", "api", "import", "upload", "route.ts"),
      "utf8",
    );
    const actions = readFileSync(
      path.join(REPO, "webapp", "app", "(app)", "import", "actions.ts"),
      "utf8",
    );
    const stage = /const STAGE_CHUNK = (\d+);/.exec(route);
    const mapping = /const MAPPING_CHUNK = (\d+);/.exec(actions);
    expect(stage, "STAGE_CHUNK not found in the upload route").toBeTruthy();
    expect(mapping, "MAPPING_CHUNK not found in the import actions").toBeTruthy();

    expect(new Set([...fromSql, Number(stage![1]), Number(mapping![1])]).size, "MAX_CHUNK drifted").toBe(1);
  });
});
