import { describe, expect, it } from "vitest";
import { buildRegatePlan, jobGateRow, newlyQualifiedKeys } from "@/lib/profile/regate";
import { BASE_CRITERIA, type ProfileCriteria } from "@/lib/profile/criteria";
import type { JobView } from "@/lib/data/view-models";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import { FIXTURE_PROFILE } from "@/lib/data/preview-fixtures";

/**
 * What a profile change does to rows the user already has — acceptance criteria
 * 18 and 19, and edge case G8.
 *
 * The rule is one clause, `triage = ''`, and the reason it gets its own test
 * file is that everything it protects is invisible when it works: an
 * `interested` posting quietly surviving a narrowed profile looks exactly like
 * a profile that did not narrow. The same clause is enforced again in
 * `app_commit_profile`, because a client bug must not be able to route around
 * it, and `tests/db/test_profile.py` is that half.
 */

function job(over: Partial<JobView> & Pick<JobView, "key">): JobView {
  return {
    company: "Ramp",
    title: "Product Manager",
    url: "https://example.com/1",
    location: "New York, NY",
    metro: "New York",
    market: "US",
    country: "United States",
    remote: false,
    workModel: null,
    compRange: null,
    compMinK: null,
    compMaxK: null,
    minYoe: 2,
    seniority: "PM",
    industry: null,
    roleFocus: null,
    skills: [],
    posted: "2026-07-18",
    firstSeen: "2026-07-19",
    taggedAt: "2026-07-19",
    status: "Seen",
    disposition: "qualified",
    dispositionReason: "",
    triage: "",
    snoozeUntil: null,
    companyDomain: null,
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...over,
  };
}

function criteria(over: Partial<ProfileCriteria> = {}): ProfileCriteria {
  return { ...BASE_CRITERIA, ...over };
}

describe("buildRegatePlan — G8, the one clause", () => {
  it("never touches a triaged row, whichever way the profile moved", () => {
    // AC 18 and the dismissed half of AC 19 in one assertion. All three of
    // these WOULD change disposition if the clause were missing: the interested
    // one is narrowed out, the dismissed one is widened in.
    const jobs = [
      job({ key: "a", triage: "interested", country: "India" }),
      job({ key: "b", triage: "dismissed", disposition: "filtered", dispositionReason: "geo:India", country: "India" }),
      job({ key: "c", triage: "snoozed", country: "India" }),
    ];
    expect(buildRegatePlan(jobs, criteria())).toEqual([]);
    expect(buildRegatePlan(jobs, criteria({ countries: ["United States", "India"] }))).toEqual([]);
  });

  it("does move an UNTRIAGED row the same change would have moved", () => {
    // The control. Without it the assertion above passes for a plan builder
    // that returns [] unconditionally.
    const jobs = [job({ key: "d", triage: "", country: "India" })];
    expect(buildRegatePlan(jobs, criteria())).toEqual([
      { key: "d", disposition: "filtered", reason: "geo:India", wasDisposition: "qualified" },
    ]);
  });
});

describe("buildRegatePlan — what it refuses to emit", () => {
  it("skips a row whose tuple is already what the gate would stamp", () => {
    // `monitor/regate.py:38`'s idempotence. Restamping a row with the value it
    // has costs a write, an audit event and a bumped version token — which
    // hands every other open tab a conflict caused by a write that changed
    // nothing, and makes every save report thousands of "changes".
    const jobs = [
      job({ key: "a" }),
      job({ key: "b", disposition: "filtered", dispositionReason: "geo:India", country: "India" }),
      job({ key: "c", disposition: "needs-info", dispositionReason: "awaiting-tags", taggedAt: null, minYoe: null }),
    ];
    expect(buildRegatePlan(jobs, criteria())).toEqual([]);
  });

  it("never emits a filtered entry with an empty reason", () => {
    // 0002's `filtered_rows_state_a_reason` CHECK aborts the WHOLE save on one
    // such row. Every filtered branch of `dispose` returns a reason, so this is
    // asserted over the mixed set rather than constructed — the point is that
    // nothing in a realistic plan can produce it.
    const jobs = [
      job({ key: "a", country: "India" }),
      job({ key: "b", metro: "Denver" }),
      job({ key: "c", minYoe: 9 }),
      job({ key: "d", minYoe: null, seniority: "Director" }),
      job({ key: "e", compRange: "$70,000 - $80,000" }),
      job({ key: "f", workModel: "Onsite — Austin, TX" }),
      job({ key: "g", country: null, remote: false }),
    ];
    const plan = buildRegatePlan(
      jobs,
      criteria({
        metros: ["Chicago"],
        comp_min: 150,
        work_model_exclude: ["onsite"],
        seniority_exclude: ["Director"],
      }),
    );
    expect(plan.length).toBeGreaterThan(0);
    for (const e of plan) {
      if (e.disposition === "filtered") expect(e.reason, e.key).not.toBe("");
    }
  });

  it("reads the country, not the market, on a remote row", () => {
    // `monitor/geo.py:159` writes market = "Remote" for ANY remote posting,
    // whatever country it resolved. Reading market here would re-gate a
    // Canada-anchored remote role as qualified — G17, arriving through a lossy
    // view model rather than a wrong branch.
    const canadaRemote = job({
      key: "ca",
      remote: true,
      market: "Remote",
      country: "Canada",
      metro: null,
    });
    expect(jobGateRow(canadaRemote).country).toBe("Canada");
    expect(buildRegatePlan([canadaRemote], criteria())).toEqual([
      { key: "ca", disposition: "filtered", reason: "geo:Canada", wasDisposition: "qualified" },
    ]);
  });

  it("uses taggedAt rather than inferring it from the current reason", () => {
    // A row filtered on geo while STILL untagged reads as filtered/geo:India,
    // so nothing about its disposition says whether it has been analysed.
    // Widening the country list has to answer needs-info, not qualified.
    const untaggedForeign = job({
      key: "x",
      country: "India",
      taggedAt: null,
      minYoe: null,
      disposition: "filtered",
      dispositionReason: "geo:India",
    });
    expect(buildRegatePlan([untaggedForeign], criteria({ countries: ["United States", "India"] }))).toEqual([
      { key: "x", disposition: "needs-info", reason: "awaiting-tags", wasDisposition: "filtered" },
    ]);
  });
});

describe("newlyQualifiedKeys", () => {
  it("counts only rows that were not already qualified", () => {
    const plan = [
      { key: "a", disposition: "qualified", reason: "", wasDisposition: "filtered" },
      { key: "b", disposition: "qualified", reason: "yoe-unknown", wasDisposition: "qualified" },
      { key: "c", disposition: "filtered", reason: "geo:India", wasDisposition: "qualified" },
      { key: "d", disposition: "qualified", reason: "", wasDisposition: "needs-info" },
    ];
    // `b` merely changed its reason. Putting it in a banner that says "2
    // postings now qualify" gives a number the user cannot find on screen.
    expect(newlyQualifiedKeys(plan)).toEqual(["a", "d"]);
  });
});

describe("the fixture store applies a plan the same way the SQL does", () => {
  it("restamps untriaged rows, skips decided ones, and reports what it did", async () => {
    const src = new FixtureDataSource();
    const before = await src.jobs();
    const decided = before.filter((j) => j.triage !== "");
    expect(decided.length, "fixture set must contain triaged rows or this proves nothing").toBeGreaterThan(0);

    // Narrow hard: metros to a city almost nothing is in.
    const narrowed = { ...(FIXTURE_PROFILE.criteria as ProfileCriteria), metros: ["Miami"] };
    const plan = buildRegatePlan(before, narrowed);
    expect(plan.length).toBeGreaterThan(0);

    const res = await src.commitProfile({
      criteria: narrowed,
      regate: plan,
      idempotencyKey: "k1",
      expectedUpdatedAt: FIXTURE_PROFILE.updatedAt,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.restamped).toBe(plan.length);

    const after = await src.jobs();
    for (const d of decided) {
      const now = after.find((j) => j.key === d.key);
      expect(now?.disposition, `${d.key} was decided and must not move`).toBe(d.disposition);
      expect(now?.dispositionReason).toBe(d.dispositionReason);
    }
  });

  it("refuses a plan entry aimed at a decided row even when the client sends one", async () => {
    // The client is not trusted. This is the mutation that matters: a plan
    // builder with the triage clause removed still changes nothing, because the
    // store checks it again — which is what `app_commit_profile` does under the
    // row lock.
    const src = new FixtureDataSource();
    const decided = (await src.jobs()).find((j) => j.triage === "interested");
    expect(decided).toBeTruthy();
    const res = await src.commitProfile({
      criteria: FIXTURE_PROFILE.criteria as ProfileCriteria,
      regate: [
        { key: (decided as JobView).key, disposition: "filtered", reason: "geo:Nowhere", wasDisposition: "qualified" },
      ],
      idempotencyKey: "k2",
      expectedUpdatedAt: null,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.restamped).toBe(0);
    const after = (await src.jobs()).find((j) => j.key === (decided as JobView).key);
    expect(after?.disposition).toBe(decided?.disposition);
  });

  it("refuses a plan entry whose tuple the row already carries", async () => {
    // A mutant removing this survived the first pass, because a plan BUILT by
    // `buildRegatePlan` never contains such an entry. The plan the server gets
    // is not always freshly built: the engine's own nightly re-gate may have
    // landed between the preview and the save, or a retry may be replaying a
    // request from yesterday. Applying it anyway bumps a version token and
    // writes an audit row for a change that is not one, and hands every other
    // open tab a conflict caused by nothing.
    const src = new FixtureDataSource();
    const row = (await src.jobs()).find((j) => j.triage === "") as JobView;
    const res = await src.commitProfile({
      criteria: FIXTURE_PROFILE.criteria as ProfileCriteria,
      regate: [
        {
          key: row.key,
          disposition: row.disposition,
          reason: row.dispositionReason,
          wasDisposition: row.disposition,
        },
      ],
      idempotencyKey: "k4",
      expectedUpdatedAt: null,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.restamped).toBe(0);
    const after = (await src.jobs()).find((j) => j.key === row.key);
    expect(after?.updatedAt, "the version token must not move").toBe(row.updatedAt);
  });

  it("replays an idempotency key instead of applying twice", async () => {
    const src = new FixtureDataSource();
    const narrowed = { ...(FIXTURE_PROFILE.criteria as ProfileCriteria), metros: ["Miami"] };
    const plan = buildRegatePlan(await src.jobs(), narrowed);
    const input = {
      criteria: narrowed,
      regate: plan,
      idempotencyKey: "same",
      expectedUpdatedAt: FIXTURE_PROFILE.updatedAt,
    };
    const first = await src.commitProfile(input);
    const second = await src.commitProfile(input);
    expect(second).toEqual(first);
    if (!first.ok) return;
    // A double-submit must not report the same rows twice, and must not have
    // needed a second version token to succeed.
    expect(first.restamped).toBeGreaterThan(0);
  });

  it("conflicts on a stale version token rather than clobbering", async () => {
    const src = new FixtureDataSource();
    const res = await src.commitProfile({
      criteria: FIXTURE_PROFILE.criteria as ProfileCriteria,
      regate: [],
      idempotencyKey: "k3",
      expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe("conflict");
  });

  it("refuses to serve a criteria object it was never given", async () => {
    // The never-onboarded state has to be reachable through the constructor,
    // or the middleware redirect and the whole wizard ship unexercised.
    const src = new FixtureDataSource(undefined, undefined, undefined, undefined, {
      criteria: null,
      notify: {},
      updatedAt: null,
    });
    expect((await src.profile()).criteria).toBeNull();
  });
});
