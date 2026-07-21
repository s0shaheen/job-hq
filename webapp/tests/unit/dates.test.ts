import { afterEach, describe, expect, it, vi } from "vitest";
import { localIsoDaysFromNow, toLocalIsoDate } from "@/lib/dates";

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
