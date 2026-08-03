import { afterEach, describe, expect, it, vi } from "vitest";
import { localIsoDaysFromNow, postedAge, toLocalIsoDate } from "@/lib/dates";

/**
 * Acceptance criterion 14: "Snooze set at 23:50 wakes on the correct LOCAL
 * calendar day."
 *
 * The bug this pins was `new Date(...).toISOString().slice(0, 10)`, which
 * returns the UTC day. West of Greenwich that is tomorrow's date for the last
 * few hours of every evening, so an evening snooze was stored a day late. It is
 * invisible in testing done during working hours, and invisible in production
 * because the symptom is just a row reappearing later than the user asked.
 */

afterEach(() => vi.useRealTimers());

/** Pin both the clock and the zone — the bug only exists in the gap between them. */
function at(iso: string, tz: string) {
  vi.stubEnv("TZ", tz);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

describe("local calendar days", () => {
  it("uses the local day, not the UTC day, late in the evening", () => {
    // 23:50 on 21 July in Chicago is 04:50 on 22 July UTC. Three days later is
    // the 24th locally; the old code stored the 25th.
    at("2026-07-22T04:50:00.000Z", "America/Chicago");
    expect(localIsoDaysFromNow(3)).toBe("2026-07-24");
  });

  it("agrees with UTC when the two happen to be the same day", () => {
    at("2026-07-21T15:00:00.000Z", "America/Chicago");
    expect(localIsoDaysFromNow(3)).toBe("2026-07-24");
  });

  it("rolls across a month boundary", () => {
    at("2026-07-30T18:00:00.000Z", "America/Chicago");
    expect(localIsoDaysFromNow(3)).toBe("2026-08-02");
  });

  it("rolls across a year boundary", () => {
    at("2026-12-30T18:00:00.000Z", "America/Chicago");
    expect(localIsoDaysFromNow(3)).toBe("2027-01-02");
  });

  it("lands on the intended calendar day across a DST change", () => {
    // 1 Nov 2026 is the US fall-back: that local day is 25 hours long, so
    // adding 3 x 86_400_000 ms lands on the wrong date. setDate does not.
    at("2026-10-31T12:00:00.000Z", "America/Chicago");
    expect(localIsoDaysFromNow(3)).toBe("2026-11-03");
  });

  it("pads single-digit months and days", () => {
    expect(toLocalIsoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

/**
 * `postedAge` — Today's fourth fact segment.
 *
 * Both arguments are `YYYY-MM-DD` strings, and the last case here is why.
 */
describe("postedAge", () => {
  const TODAY = "2026-07-21";

  it("says Today for a posting dated today", () => {
    expect(postedAge("2026-07-21", TODAY)).toBe("Today");
  });

  it("counts calendar days", () => {
    expect(postedAge("2026-07-20", TODAY)).toBe("1d ago");
    expect(postedAge("2026-07-19", TODAY)).toBe("2d ago");
  });

  it("stays relative for six days and turns absolute at seven", () => {
    expect(postedAge("2026-07-15", TODAY)).toBe("6d ago");
    expect(postedAge("2026-07-14", TODAY)).toBe("Jul 14");
  });

  it("reads a future date as today rather than a negative age", () => {
    // A board's clock, not ours. "-1d ago" is not a thing to show anyone.
    expect(postedAge("2026-07-25", TODAY)).toBe("Today");
  });

  it("answers null for an absent or unparseable date, never a guess", () => {
    expect(postedAge(null, TODAY)).toBeNull();
    expect(postedAge("", TODAY)).toBeNull();
    expect(postedAge("last tuesday", TODAY)).toBeNull();
    expect(postedAge("2026-13-01", TODAY)).toBeNull();
    expect(postedAge("2026-07-20", "not-a-date")).toBeNull();
  });

  /**
   * NO TIMEZONE TEST HERE, and that is a measured decision rather than an
   * omission.
   *
   * The bug this signature fixes was a HYDRATION MISMATCH: the first version
   * took `now: Date` and derived the current day with
   * `getFullYear/getMonth/getDate`, which read the server's zone during SSR and
   * the user's in the browser, so at 02:00Z a US reader got "1d ago" from the
   * server and "Today" after hydration.
   *
   * A unit test that loops over `TZ` values cannot see it. Both dates take the
   * same offset and the SUBTRACTION cancels it, so the answer is stable across
   * zones under the buggy arithmetic too — written, run against a deliberately
   * re-broken `calendarDay`, and observed to pass. It would have been a test
   * that cannot fail, which is this repo's most expensive recurring defect.
   *
   * What actually removes the bug is the SIGNATURE: `today` is a `YYYY-MM-DD`
   * string, so there is no timestamp left for either side to interpret, and
   * `tsc` rejects passing a `Date`. The rendered half of the claim — that the
   * relative branch renders identically on both sides of hydration — is
   * `tests/e2e/triage.spec.ts` "the fact line's posted age is relative, and
   * survives hydration unchanged".
   */
});
