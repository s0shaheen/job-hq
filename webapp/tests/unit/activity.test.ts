import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import { SupabaseDataSource } from "@/lib/data/supabase-source";
import { FIXTURE_BOT_RUNS, FIXTURE_NOW } from "@/lib/data/fixtures";
import { activityForJob, activityFromRuns } from "@/lib/data/view-models";
import type { BotRunRow } from "@/lib/data/view-models";

/**
 * The Activity tab's dictionary: raw `bot_runs` rows → plain words, and the two
 * data sources agreeing about it.
 *
 * Two things are pinned here, and both have burned this repo before:
 *   1. The MAPPING says "Running" / "Last succeeded 2h ago" / "Failing since
 *      Jul 19" — never a channel, a cadence or a stale badge. That is the whole
 *      point of E3 replacing the ops-vocabulary health surface, so the strings
 *      are asserted literally, not by shape.
 *   2. The FAKE MATCHES THE QUERY. The same raw runs go through both
 *      `SupabaseDataSource` (over a stub that honours order+limit) and
 *      `FixtureDataSource`, and any divergence fails here rather than as a demo
 *      that shows an Activity tab production cannot produce.
 *
 * Time is frozen to FIXTURE_NOW so "2h ago" is 2h ago forever — `activityFromRuns`
 * reads Date.now() for the relative labels, exactly as the sources call it.
 */

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FIXTURE_NOW));
});
afterAll(() => {
  vi.useRealTimers();
});

/** The "Jul 19" the mapper renders, computed independently and always in UTC. */
function shortUtc(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

const ME = "11111111-1111-4111-8111-111111111111";
const SOMEONE_ELSE = "22222222-2222-4222-8222-222222222222";

// A stub Supabase client for the ONE query getActivity issues: a select with an
// or-filter, order(started_at desc) and a limit. It honours all three, because a
// stub that ignored them would only prove the source called something
// (parity.test.ts's rule for its own richer stub). `or` is interpreted, not just
// recorded: the whole point of the filter is which rows come back.
function stubClient(rows: Record<string, unknown>[], seen?: string[]): SupabaseClient {
  return {
    from() {
      let out = [...rows];
      const q = {
        select() {
          return q;
        },
        or(expr: string) {
          seen?.push(expr);
          const allowed = new Set(
            expr
              .split(",")
              .filter((c) => c.startsWith("user_id.eq."))
              .map((c) => c.slice("user_id.eq.".length)),
          );
          const nullOk = expr.includes("user_id.is.null");
          out = out.filter((r) => {
            const uid = r.user_id ?? null;
            return uid === null ? nullOk : allowed.has(String(uid));
          });
          return q;
        },
        order(column: string, opts?: { ascending?: boolean }) {
          const asc = opts?.ascending ?? true;
          out = [...out].sort((a, b) => {
            const av = String(a[column] ?? "");
            const bv = String(b[column] ?? "");
            return (av < bv ? -1 : av > bv ? 1 : 0) * (asc ? 1 : -1);
          });
          return q;
        },
        limit(n: number) {
          out = out.slice(0, n);
          return Promise.resolve({ data: out, error: null });
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

/** FIXTURE_BOT_RUNS (camelCase view rows) → the snake_case shape PostgREST returns. */
function asDbRows(runs: BotRunRow[]): Record<string, unknown>[] {
  return runs.map((r) => ({
    job: r.job,
    started_at: r.startedAt,
    finished_at: r.finishedAt,
    ok: r.ok,
    fetched: r.fetched,
    new_rows: r.newRows,
    error: r.error,
  }));
}

describe("the Activity mapping speaks plain words, not ops jargon", () => {
  // Explicit `now`, not the frozen clock: this map is built when the describe
  // body runs (collection), which is BEFORE beforeAll's fake timer is installed.
  const NOW = Date.parse(FIXTURE_NOW);
  const byJob = new Map(activityFromRuns(FIXTURE_BOT_RUNS, NOW).map((a) => [a.job, a]));

  it("a succeeded run reads 'Last succeeded 2h ago' with its result", () => {
    const monitor = byJob.get("monitor")!;
    expect(monitor.state).toBe("succeeded");
    expect(monitor.label).toBe("Job discovery");
    expect(monitor.stateLabel).toBe("Last succeeded 2h ago");
    expect(monitor.lastResult).toBe("38 roles checked, 2 new");
  });

  it("a success with no counts reads 'completed', never a wrong noun", () => {
    const digest = byJob.get("digest")!;
    expect(digest.state).toBe("succeeded");
    expect(digest.stateLabel).toBe("Last succeeded 8h ago");
    expect(digest.lastResult).toBe("completed");
  });

  it("an open run reads 'Running'", () => {
    const tracker = byJob.get("tracker")!;
    expect(tracker.state).toBe("running");
    expect(tracker.stateLabel).toBe("Running");
  });

  it("a failing job reads 'Failing since' the START of the streak, with the error", () => {
    const ts = byJob.get("theirstack")!;
    expect(ts.state).toBe("failing");
    // The streak began at the run 54h back (Jul 19), NOT the newest failure (6h
    // back) — "since" answers how long it has been broken.
    expect(ts.stateLabel).toBe("Failing since Jul 19");
    expect(ts.lastResult).toBe("TheirStack API returned 429");
  });

  it("orders problems first, then healthy, ties by label", () => {
    // failing → running → succeeded(by label: Daily briefing < Job discovery)
    expect(activityFromRuns(FIXTURE_BOT_RUNS).map((a) => a.job)).toEqual([
      "theirstack",
      "tracker",
      "digest",
      "monitor",
    ]);
  });

  it("no runs at all is 'Never run', not an absent row", () => {
    // The mapper is total: a job passed with zero runs is a state, not a gap —
    // the health surface's lesson (a missing row reads as all-clear).
    const never = activityForJob("monitor", [], Date.now());
    expect(never.state).toBe("never");
    expect(never.stateLabel).toBe("Never run");
    expect(never.lastResult).toBe("");
    expect(never.lastRunAt).toBeNull();
  });

  it("the newest failure alone does not decide 'since' — a mid-streak success resets it", () => {
    // fail(now) · success(2d) · fail(3d): the current streak is one run deep, so
    // "since" is the recent failure, not the old one before the success.
    const now = Date.now();
    const iso = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const view = activityForJob(
      "monitor",
      [
        { job: "monitor", startedAt: iso(1.1), finishedAt: iso(1), ok: false, fetched: 0, newRows: 0, error: "boom" },
        { job: "monitor", startedAt: iso(48.1), finishedAt: iso(48), ok: true, fetched: 5, newRows: 0, error: null },
        { job: "monitor", startedAt: iso(72.1), finishedAt: iso(72), ok: false, fetched: 0, newRows: 0, error: "old" },
      ],
      now,
    );
    expect(view.state).toBe("failing");
    expect(view.lastResult).toBe("boom");
    // "since" is the 1h-ago failure's date, not the 72h-ago one.
    expect(view.stateLabel).toBe(`Failing since ${shortUtc(iso(1))}`);
  });
});

describe("an open run does not mean 'Running' forever", () => {
  // An OOM-killed or timed-out invocation never closes its row. The tab used to
  // read that as "Running" for as long as the row lived — the loudest possible
  // wrong answer from the surface that exists to say whether automation is alive.
  const now = Date.parse(FIXTURE_NOW);
  const iso = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const open = (h: number): BotRunRow => ({
    job: "monitor", startedAt: iso(h), finishedAt: null, ok: null,
    fetched: 0, newRows: 0, error: null,
  });
  const closed = (h: number, ok: boolean): BotRunRow => ({
    job: "monitor", startedAt: iso(h + 0.1), finishedAt: iso(h), ok,
    fetched: 0, newRows: 0, error: ok ? null : "boom",
  });

  it("a run open for five minutes is Running", () => {
    const v = activityForJob("monitor", [open(5 / 60), closed(24, true)], now);
    expect(v.stateLabel).toBe("Running");
  });

  it("a run open for three hours is abandoned, and the last real outcome shows instead", () => {
    // Lambda's hard ceiling is 15 minutes, so nothing legitimately runs for 3h.
    const v = activityForJob("monitor", [open(3), closed(24, true)], now);
    expect(v.state).toBe("succeeded");
    expect(v.stateLabel).toBe("Last succeeded 1d ago");
  });

  it("an abandoned run does not hide a failing streak underneath it", () => {
    const v = activityForJob("monitor", [open(3), closed(24, false), closed(48, false)], now);
    expect(v.state).toBe("failing");
    expect(v.stateLabel).toBe(`Failing since ${shortUtc(iso(48))}`);
  });

  it("an abandoned run that is the ONLY run still reads Running, never 'Never run'", () => {
    // The alternative claims a job that demonstrably ran has never run.
    expect(activityForJob("monitor", [open(9)], now).stateLabel).toBe("Running");
  });
});

describe("a finished run with no recorded outcome never reads as success", () => {
  // 0023's check constraint bars this row at the database. This is the reader's
  // half of the same rule: if one ever appears (a hand-edit, a future writer),
  // "we do not know how it ended" must not render as "Last succeeded".
  it("finished, ok null → not succeeded", () => {
    const now = Date.parse(FIXTURE_NOW);
    const iso = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const v = activityForJob(
      "monitor",
      [{ job: "monitor", startedAt: iso(2.1), finishedAt: iso(2), ok: null, fetched: 0, newRows: 0, error: null }],
      now,
    );
    expect(v.state).not.toBe("succeeded");
    expect(v.stateLabel).not.toContain("succeeded");
  });
});

describe("the read is scoped to one user, not left to the RLS policy", () => {
  const now = Date.parse(FIXTURE_NOW);
  const iso = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const row = (user: string | null, h: number, ok: boolean) => ({
    job: "monitor", user_id: user,
    started_at: iso(h + 0.1), finished_at: iso(h), ok,
    fetched: 0, new_rows: 0, error: ok ? null : "boom",
  });

  it("another user's runs cannot end MY failing streak", async () => {
    // 0023 lets an operator read every user's runs, and the mapper groups by job
    // alone — so without the filter, the foreign success at 24h back sits inside
    // my streak and "Failing since" jumps from Jul 19 to Jul 20. Counterexample
    // first: prove the unfiltered rows really would say the wrong thing.
    const mine = [row(ME, 2, false), row(ME, 48, false)];
    const theirs = [row(SOMEONE_ELSE, 24, true)];
    const wrong = activityFromRuns(
      [...mine, ...theirs].map((r) => ({
        job: r.job, startedAt: String(r.started_at), finishedAt: String(r.finished_at),
        ok: r.ok, fetched: 0, newRows: 0, error: r.error,
      })),
      now,
    )[0];
    expect(wrong.stateLabel).toBe(`Failing since ${shortUtc(iso(2))}`);

    const seen: string[] = [];
    const src = new SupabaseDataSource(stubClient([...mine, ...theirs], seen), ME);
    const [activity] = await src.getActivity();
    expect(seen).toEqual([`user_id.is.null,user_id.eq.${ME}`]);
    expect(activity.stateLabel).toBe(`Failing since ${shortUtc(iso(48))}`);
  });

  it("the shared (null user_id) runs stay visible — they are the operator-wide jobs", async () => {
    const src = new SupabaseDataSource(stubClient([row(null, 2, true)]), ME);
    expect((await src.getActivity())[0].stateLabel).toBe("Last succeeded 2h ago");
  });

  it("a user id that is not a uuid is refused, not interpolated into the filter", async () => {
    // `.or()` takes filter TEXT, so a value with a comma in it would be syntax.
    const src = new SupabaseDataSource(stubClient([]), "u1,user_id.gte.0");
    await expect(src.getActivity()).rejects.toThrow(/non-uuid/);
  });
});

describe("the fake matches the query: both sources map identical runs identically", () => {
  it("SupabaseDataSource and FixtureDataSource agree over one raw run set", async () => {
    const supabase = new SupabaseDataSource(stubClient(asDbRows(FIXTURE_BOT_RUNS)), ME);
    const fixture = new FixtureDataSource([], [], [], [], undefined, [], undefined, FIXTURE_BOT_RUNS);
    const [s, f] = await Promise.all([supabase.getActivity(), fixture.getActivity()]);
    expect(s).toEqual(f);
    // …and it is not the empty-agrees-with-empty degenerate case.
    expect(s.length).toBe(4);
    expect(s.map((a) => a.stateLabel)).toContain("Running");
  });

  it("the empty store reports no activity, so the tab's empty state is reachable", async () => {
    const fixture = new FixtureDataSource([], [], [], [], undefined, [], undefined, []);
    expect(await fixture.getActivity()).toEqual([]);
  });
});
