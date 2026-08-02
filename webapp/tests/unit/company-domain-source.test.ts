/**
 * A job's company domain — the LogoAvatar's key (migration 0021) — through BOTH
 * DataSource implementations.
 *
 * Two claims, and neither is provable by looking at one source:
 *
 *   1. The lookup FAILS SOFT. It is a cosmetic enrichment, and an enrichment that
 *      can eat the primary product is not best-effort whatever its docstring says.
 *      The first version let the logo query's error out into the `Promise.all` in
 *      `queue()`/`jobs()`, so a statement timeout on the LOGO read emptied a queue
 *      whose postings had been fetched fine.
 *   2. The two sources DERIVE it the same way — from the company universe, by name
 *      key — so a company outside that universe has no domain on either side. The
 *      fixture used to hard-code the field on job seeds, which made the demo show
 *      logos where production shows initials, on exactly the surface the LogoAvatar
 *      is being built against.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";
import { FIXTURE_COMPANIES } from "@/lib/data/company-fixtures";
import { SupabaseDataSource } from "@/lib/data/supabase-source";
import { companyNameKey } from "@/lib/data/view-models";

type Row = Record<string, unknown>;
type Answer = { data: Row[] | null; error: { message: string } | null };

class Query implements PromiseLike<Answer> {
  constructor(private readonly answer: Answer) {}

  select(_columns: string): this {
    return this;
  }

  eq(_column: string, _value: unknown): this {
    return this;
  }

  neq(_column: string, _value: unknown): this {
    return this;
  }

  order(_column: string, _options?: unknown): this {
    return this;
  }

  limit(_count: number, _options?: unknown): this {
    return this;
  }

  then<TResult1 = Answer, TResult2 = never>(
    onfulfilled?: ((value: Answer) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(structuredClone(this.answer)).then(onfulfilled, onrejected);
  }
}

function client(answers: Record<string, Answer>): SupabaseClient {
  return {
    from: (table: string) =>
      new Query(answers[table] ?? { data: [], error: null }),
  } as unknown as SupabaseClient;
}

const POSTING: Row = {
  user_id: "u1",
  posting_key: "greenhouse-101",
  disposition: "qualified",
  disposition_reason: "",
  triage: "",
  snooze_until: null,
  updated_at: "2026-07-28T12:00:00Z",
  postings: {
    key: "greenhouse-101",
    company: "Ramp",
    title: "Product Manager",
    location: "New York, NY",
    url: "https://boards.greenhouse.io/ramp/jobs/101",
    posted: "2026-07-27",
    first_seen: "2026-07-27",
    last_seen: "2026-07-28",
    status: "New",
    tags: {},
    geo: {},
    source: "greenhouse",
  },
};

const COMPANY: Row = {
  user_id: "u1",
  company_id: 7,
  companies: {
    id: 7,
    name: "Ramp",
    domain: "ramp.com",
  },
};

function source(companyAnswer: Answer): SupabaseDataSource {
  return new SupabaseDataSource(
    client({
      user_postings: { data: [POSTING], error: null },
      user_companies: companyAnswer,
    }),
    "u1",
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("company-domain enrichment on job reads", () => {
  it("folds a company domain onto both queue and jobs rows", async () => {
    const data = source({ data: [COMPANY], error: null });

    const [queue, jobs] = await Promise.all([data.queue(), data.jobs()]);

    expect(queue).toHaveLength(1);
    expect(jobs).toHaveLength(1);
    expect(queue[0].companyDomain).toBe("ramp.com");
    expect(jobs[0].companyDomain).toBe("ramp.com");
  });

  it("keeps queue and jobs available when the cosmetic domain lookup fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const data = source({ data: null, error: { message: "statement timeout" } });

    const [queue, jobs] = await Promise.all([data.queue(), data.jobs()]);

    expect(queue.map((row) => [row.key, row.companyDomain])).toEqual([
      ["greenhouse-101", null],
    ]);
    expect(jobs.map((row) => [row.key, row.companyDomain])).toEqual([
      ["greenhouse-101", null],
    ]);
  });

  it("resolves by NAME KEY, not by raw company string", async () => {
    /* MUTATION REASON: match on the raw `company` string instead of
       `companyNameKey` and this goes null — a provider spells the employer with
       different case, spacing or punctuation from the company universe, which is the
       whole reason the key exists. */
    const data = source({
      data: [{ ...COMPANY, companies: { id: 7, name: "  RAMP  ", domain: "ramp.com" } }],
      error: null,
    });
    expect((await data.jobs())[0].companyDomain).toBe("ramp.com");
  });

  it("never invents a domain for a company outside the universe", async () => {
    const data = source({
      data: [{ ...COMPANY, companies: { id: 9, name: "Plaid", domain: "plaid.com" } }],
      error: null,
    });
    expect((await data.jobs())[0].companyDomain).toBeNull();
  });
});

describe("the fixture source derives the domain the same way production does", () => {
  /** The name keys of every company in the demo universe that has a domain. */
  const universe = new Map(
    FIXTURE_COMPANIES.filter((c) => c.domain).map((c) => [
      companyNameKey(c.name),
      c.domain as string,
    ]),
  );

  it("gives a job exactly the domain its company carries in the universe", async () => {
    const rows = await new FixtureDataSource().jobs();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.companyDomain).toBe(universe.get(companyNameKey(row.company)) ?? null);
    }
  });

  it("keeps both LogoAvatar branches reachable in the demo", async () => {
    /* Non-vacuity: a suite where every fixture row resolved to null would pass the
       test above while shipping the logo.dev branch unlooked-at (matrix row 15), and
       one where every row resolved would ship the monogram unlooked-at. */
    const rows = await new FixtureDataSource().jobs();
    expect(rows.some((r) => r.companyDomain !== null)).toBe(true);
    expect(rows.some((r) => r.companyDomain === null)).toBe(true);
    // …and the queue, which is a different code path, agrees.
    const queued = await new FixtureDataSource().queue({ limit: 50 });
    expect(queued.some((r) => r.companyDomain !== null)).toBe(true);
  });

  it("carries no domain on a job seed, so the fixture cannot out-generous production", async () => {
    /* MUTATION REASON: re-add `companyDomain: "plaid.com"` to a job seed and this
       fails. Plaid is not in FIXTURE_COMPANIES, so production would render its
       monogram — a seeded value is the fake being kinder than the real client, which
       is the divergence class parity.test.ts exists for. */
    for (const j of FIXTURE_JOBS) {
      expect(j.companyDomain).toBeNull();
    }
  });

  it("follows a company universe it is given, not a global constant", async () => {
    /* The derivation is a real lookup, not a hard-coded table: hand the fixture a
       universe where Ramp has a different domain and every Ramp job moves with it. */
    const src = new FixtureDataSource(
      FIXTURE_JOBS,
      undefined,
      undefined,
      FIXTURE_COMPANIES.map((c) =>
        c.name === "Ramp" ? { ...c, domain: "ramp.example" } : { ...c, domain: null },
      ),
    );
    const rows = await src.jobs();
    const ramp = rows.filter((r) => companyNameKey(r.company) === companyNameKey("Ramp"));
    expect(ramp.length).toBeGreaterThan(0);
    for (const r of ramp) expect(r.companyDomain).toBe("ramp.example");
    for (const r of rows) {
      if (companyNameKey(r.company) !== companyNameKey("Ramp")) {
        expect(r.companyDomain).toBeNull();
      }
    }
  });
});
