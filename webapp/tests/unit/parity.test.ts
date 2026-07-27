import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import { IMPORT_LIST_LIMIT, MAX_CONNECTION_CHUNK } from "@/lib/data/source";
import { CONNECTION_SOURCE_TAGS } from "@/lib/referral/connections";
import { isLinkedinId } from "@/lib/referral/linkedin";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";
import { CADENCE, SupabaseDataSource, toCompanyView, toJobView } from "@/lib/data/supabase-source";
import { blankTrim, companyNameKey, PROPOSE_SOURCE_TAGS } from "@/lib/data/view-models";
import { ANSWER_KINDS, engineRules, parseSituationFact } from "@/lib/apply/views";
import { prepareApplication } from "@/lib/apply/prepare";
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
const REFERRAL_SQL = readFileSync(
  path.join(REPO, "db", "migrations", "0013_referral.sql"),
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
    taggedAt: STAMP,
    country: "United States",
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
      linkedinCompanyId: "",
      companyUpdatedAt: null,
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

describe("connections import parity with migration 0013", () => {
  /**
   * The referral finder's write path, pinned to the SQL it mirrors.
   *
   * Same argument as the import section above and the same technique: the
   * numbers, the closed sets and the refusal messages are hand-copied across two
   * languages, and every one of them is a place the fake can be kinder than
   * Postgres. The consequence here is a paste box or an upload that works in the
   * demo and is refused in production, which is the failure mode matrix row 172
   * is a list of.
   *
   * The function's own text is sliced out first rather than searched for across
   * the whole migration — 0013 declares constants in more than one place, and a
   * bare `indexOf` over the file would happily pin the wrong one.
   */
  const IMPORT_FN = REFERRAL_SQL.slice(
    REFERRAL_SQL.indexOf("function public.app_import_connections"),
    REFERRAL_SQL.indexOf("revoke all on function public.app_import_connections"),
  );
  const SET_ID_FN = REFERRAL_SQL.slice(
    REFERRAL_SQL.indexOf("function public.app_set_linkedin_company_id"),
    REFERRAL_SQL.indexOf("revoke all on function public.app_set_linkedin_company_id"),
  );

  it("sliced the two functions it is about to read", () => {
    // The guard on the technique. A renamed function makes both slices empty, and
    // every `toContain` below then passes against nothing — the shape of pin that
    // this repo has already been bitten by twice.
    expect(IMPORT_FN, "app_import_connections not found in 0013").toContain("MAX_CHUNK");
    expect(SET_ID_FN, "app_set_linkedin_company_id not found in 0013").toContain("digits only");
    expect(IMPORT_FN.length).toBeGreaterThan(500);
    expect(SET_ID_FN.length).toBeGreaterThan(500);
  });

  it("chunks at the number the SQL refuses past", () => {
    // A chunk larger than the function accepts is refused mid-import, after some
    // of the rows have already landed — the same failure 0011's MAX_CHUNK pin
    // exists for, on a second table.
    const fromSql = /MAX_CHUNK\s+constant int(?:eger)? := (\d+);/.exec(IMPORT_FN);
    expect(fromSql, "no MAX_CHUNK declaration in app_import_connections").toBeTruthy();
    expect(MAX_CONNECTION_CHUNK).toBe(Number(fromSql![1]));
  });

  it("accepts exactly the provenance tags the SQL allows", () => {
    // `source` is a reporting dimension and the function is granted to
    // `authenticated`, so the set is closed at the door. A tag the UI offers and
    // the SQL refuses is a button that fails only in production.
    const array = /ALLOWED_SOURCES\s+constant text\[\] := array\[([^\]]*)\]/.exec(IMPORT_FN);
    expect(array, "no ALLOWED_SOURCES declaration in app_import_connections").toBeTruthy();
    const fromSql = [...array![1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(fromSql.length).toBeGreaterThan(0);
    // Set equality in BOTH directions: a tag the SQL allows and the UI never
    // offers is dead vocabulary, and the other way round is a broken gesture.
    expect([...CONNECTION_SOURCE_TAGS].sort()).toEqual([...fromSql].sort());
  });

  it("enforces the SAME digits-only pattern the SQL enforces, anchors and all", () => {
    // Three layers agree on one closed set — the paste form, the URL builder and
    // the database — because the COLUMN is deliberately free-vocab (0008's
    // `source` precedent). Drift here means the UI ships a paste Postgres refuses,
    // or worse, accepts one it should not.
    //
    // The anchors are the point: an unanchored `~ '[0-9]{1,20}'` matches the
    // digits INSIDE `javascript:1` and lets the whole string through.
    const fromSql = /!~ '(\^\[0-9\]\{1,20\}\$)'/.exec(SET_ID_FN);
    expect(fromSql, "no anchored digits-only pattern in app_set_linkedin_company_id").toBeTruthy();
    expect(fromSql![1]).toBe("^[0-9]{1,20}$");

    // The fake's literal and the builder's literal, read out of their own source
    // rather than assumed — the same technique the note-ordering pin above uses.
    for (const file of [
      path.join(REPO, "webapp", "lib", "data", "fixture-source.ts"),
      path.join(REPO, "webapp", "lib", "referral", "linkedin.ts"),
    ]) {
      expect(readFileSync(file, "utf8"), `${path.basename(file)} does not carry the SQL's pattern`)
        .toContain(`/${fromSql![1]}/`);
    }

    // And the behaviour, compiled from the migration's own text: for every string
    // either side could meet, the predicate the UI validates with and the regexp
    // Postgres checks with must answer the same thing.
    const sqlRe = new RegExp(fromSql![1]);
    for (const value of [
      "1035",
      "0",
      "1".repeat(20),
      "1".repeat(21),
      "javascript:1",
      "1035; DROP",
      "ramp",
      "10 35",
      "",
      "-1",
      "1e3",
      "1035\n",
    ]) {
      expect(isLinkedinId(value), `disagreement on ${JSON.stringify(value)}`).toBe(
        sqlRe.test(value.trim()),
      );
    }
  });

  it("returns the refusals in the SQL's own words", async () => {
    // A user meets these strings, so the two implementations disagreeing means
    // the demo teaches a behaviour production does not have. There is no way to
    // compare a plpgsql RAISE to a TS return except by asserting the shared half
    // is in both — the SQL's sentences carry `%` placeholders.
    const src = new FixtureDataSource();
    let n = 0;
    const key = () => `referral-parity-${++n}`;

    const badId = await src.setLinkedinCompanyId({
      companyId: 101,
      linkedinId: "javascript:1",
      idempotencyKey: key(),
      expectedUpdatedAt: null,
    });
    expect(badId).toMatchObject({ ok: false, kind: "error" });
    if (badId.ok || badId.kind !== "error") throw new Error("unreachable");
    expect(SET_ID_FN).toContain("a LinkedIn company id is digits only (got %)");
    expect(badId.message).toContain("a LinkedIn company id is digits only (got ");

    const notMine = await src.setLinkedinCompanyId({
      companyId: 999_999,
      linkedinId: "1035",
      idempotencyKey: key(),
      expectedUpdatedAt: null,
    });
    expect(notMine).toMatchObject({ ok: false, kind: "error" });
    if (notMine.ok || notMine.kind !== "error") throw new Error("unreachable");
    expect(SET_ID_FN).toContain("no such company for this user: %");
    expect(notMine.message).toContain("no such company for this user: ");

    const tooMany = await src.importConnections({
      rows: Array.from({ length: MAX_CONNECTION_CHUNK + 1 }, (_, i) => ({
        fullName: `P${i}`, firstName: "", lastName: "", company: "", title: "",
        profileUrl: "", connectedOn: null,
      })),
      source: "linkedin-export",
      idempotencyKey: key(),
    });
    expect(tooMany).toMatchObject({ ok: false, kind: "error" });
    if (tooMany.ok || tooMany.kind !== "error") throw new Error("unreachable");
    expect(IMPORT_FN).toContain("too many connections in one call (limit %)");
    expect(tooMany.message).toContain("too many connections in one call (limit ");

    const badTag = await src.importConnections({
      rows: [],
      source: "a-novel-about-provenance",
      idempotencyKey: key(),
    });
    expect(badTag).toMatchObject({ ok: false, kind: "error" });
    if (badTag.ok || badTag.kind !== "error") throw new Error("unreachable");
    expect(IMPORT_FN).toContain("unknown source tag: %");
    expect(badTag.message).toContain("unknown source tag: ");

    // The bounds the UI must never discover from a Postgres error.
    for (const bound of ["idempotency key required", "rows must be an array"]) {
      expect(REFERRAL_SQL, `SQL is missing the bound ${bound}`).toContain(bound);
    }
  });

  it("keeps the word the conflict path matches on", () => {
    // `supabase-source.ts` decides between the conflict branch and a generic
    // failure by matching /conflict|stale/i on the message. Rewording the
    // exception turns a handled conflict into an unhandled error — and this one
    // guards the SHARED company row, where a clobber is another user's paste.
    expect(SET_ID_FN).toContain("raise exception 'conflict: this company changed");
    // …and it checks the COMPANY row's token, not the subscription's. A fake
    // reading the wrong one is the divergence `connections-fixture.test.ts`
    // exercises from the other side.
    expect(SET_ID_FN).toContain("v_row.updated_at is distinct from p_expected_updated_at");
  });

  it("implements the promotion pass on BOTH sides, not only in SQL", async () => {
    // The pin that was missing, and its absence was measured rather than
    // theorised: this section pinned MAX_CHUNK, the source tags, the id regexp
    // and every refusal string, and pinned NOTHING about promotion — so the fake
    // shipped without the pass entirely. Production answered `{inserted: 0,
    // updated: 1}` with one row; the fake answered `{inserted: 1, updated: 0}`
    // with two, minting the permanent duplicate matrix row 229 exists to prevent
    // in the demo and in every E2E run.
    //
    // Pinned as BEHAVIOUR first (the numbers the two must agree on) and as text
    // second (the three clauses that produce them), because a text pin alone
    // would pass on a fake that had the clauses and used them wrongly.
    const sql = REFERRAL_SQL.slice(
      REFERRAL_SQL.indexOf("-- PROMOTION: a row this person already has"),
      REFERRAL_SQL.indexOf("-- Rows the export gave a profile URL"),
    );
    expect(sql, "the promotion pass is gone from 0013").toContain(
      "update public.connections c",
    );
    expect(sql).toContain("set profile_url = i.profile_url");
    expect(sql, "the `not exists` collision guard is gone").toContain("not exists (");
    expect(sql, "the deterministic join partner is gone").toContain("distinct on (");
    expect(sql).toContain("order by lower(r.full_name), public.company_name_key(r.company), lower(r.profile_url)");

    const fake = readFileSync(path.join(REPO, "webapp", "lib", "data", "fixture-source.ts"), "utf8");
    expect(fake, "the fake has no promotion pass").toContain("THE PROMOTION PASS");

    const src = new FixtureDataSource([], [], [], [], undefined, []);
    await src.importConnections({
      rows: [{ fullName: "Ada Okonkwo", firstName: "", lastName: "", company: "Ramp", title: "PM", profileUrl: "", connectedOn: null }],
      source: "linkedin-export",
      idempotencyKey: "promotion-1",
    });
    const promoted = await src.importConnections({
      rows: [{ fullName: "Ada Okonkwo", firstName: "", lastName: "", company: "Ramp", title: "", profileUrl: "https://www.linkedin.com/in/ada", connectedOn: null }],
      source: "linkedin-export",
      idempotencyKey: "promotion-2",
    });
    // The exact four numbers real Postgres answers for this input (verified in
    // `tests/db/test_referral.py`). A fake that reports a DIFFERENT report than
    // production is worse than one that is merely more forgiving.
    expect(promoted).toEqual({ ok: true, inserted: 0, updated: 1, skipped: 0, deduped: 0 });
    expect(await src.connections()).toHaveLength(1);
  });

  it("reads the connections list in one order, bounded the same way, on both sides", () => {
    // The cap decides WHICH rows survive it, so an undefined tie is a list whose
    // contents change between reads — the same failure the queue ordering at the
    // top of this file was pinned for.
    const ts = readFileSync(path.join(REPO, "webapp", "lib", "data", "supabase-source.ts"), "utf8");
    expect(ts).toContain('.order("full_name", { ascending: true })');
    expect(ts).toContain('.order("id", { ascending: true })');
    expect(ts).toContain(".limit(CONNECTION_LIST_LIMIT)");
    const fake = readFileSync(path.join(REPO, "webapp", "lib", "data", "fixture-source.ts"), "utf8");
    expect(fake).toContain("a.fullName.localeCompare(b.fullName) || a.id - b.id");
    expect(fake).toContain("slice(0, CONNECTION_LIST_LIMIT)");
  });

  it("mirrors the SQL's identity for a connection, including its blank semantics", () => {
    // `hq_connection_rows` is the single definition of what a connection row IS,
    // and the fake reimplements it. Two halves are worth pinning by text because
    // they are the ones a "simplification" would quietly change: the ident (a
    // lower-cased URL, else name + company_name_key) and the LAST-occurrence rule.
    expect(IMPORT_FN.length).toBeGreaterThan(0);
    const rowsFn = REFERRAL_SQL.slice(
      REFERRAL_SQL.indexOf("function public.hq_connection_rows"),
      REFERRAL_SQL.indexOf("revoke all on function public.hq_connection_rows"),
    );
    expect(rowsFn, "hq_connection_rows not found in 0013").toContain("is_dupe");
    expect(rowsFn).toContain("'u:' || lower(b.profile_url)");
    expect(rowsFn).toContain("'n:' || lower(b.full_name) || '|' || public.company_name_key(b.company)");
    // LAST occurrence wins, and the ORDER BY inside the window is spelled out —
    // without it the winner is whatever the plan produced.
    expect(rowsFn).toContain("row_number() over (partition by k.ident order by k.n desc) > 1");
    // `hq_blank_trim`, never bare `btrim`: a cell holding one NBSP is blank to
    // Postgres and would be CONTENT to a bare trim (matrix rows 110, 129, 151).
    expect(rowsFn).toContain("public.hq_blank_trim(coalesce(e ->> 'full_name'");
    expect(rowsFn).not.toMatch(/\bbtrim\(/);
    // The fake goes through the same mirror rather than `.trim()`.
    const fake = readFileSync(path.join(REPO, "webapp", "lib", "data", "fixture-source.ts"), "utf8");
    const importFake = fake.slice(
      fake.indexOf("async importConnections("),
      fake.indexOf("async clearConnections("),
    );
    expect(importFake.length).toBeGreaterThan(500);
    expect(importFake).toContain("blankTrim(r.fullName)");
    expect(importFake).not.toMatch(/r\.\w+\.trim\(\)/);
  });

  it("derives deduped by SUBTRACTION on both sides, so the four numbers close", () => {
    // Matrix row 169. `deduped` has to absorb BOTH ways a named line lands
    // nowhere — the same person twice in a chunk, and a URL-less line shadowed by
    // a record that already carries the URL. Counting the first and forgetting
    // the second is exactly how a report starts adding up to less than the file.
    //
    // Sliced to the RESULT object rather than searched for across the function:
    // the audit event above it builds the same four keys, so a `toContain` over
    // the whole body stays green while the returned report is zeroed. Watched:
    // that mutant survived the first version of this assertion.
    const result = IMPORT_FN.slice(IMPORT_FN.indexOf("v_result := jsonb_build_object("));
    const returned = result.slice(0, result.indexOf(";"));
    expect(returned, "the result object was not found").toContain("'inserted', v_inserted");
    expect(returned).toContain("'deduped',  v_named - v_inserted - v_updated");
    const fake = readFileSync(path.join(REPO, "webapp", "lib", "data", "fixture-source.ts"), "utf8");
    expect(fake).toContain("deduped: named.length - inserted - updated");
    // And the guard that makes `skipped` the OTHER difference rather than a
    // second name for the same thing.
    expect(returned).toContain("'skipped',  v_total - v_named");
    expect(fake).toContain("skipped: input.rows.length - named.length");
  });
});

// ---------------------------------------------------- the answer library (0014)

/**
 * `app_upsert_answer`, `app_set_policy_rule` and `app_delete_policy_rule` are the
 * only write path to the answer library, and `FixtureDataSource` reimplements all
 * three. The engine that reads what they store is judged on one metric — "wrong
 * knockout answers (must be zero, ever)" — so a fake that accepts a row Postgres
 * refuses is not a demo bug: it is a demo staging an application the database
 * could never have produced.
 *
 * Matrix row 238 is the standard this section is written to. Pinning the SQL's
 * clauses by text is not enough on its own, because a fake can hold every clause
 * and misuse it; where a number, a list or a regexp exists on both sides it is
 * EXTRACTED from the migration and then executed.
 */
const APPLY_SQL = readFileSync(
  path.join(REPO, "db", "migrations", "0014_apply_answers.sql"),
  "utf8",
);

const SET_RULE_FN = APPLY_SQL.slice(
  APPLY_SQL.indexOf("function public.app_set_policy_rule"),
  APPLY_SQL.indexOf("revoke all on function public.app_set_policy_rule"),
);
const DELETE_RULE_FN = APPLY_SQL.slice(
  APPLY_SQL.indexOf("function public.app_delete_policy_rule"),
  APPLY_SQL.indexOf("revoke all on function public.app_delete_policy_rule"),
);

/**
 * 0017 — the scope column, the decline flag and the answer delete.
 *
 * Read as its own file rather than folded into `APPLY_SQL`, because
 * `app_upsert_answer` now exists TWICE across the migrations and a slice over
 * the concatenation would read whichever came first. The database ends up with
 * the last one; so does this.
 */
const SCOPE_SQL = readFileSync(
  path.join(REPO, "db", "migrations", "0017_answer_scope.sql"),
  "utf8",
);

/**
 * Every migration, in the order Postgres applies them.
 *
 * Needed for a pin about the LIVE schema rather than about one file's text. The
 * failure it exists for: `parity.test.ts` asserted 0014 creates
 * `answers_user_question_key_uk` — an index 0017 DROPS — and passed forever by
 * reading history, while nothing anywhere pinned the index that replaced it. Same
 * class as `_sql_function_params` reading a function's first definition, one
 * screen above the fix for it.
 */
const MIGRATIONS_IN_ORDER: string[] = readdirSync(path.join(REPO, "db", "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(path.join(REPO, "db", "migrations", f), "utf8"));

/** `/* … *​/` and `-- …`, gone. See `stripSql`'s note. */
function stripSql(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/**
 * COMMENTS STRIPPED, and watched red without it.
 *
 * `indexFate` below reads the last statement that mentions an index. Commenting
 * out 0017's `drop index` left the phrase in the file, the regex matched it, and
 * the pin stayed green on a migration that no longer drops anything — the
 * `_strip_sql_comments` lesson (`tests/core/test_migrations.py`: "a checker that
 * reads prose is a checker that will be worked around by rewording") arriving on
 * the guard written to close a guard that read history.
 */
const ALL_MIGRATIONS_SQL = MIGRATIONS_IN_ORDER.map(stripSql).join("\n");

/**
 * What the LAST statement mentioning an index does to it — `create` or `drop`.
 *
 * Reading the last mention is what makes this a statement about the live schema:
 * an index created in one migration and dropped in a later one does not exist, and
 * a name that reappears in a migration after the drop does.
 */
function indexFate(name: string): "create" | "drop" | "absent" {
  const hits = [...ALL_MIGRATIONS_SQL.matchAll(new RegExp(`(create|drop)[^;]*?index[^;]*?\\b${name}\\b`, "gi"))];
  if (hits.length === 0) return "absent";
  return hits[hits.length - 1][1].toLowerCase() as "create" | "drop";
}
/**
 * The LIVE `app_upsert_answer` — 0017's, not 0014's.
 *
 * The same trap `tests/core/test_migrations.py::_sql_function_params` grew a
 * comment for: a function defined in two migrations is, in the database, the
 * later one. Slicing the earlier definition pins bounds and an ordering that
 * nothing executes any more, which is a guard reading history (rows 92, 130).
 */
const UPSERT_ANSWER_FN = SCOPE_SQL.slice(
  SCOPE_SQL.indexOf("function public.app_upsert_answer"),
  SCOPE_SQL.indexOf("revoke all on function public.app_upsert_answer"),
);
const DELETE_ANSWER_FN = SCOPE_SQL.slice(
  SCOPE_SQL.indexOf("function public.app_delete_answer"),
  SCOPE_SQL.indexOf("revoke all on function public.app_delete_answer"),
);

const APPLY_FAKE_SRC = readFileSync(
  path.join(REPO, "webapp", "lib", "data", "fixture-source.ts"),
  "utf8",
);
const APPLY_SUPABASE_SRC = readFileSync(
  path.join(REPO, "webapp", "lib", "data", "supabase-source.ts"),
  "utf8",
);

/** One well-formed value per fact kind, for the CHECK-coverage test below. */
const WELLFORMED_FACT: Record<string, unknown> = {
  boolean: { kind: "boolean", value: true },
  enum: { kind: "enum", value: "none" },
  text: { kind: "text", value: "Chicago, IL" },
  countries: { kind: "countries", value: ["united states"] },
  money: { kind: "money", value: 180000 },
  date: { kind: "date", value: "2026-08-17" },
  directive: { kind: "directive", value: "monday-weeks-out:3" },
};

/** A store with nothing in it, so a write is the only thing that puts a row there. */
function emptyLibraryStore(): FixtureDataSource {
  return new FixtureDataSource(undefined, undefined, undefined, undefined, undefined, undefined, {
    answers: [],
    rules: [],
  });
}

function idem(): string {
  return `t-${Math.random().toString(36).slice(2)}`;
}

type AnswerArgs = Parameters<FixtureDataSource["upsertAnswer"]>[0];
type RuleArgs = Parameters<FixtureDataSource["setPolicyRule"]>[0];

function saveAnswer(src: FixtureDataSource, over: Partial<AnswerArgs> = {}) {
  return src.upsertAnswer({
    question: "What is your favourite colour?",
    answer: "Blue",
    kind: "freeform",
    company: "",
    declined: false,
    provenance: "user-entered",
    idempotencyKey: idem(),
    expectedUpdatedAt: null,
    ...over,
  });
}

function saveRule(src: FixtureDataSource, over: Partial<RuleArgs> = {}) {
  return src.setPolicyRule({
    topic: "relocation",
    company: "",
    fact: { kind: "boolean", value: true },
    provenance: "user-entered",
    note: "",
    enabled: true,
    idempotencyKey: idem(),
    expectedUpdatedAt: null,
    ...over,
  });
}

/**
 * The column list of the FIRST `.from(table).select(...)` in `supabase-source.ts`.
 *
 * A helper rather than a regexp per test, and it tolerates the trailing comma a
 * formatter adds when the list outgrows one line — which is exactly what
 * happened when 0017's two columns joined the `answers` select, and it turned
 * two pins into vacuous nulls until they were asserted non-null.
 */
function selectColumns(table: string): string {
  const m = new RegExp(`\\.from\\("${table}"\\)\\s*\\.select\\(\\s*"([^"]*)",?\\s*\\)`).exec(
    APPLY_SUPABASE_SRC,
  );
  expect(m, `the ${table} select was not found`).not.toBeNull();
  return m![1];
}

/** `/* … *​/` and `// …`, gone. A checker that reads prose is worked around by rewording. */
function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function refusal(result: { ok: boolean }): string {
  expect(result.ok, `expected a refusal, got ${JSON.stringify(result)}`).toBe(false);
  const r = result as unknown as { kind: string; message: string };
  expect(r.kind).toBe("error");
  return r.message;
}

describe("answer library parity with migration 0014", () => {
  it("sliced the three functions it is about to read", () => {
    // Without this every `toContain` below passes against an empty string — the
    // vacuous-guard shape this repo has paid for four times (rows 92, 130, 163, 165).
    expect(UPSERT_ANSWER_FN, "app_upsert_answer not found in 0014").toContain(
      "answer must not be blank",
    );
    expect(SET_RULE_FN, "app_set_policy_rule not found in 0014").toContain("fact must be an object");
    expect(DELETE_RULE_FN, "app_delete_policy_rule not found in 0014").toContain("'deleted', v_deleted");
    expect(UPSERT_ANSWER_FN.length).toBeGreaterThan(500);
    expect(SET_RULE_FN.length).toBeGreaterThan(500);
    expect(DELETE_RULE_FN.length).toBeGreaterThan(500);
  });

  it("refuses what the functions refuse, in the functions' own words", async () => {
    const src = emptyLibraryStore();

    expect(APPLY_SQL).toContain(refusal(await saveAnswer(src, { idempotencyKey: "" })));
    expect(APPLY_SQL).toContain(refusal(await saveAnswer(src, { idempotencyKey: " \n\t" })));
    expect(APPLY_SQL).toContain(refusal(await saveAnswer(src, { answer: "   " })));
    expect(APPLY_SQL).toContain(refusal(await saveAnswer(src, { question: "!!! ???" })));
    // The two length bounds, reported with the number the caller sent.
    expect(refusal(await saveAnswer(src, { question: "x".repeat(2001) }))).toBe(
      "question too long: 2001 characters",
    );
    expect(refusal(await saveAnswer(src, { answer: "x".repeat(8001) }))).toBe(
      "answer too long: 8001 characters",
    );
    expect(APPLY_SQL).toContain(refusal(await saveRule(src, { fact: null as never })));
    expect(refusal(await saveRule(src, { note: "n".repeat(2001) }))).toBe(
      "note too long: 2001 characters",
    );
    expect(refusal(await saveRule(src, { company: "c".repeat(201) }))).toBe(
      "company too long: 201 characters",
    );
    expect(APPLY_SQL).toContain(
      refusal(await src.deletePolicyRule({ topic: "relocation", company: "", idempotencyKey: "" })),
    );
  });

  it("uses the same numeric bounds the functions declare", () => {
    // EXTRACTED, then compared against the behaviour above. A hand-typed 2000
    // here against a 20000 in the migration would leave every assertion green.
    const bound = (fn: string, re: RegExp) => {
      const m = re.exec(fn);
      expect(m, `bound not found: ${re}`).not.toBeNull();
      return Number(m![1]);
    };
    expect(bound(UPSERT_ANSWER_FN, /length\(v_question\) > (\d+)/)).toBe(2000);
    expect(bound(UPSERT_ANSWER_FN, /length\(v_answer\) > (\d+)/)).toBe(8000);
    expect(bound(SET_RULE_FN, /pg_column_size\(p_fact\) > (\d+)/)).toBe(8192);
    expect(bound(SET_RULE_FN, /length\(v_note\) > (\d+)/)).toBe(2000);
    expect(bound(SET_RULE_FN, /length\(v_company\) > (\d+)/)).toBe(200);
    // The idempotency bound is the same on all three, and its BLANK half is the
    // one that matters: `''` is a legal text value and a primary-key component
    // (matrix row 218).
    for (const fn of [UPSERT_ANSWER_FN, SET_RULE_FN, DELETE_RULE_FN]) {
      expect(fn).toContain("public.hq_blank_trim(p_idem) = ''");
      expect(bound(fn, /length\(p_idem\) > (\d+)/)).toBe(200);
    }
  });

  it("is never KINDER than pg_column_size near the fact bound", async () => {
    /**
     * The divergence the pins above missed, in the dangerous direction.
     *
     * Both sides carried the number 8192 and neither compared the MEASUREMENT:
     * the fake counted the UTF-8 bytes of `JSON.stringify(fact)`, Postgres counts
     * `pg_column_size(jsonb)`, and jsonb is bigger than its text because every
     * element carries a 4-byte JEntry. Executed against a real postgres:16 with
     * the value built below:
     *
     *   679 countries -> JSON.stringify   8,068 bytes  (the old fake SAVED it)
     *                 -> pg_column_size   8,765 bytes  (`fact too large: 8765 bytes`)
     *
     * A fake that accepts a row the store refuses is not a demo bug: it is a demo
     * staging an application the database could never have produced.
     */
    const fact = {
      kind: "countries" as const,
      value: Array.from({ length: 679 }, (_, i) => `c${i}-abcd`),
    };
    const textBytes = new TextEncoder().encode(JSON.stringify(fact)).length;
    // The window, pinned in both directions: past the fake's bound, and under the
    // store's — so a fake that took the store's number verbatim would accept it.
    expect(textBytes).toBeGreaterThan(6144);
    expect(textBytes).toBeLessThan(8192);
    const refused = await saveRule(emptyLibraryStore(), { fact });
    expect(refusal(refused)).toMatch(/^fact too large: \d+ bytes$/);

    // The bound is the store's, divided by the worst ratio the ALLOWED shapes can
    // reach (a `countries` array of one-character strings: 5N binary against 4N
    // text). Both numbers are extracted rather than typed, so a change to either
    // side fails here instead of silently reopening the window.
    const sqlBound = Number(/pg_column_size\(p_fact\) > (\d+)/.exec(SET_RULE_FN)![1]);
    const fakeBound = Number(/MAX_FACT_TEXT_BYTES = (\d+)/.exec(APPLY_FAKE_SRC)![1]);
    expect(sqlBound).toBe(8192);
    expect(fakeBound).toBeLessThanOrEqual(sqlBound / 1.25);
    // …and it still accepts the shape it exists for.
    const ok = await saveRule(emptyLibraryStore(), {
      fact: { kind: "countries" as const, value: ["united states", "canada", "united kingdom"] },
    });
    expect(ok.ok).toBe(true);
  });

  it("counts CHARACTERS the way length() does, not UTF-16 units", async () => {
    /**
     * The second divergence, safe direction and still a divergence: `length()` in
     * Postgres counts characters, `String.length` counts UTF-16 code units. A
     * 1,500-emoji question is 1,500 characters there and 3,000 here, so the fake
     * refused `question too long: 3002 characters` for a question the database
     * takes. Executed against real pg: `pg length: 1502`.
     */
    // A letter in front, because the NORMALIZER refuses a question of pure
    // punctuation and this test is about the length bound rather than that one.
    const emoji = `Q ${"🙂".repeat(1499)}`;
    expect(emoji.length).toBe(3000);
    expect([...emoji].length).toBe(1501);
    const src = emptyLibraryStore();
    expect((await saveAnswer(src, { question: emoji })).ok).toBe(true);
    // And the bound itself still bites, in characters.
    expect(refusal(await saveAnswer(src, { question: "🙂".repeat(2001) }))).toBe(
      "question too long: 2001 characters",
    );
    expect(refusal(await saveAnswer(src, { answer: "🙂".repeat(8001) }))).toBe(
      "answer too long: 8001 characters",
    );
    expect(APPLY_FAKE_SRC).toContain("function charLength");
  });

  it("declares exactly the answer kinds the CHECK declares", async () => {
    const check = /answers_kind_is_known[\s\S]*?check \(kind in \(([^)]*)\)\)/.exec(APPLY_SQL);
    expect(check, "answers_kind_is_known not found").not.toBeNull();
    const fromSql = [...check![1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(fromSql.length).toBeGreaterThan(0);
    // Set equality in BOTH directions: a kind added on one side only fails here,
    // rather than being refused at the door of a screen that offers it.
    expect([...ANSWER_KINDS].sort()).toEqual([...fromSql].sort());
    // …and the fake uses the list rather than carrying it decoratively.
    await expect(saveAnswer(emptyLibraryStore(), { kind: "not-a-kind" })).resolves.toMatchObject({
      ok: false,
      kind: "error",
    });
  });

  it("implements exactly the fact kinds the CHECK implements", () => {
    const check =
      /answer_policies_fact_is_wellformed[\s\S]*?case fact ->> 'kind'([\s\S]*?)else false/.exec(
        APPLY_SQL,
      );
    expect(check, "answer_policies_fact_is_wellformed not found").not.toBeNull();
    const fromSql = [...check![1].matchAll(/when '([a-z]+)'\s+then/g)].map((m) => m[1]);
    expect(fromSql.length).toBe(7);
    const implemented = fromSql.filter((kind) => parseSituationFact(WELLFORMED_FACT[kind]) !== null);
    // Every kind the CHECK names is one this build can read. The reverse — a kind
    // this build reads and SQL refuses — cannot be written through the RPC, and
    // the parser's `default: return null` is what keeps it that way.
    expect(implemented.sort()).toEqual([...fromSql].sort());
    expect(parseSituationFact({ kind: "phrase-bank", value: ["a recruiter"] })).toBeNull();
  });

  it("is the STRICTER side on the two shapes SQL cannot check", () => {
    // Stated in `lib/apply/views.ts` and executed here, because a divergence
    // nobody runs is a comment. Both go the same way round: this side refuses
    // rows Postgres accepts, never the reverse.
    //
    // (a) `countries` — SQL checks the ARRAY, never its elements, and
    //     `deriveAnswer` calls `.trim()` on each one.
    expect(APPLY_SQL).toContain("jsonb_array_length(fact -> 'value') > 0");
    expect(parseSituationFact({ kind: "countries", value: ["united states", 5] })).toBeNull();
    expect(parseSituationFact({ kind: "countries", value: ["united states"] })).not.toBeNull();
    // (b) `date` — Postgres's `\d` is `[[:digit:]]`, wider than `[0-9]` in a
    //     UTF-8 database.
    expect(APPLY_SQL).toContain("fact ->> 'value' ~ '^\\d{4}-\\d{2}-\\d{2}$'");
    expect(parseSituationFact({ kind: "date", value: "٢٠٢٦-٠١-٠١" })).toBeNull();
    expect(parseSituationFact({ kind: "date", value: "2026-01-01" })).not.toBeNull();
    // The consequence, executed rather than described: a rule this side cannot
    // read is DROPPED from the engine's input, so the field gaps as
    // `policy-unset` ("you have no rule") rather than `situation-mismatch`
    // ("your rule does not fit"), which would be a sentence about the wrong thing.
    expect(
      engineRules([
        {
          topic: "relocation",
          companyKey: "",
          fact: null,
          provenance: "user-entered",
          authoredBy: "user",
          note: "",
          enabled: true,
          updatedAt: null,
        },
      ]),
    ).toEqual([]);
  });

  it("generates the question key rather than taking one", async () => {
    const src = emptyLibraryStore();
    const first = await saveAnswer(src, { question: "Are you 18 years of age or older?" });
    expect(first).toMatchObject({ ok: true, created: true });
    if (!first.ok) throw new Error("unreachable");
    // Two spellings of one question are ONE row: the unique index is on the
    // generated key, and 0001's primary key was on the raw text.
    const second = await saveAnswer(src, {
      question: "ARE YOU 18 YEARS OF AGE OR OLDER?",
      answer: "Yes",
      expectedUpdatedAt: first.answer.updatedAt,
    });
    expect(second).toMatchObject({ ok: true, created: false });
    const rows = await src.answers();
    expect(rows).toHaveLength(1);
    expect(rows[0].answer).toBe("Yes");
    expect(APPLY_SQL).toContain("generated always as (public.hq_question_key(question)) stored");
    // The LIVE identity index, and the death of the one it replaced. Asserted by
    // last-mention across every migration in order rather than by the text of the
    // file that happens to name it: the previous version pinned
    // `answers_user_question_key_uk`, which 0017 drops, so it passed by reading
    // history while nothing pinned the index that actually enforces this row.
    expect(indexFate("answers_user_question_scope_uk")).toBe("create");
    expect(indexFate("answers_user_question_key_uk")).toBe("drop");
    // …and the scoped one really is the scoped one, so a rename to the live name
    // over the old single-column definition cannot satisfy the pin above.
    const scopeCode = stripSql(SCOPE_SQL);
    expect(scopeCode).toContain(
      "create unique index if not exists answers_user_question_scope_uk\n  on public.answers (user_id, question_key, company_key)",
    );
    expect(scopeCode).toContain("drop index if exists public.answers_user_question_key_uk");
  });

  it("compares the version token as an INSTANT, not as text", async () => {
    const src = emptyLibraryStore();
    const saved = await saveAnswer(src);
    if (!saved.ok) throw new Error("unreachable");
    // PostgREST answers `+00:00` where `toISOString()` answers `Z`: one moment,
    // two strings (matrix rows 146, 168), and the reason the SQL parameter is
    // DECLARED timestamptz.
    const other = String(saved.answer.updatedAt).replace(/Z$/, "+00:00");
    expect(other).not.toBe(saved.answer.updatedAt);
    await expect(saveAnswer(src, { answer: "Green", expectedUpdatedAt: other })).resolves.toMatchObject(
      { ok: true, created: false },
    );
    expect(UPSERT_ANSWER_FN).toContain("p_expected_updated_at timestamptz");
    expect(SET_RULE_FN).toContain("p_expected_updated_at timestamptz");
  });

  it("conflicts with the SERVER's row, in the word supabase-source matches on", async () => {
    const src = emptyLibraryStore();
    expect((await saveAnswer(src)).ok).toBe(true);
    const stale = await saveAnswer(src, {
      answer: "Green",
      expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(stale).toMatchObject({ ok: false, kind: "conflict" });
    if (stale.ok || stale.kind !== "conflict") throw new Error("unreachable");
    // The value that LOST is not what the surface shows (matrix row 113).
    expect(stale.current?.answer).toBe("Blue");
    expect(UPSERT_ANSWER_FN).toContain("conflict: this answer changed since you read it");
    expect(SET_RULE_FN).toContain("conflict: this rule changed since you read it");
    expect(APPLY_SUPABASE_SRC).toContain("/conflict|stale/i");
  });

  it("ratchets provenance the way the trigger does", async () => {
    const src = emptyLibraryStore();
    const saved = await saveAnswer(src);
    if (!saved.ok) throw new Error("unreachable");
    const downgrade = await saveAnswer(src, {
      answer: "Green",
      provenance: "suggested",
      expectedUpdatedAt: saved.answer.updatedAt,
    });
    expect(APPLY_SQL).toContain(refusal(downgrade));
    expect(APPLY_SQL).toContain("a suggested answer may not overwrite one the user entered");
  });

  it("replays the stored RESULT, and validates BEFORE it looks for one", async () => {
    const src = emptyLibraryStore();
    const key = idem();
    expect(await saveAnswer(src, { idempotencyKey: key })).toMatchObject({ ok: true, created: true });
    // The same key answers the FIRST result — `created: true` — though the row
    // now exists and a fresh write would answer `created: false`.
    const replay = await saveAnswer(src, { idempotencyKey: key, answer: "Green" });
    expect(replay).toMatchObject({ ok: true, created: true });
    if (!replay.ok) throw new Error("unreachable");
    expect(replay.answer.answer).toBe("Blue");
    // 0014 checks the payload before it looks for a key, so a retry carrying
    // something the function refuses gets the refusal rather than the stored
    // result. Proved from the SQL's own ordering, not asserted about the fake alone.
    expect(UPSERT_ANSWER_FN.indexOf("answer must not be blank")).toBeLessThan(
      UPSERT_ANSWER_FN.indexOf("from public.command_idempotency"),
    );
    expect(await saveAnswer(src, { idempotencyKey: key, answer: "   " })).toMatchObject({
      ok: false,
      kind: "error",
    });
    // A delete replays its own answer, so a second tap on a flaky connection is
    // never told it did nothing when the first one did.
    const dkey = idem();
    await saveRule(src);
    expect(
      await src.deletePolicyRule({ topic: "relocation", company: "", idempotencyKey: dkey }),
    ).toEqual({ ok: true, deleted: true });
    expect(
      await src.deletePolicyRule({ topic: "relocation", company: "", idempotencyKey: dkey }),
    ).toEqual({ ok: true, deleted: true });
    expect(
      await src.deletePolicyRule({ topic: "relocation", company: "", idempotencyKey: idem() }),
    ).toEqual({ ok: true, deleted: false });
  });

  it("keys a rule by company KEY, and lets a disabled override fall back", async () => {
    const src = emptyLibraryStore();
    // `company_name_key`, never `lower()` — 0008's NBSP lesson, with the CHECK
    // that makes it true for every writer rather than for this one.
    await saveRule(src, { company: "  Modern Treasury  " });
    expect((await src.policyRules()).map((r) => r.companyKey)).toEqual(["modern treasury"]);
    expect(APPLY_SQL).toContain("check (company_key = public.company_name_key(company_key))");
    expect(SET_RULE_FN).toContain("public.company_name_key(coalesce(p_company, ''))");

    // A DISABLED override is ABSENT to the engine, so the global rule applies —
    // which is what "turning a rule off" has to mean for that sentence to be true.
    //
    // Asserted through `prepareApplication` rather than by inspecting the array:
    // `engineRules` passes a disabled rule through WITH its flag (skipping it here
    // would move a decision the engine owns), so a membership check would pass on
    // a build where the fallback is broken. What is being pinned is the staged
    // ANSWER — "Yes" is the global rule, "No" would be the override that is off.
    await saveRule(src, { company: "", fact: { kind: "boolean", value: true } });
    await saveRule(src, { company: "Ramp", fact: { kind: "boolean", value: false }, enabled: false });
    const staged = prepareApplication({
      form: {
        ats: "greenhouse",
        jobId: "1",
        company: "Ramp",
        title: "Product Manager",
        url: "",
        fields: [
          {
            name: "question_1",
            label: "Are you open to relocation for this role?",
            kind: "select",
            required: true,
            options: [
              { label: "Yes", value: "1" },
              { label: "No", value: "0" },
            ],
            siblings: [],
            selfIdentification: false,
            rawType: "multi_value_single_select",
          },
        ],
        unsupportedBlocks: [],
      },
      answers: [],
      rules: engineRules(await src.policyRules()),
      companyKey: "ramp",
    });
    expect(staged.fields[0].answer).toBe("1");
    expect(staged.fields[0].source).toBe("policy:relocation/direct");
  });

  it("reads both tables through one cap, and never without authored_by", () => {
    // THE clause of `lib/apply/index.ts`'s contract: omitting the column does not
    // fail, it silently turns every sensitive library row into a gap. Pinned by
    // text, because a stub client cannot tell a missing column from a null one.
    const answersSelect = selectColumns("answers");
    expect(answersSelect).toContain("authored_by");
    expect(answersSelect).toContain("question_key");
    expect(selectColumns("answer_policies")).toContain("authored_by");
    // One bound, read by both, so a demo cannot render a library production
    // truncates (matrix row 172).
    expect(APPLY_SUPABASE_SRC).toContain(".limit(APPLY_LIBRARY_LIMIT)");
    expect(APPLY_FAKE_SRC).toContain("slice(0, APPLY_LIBRARY_LIMIT)");
  });

  it("keys a library answer by SCOPE as well as by question (0017)", async () => {
    const src = emptyLibraryStore();
    // The row 0014's table could not hold: 0001's primary key was the RAW
    // question text, so a second row for one question at a second scope was a
    // unique violation whatever the index said.
    await saveAnswer(src, { question: "Have you worked here before?", answer: "No" });
    await saveAnswer(src, {
      question: "Have you worked here before?",
      answer: "Yes",
      company: "  Stripe  ",
    });
    const rows = await src.answers();
    expect(rows.map((r) => [r.companyKey, r.answer])).toEqual([
      ["", "No"],
      ["stripe", "Yes"],
    ]);
    // The name is KEYED by the store, never by the caller — `company_name_key`,
    // the same rule `app_set_policy_rule` follows and 0008's NBSP lesson.
    expect(UPSERT_ANSWER_FN).toContain("public.company_name_key(coalesce(p_company, ''))");
    expect(SCOPE_SQL).toContain("check (company_key = public.company_name_key(company_key))");
    // …and the identity is still the KEY within a scope: two spellings of one
    // question at one company stay one row.
    await saveAnswer(src, { question: "HAVE YOU WORKED HERE BEFORE", answer: "No", company: "stripe" });
    expect((await src.answers()).filter((r) => r.companyKey === "stripe")).toHaveLength(1);
    expect(SCOPE_SQL).toContain(
      "on public.answers (user_id, question_key, company_key)",
    );
  });

  it("records a decline as a choice, and lets it be taken back", async () => {
    const src = emptyLibraryStore();
    const saved = await saveAnswer(src, {
      question: "Gender",
      answer: "I don't wish to answer",
      kind: "eeo",
      declined: true,
    });
    expect(saved).toMatchObject({ ok: true });
    if (!saved.ok) throw new Error("unreachable");
    expect(saved.answer.declined).toBe(true);
    // Overwritten, never OR-ed. 0017's UPDATE sets the column unconditionally
    // and so does the fake, because somebody who declines and then changes their
    // mind must not be stuck with the flag.
    const again = await saveAnswer(src, {
      question: "Gender",
      answer: "Woman",
      kind: "eeo",
      expectedUpdatedAt: saved.answer.updatedAt,
    });
    expect(again.ok && again.answer.declined).toBe(false);
    expect(UPSERT_ANSWER_FN).toContain("declined    = v_declined");
    // The door's half of "the engine never declines", keyed on the column the
    // trigger stamps rather than on anything a caller says.
    expect(SCOPE_SQL).toContain("check (declined = false or authored_by = 'user')");
  });

  it("deletes an answer the way it deletes a rule: by RESULT, not by effect", async () => {
    const src = emptyLibraryStore();
    expect(DELETE_ANSWER_FN, "app_delete_answer not found in 0017").toContain("'deleted', v_deleted");
    expect(DELETE_ANSWER_FN.length).toBeGreaterThan(500);

    await saveAnswer(src, { question: "Website", answer: "https://a.example" });
    await saveAnswer(src, { question: "Website", answer: "https://b.example", company: "Stripe" });
    const key = idem();
    expect(await src.deleteAnswer({ question: "Website", company: "Stripe", idempotencyKey: key }))
      .toEqual({ ok: true, deleted: true });
    // Only that scope. Removing a one-company answer must not remove the one
    // every other board uses.
    expect((await src.answers()).map((r) => r.companyKey)).toEqual([""]);
    // The replay says what the FIRST call said, forever after.
    expect(await src.deleteAnswer({ question: "Website", company: "Stripe", idempotencyKey: key }))
      .toEqual({ ok: true, deleted: true });
    expect(await src.deleteAnswer({ question: "Website", company: "Stripe", idempotencyKey: idem() }))
      .toEqual({ ok: true, deleted: false });
    // And the same two refusals every other write makes.
    expect(APPLY_SQL).toContain(
      refusal(await src.deleteAnswer({ question: "Website", company: "", idempotencyKey: "" })),
    );
    expect(SCOPE_SQL).toContain(
      refusal(await src.deleteAnswer({ question: "!!! ???", company: "", idempotencyKey: idem() })),
    );
  });

  it("reads the scope and the decline flag, or every row reads as global", () => {
    // `authored_by`'s sibling clause, and the same failure shape: omitting
    // `company_key` from the select does not fail, it silently turns a
    // one-company answer into the answer at every company. Pinned by text,
    // because a stub client cannot tell a missing column from a null one.
    const answersSelect = selectColumns("answers");
    expect(answersSelect).toContain("company_key");
    expect(answersSelect).toContain("declined");
    // Ordered by BOTH halves of the identity: without the second, the two scopes
    // of one question tie, and a tie is the query plan deciding which survives
    // the cap.
    expect(APPLY_SUPABASE_SRC).toContain('.order("company_key", { ascending: true })');
    expect(APPLY_FAKE_SRC).toContain("a.company_key.localeCompare(b.company_key)");
  });

  it("has no way to send authored_by, and neither does the SQL", () => {
    // `lib/apply/index.ts`: "There is no `p_authored_by` and there must never be
    // one." Asserted across all three layers rather than remembered — this is the
    // parameter an adversarial review already walked through once.
    // Comments stripped first, because 0014 SAYS the words "there is no
    // p_authored_by" in prose — a search over the raw file asserts the presence
    // of the sentence rather than the absence of the parameter, which is the
    // guard-that-cannot-bite shape (matrix row 245's technique, one file over).
    const code = APPLY_SQL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
    expect(code).toContain("app_upsert_answer");
    expect(code).not.toContain("p_authored_by");
    expect(code).toContain("new.authored_by := case when auth.uid() is not null");
    const sourceSrc = readFileSync(path.join(REPO, "webapp", "lib", "data", "source.ts"), "utf8");
    // COMMENTS STRIPPED, for the reason `_strip_sql_comments` exists one language
    // over: the type's own doc comment EXPLAINS that `authoredBy` is the one
    // field it must never take, so a raw search asserts the presence of the
    // sentence rather than the absence of the field — and would have to be
    // satisfied by rewording the explanation away (matrix row 245's technique).
    const input = stripTsComments(
      sourceSrc.slice(
        sourceSrc.indexOf("export type UpsertAnswerInput"),
        sourceSrc.indexOf("export type AnswerWriteResult"),
      ),
    );
    expect(input.length).toBeGreaterThan(100);
    expect(input).toContain("idempotencyKey");
    expect(input).not.toMatch(/authoredBy/);
    const rpcArgs = APPLY_SUPABASE_SRC.slice(
      APPLY_SUPABASE_SRC.indexOf('rpc("app_upsert_answer"'),
      APPLY_SUPABASE_SRC.indexOf('rpc("app_set_policy_rule"'),
    );
    expect(rpcArgs.length).toBeGreaterThan(100);
    expect(rpcArgs).not.toMatch(/authored/i);
  });
});
