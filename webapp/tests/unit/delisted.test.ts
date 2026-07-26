import { beforeEach, describe, expect, it } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import { FIXTURE_APPLICATIONS, FIXTURE_JOBS } from "@/lib/data/fixtures";
import { isDelisted } from "@/lib/data/view-models";
import type { ApplicationView } from "@/lib/data/view-models";

/**
 * The delisted badge (spec G2), and the one property that keeps it honest:
 * it is DERIVED from the posting on every read and never stored.
 *
 * Matrix row 54 — a stored flag lies the moment the board reposts the role, and
 * "the badge was right when we wrote it" is not a defence to somebody who skips
 * a live job because the app said it was dead.
 */

const AFFIRM_DELISTED = 6;    // posting greenhouse-5540118, status Closed
const STRIPE_LIVE = 1;        // posting greenhouse-4410982, status Seen
const ANTHROPIC_MANUAL = 3;   // no posting at all

let src: FixtureDataSource;

beforeEach(() => {
  src = new FixtureDataSource();
});

async function get(id: number): Promise<ApplicationView> {
  const row = (await src.applications()).find((a) => a.id === id);
  if (!row) throw new Error(`no fixture application ${id}`);
  return row;
}

describe("isDelisted", () => {
  it("is true only for a Closed posting", () => {
    const base = FIXTURE_APPLICATIONS[0];
    expect(isDelisted({ ...base, postingStatus: "Closed" })).toBe(true);
    expect(isDelisted({ ...base, postingStatus: "New" })).toBe(false);
    expect(isDelisted({ ...base, postingStatus: "Seen" })).toBe(false);
  });

  it("is false for an unknown posting status, never true", () => {
    // `postings.status` deliberately has no CHECK (0001) because a human can
    // type into it. Fail towards "still listed": the false negative sends
    // somebody to a dead ad, the false positive makes them skip a live job.
    const base = FIXTURE_APPLICATIONS[0];
    expect(isDelisted({ ...base, postingStatus: "on hold" })).toBe(false);
    expect(isDelisted({ ...base, postingStatus: "" })).toBe(false);
  });

  it("is false when there is no posting to ask about", () => {
    expect(isDelisted({ ...FIXTURE_APPLICATIONS[0], postingStatus: null })).toBe(false);
  });

  it("tolerates case and padding, because the cell is human-editable", () => {
    const base = FIXTURE_APPLICATIONS[0];
    expect(isDelisted({ ...base, postingStatus: " closed " })).toBe(true);
    expect(isDelisted({ ...base, postingStatus: "CLOSED" })).toBe(true);
  });
});

describe("postingStatus, as the source derives it", () => {
  it("reports Closed for an application whose board dropped the posting", async () => {
    expect((await get(AFFIRM_DELISTED)).postingStatus).toBe("Closed");
    expect(isDelisted(await get(AFFIRM_DELISTED))).toBe(true);
  });

  it("reports the live status for one that is still up — the positive control", async () => {
    // Without this, `postingStatus` could return "Closed" unconditionally and
    // the test above would still pass.
    const row = await get(STRIPE_LIVE);
    expect(row.postingStatus).toBe("Seen");
    expect(isDelisted(row)).toBe(false);
  });

  it("reports null for a manually-added application", async () => {
    const row = await get(ANTHROPIC_MANUAL);
    expect(row.postingKey).toBeNull();
    expect(row.postingStatus).toBeNull();
    expect(isDelisted(row)).toBe(false);
  });

  it("reports null when the posting is not visible to this user", async () => {
    // The honest limitation: `postings` is only readable through a
    // `user_postings` row (0002:16), so an application pointing at a posting
    // this user was never gated returns null and reads as still-listed. A false
    // NEGATIVE, which is the right way round. The fake reproduces it by having
    // no such posting in its store — a fake that guessed "Closed" here would be
    // stricter than production and hide the real behaviour.
    const orphan = new FixtureDataSource(
      [],   // no postings at all
      [{ ...FIXTURE_APPLICATIONS[0], postingKey: "greenhouse-does-not-exist" }],
    );
    const row = (await orphan.applications())[0];
    expect(row.postingStatus).toBeNull();
    expect(isDelisted(row)).toBe(false);
  });

  it("follows the posting when it reopens, because nothing is stored", async () => {
    // The whole point. Same application, two reads, two answers — reachable only
    // because there is no field to go stale.
    expect(isDelisted(await get(AFFIRM_DELISTED))).toBe(true);

    const reopened = FIXTURE_JOBS.map((j) =>
      j.key === "greenhouse-5540118" ? { ...j, status: "New" } : j,
    );
    const fresh = new FixtureDataSource(reopened, FIXTURE_APPLICATIONS);
    const row = (await fresh.applications()).find((a) => a.id === AFFIRM_DELISTED)!;
    expect(row.postingStatus).toBe("New");
    expect(isDelisted(row)).toBe(false);
  });

  it("survives a write — the write's returned row derives it too", async () => {
    // The row a write returns is what the UI renders without refetching, so if
    // `setStatus` dropped `postingStatus` the badge would vanish on every edit
    // and reappear on the next page load.
    const before = await get(AFFIRM_DELISTED);
    const res = await src.setStatus({
      applicationId: before.id,
      status: "Interview",
      idempotencyKey: "delisted-write",
      expectedUpdatedAt: before.updatedAt,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.application.postingStatus).toBe("Closed");
      expect(isDelisted(res.application)).toBe(true);
    }
  });

  it("keeps the delisted row in the pipeline", async () => {
    // §G2 is explicit: a delisted posting does not remove the application. The
    // badge is information, not a filter.
    expect((await src.applications()).some((a) => a.id === AFFIRM_DELISTED)).toBe(true);
  });
});
