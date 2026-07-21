import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";
import { CADENCE, SupabaseDataSource, toJobView } from "@/lib/data/supabase-source";
import type { JobView, Triage } from "@/lib/data/view-models";

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
