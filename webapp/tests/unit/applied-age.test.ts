import { describe, expect, it } from "vitest";
import { appliedAge } from "@/lib/applications/age";

/**
 * The clock is INJECTED here rather than mocked globally. A relative-date
 * function tested against the wall clock is a test that reads differently at
 * midnight, and this repo has already paid for one of those.
 */
const NOW = Date.parse("2026-07-21T15:00:00.000Z");

describe("appliedAge", () => {
  it("counts whole days back", () => {
    expect(appliedAge("2026-07-09", NOW)).toBe("Applied 12d ago");
    expect(appliedAge("2026-07-20", NOW)).toBe("Applied 1d ago");
  });

  it("says today rather than '0d ago'", () => {
    expect(appliedAge("2026-07-21", NOW)).toBe("Applied today");
  });

  it("answers 'Not listed' for an absent or unreadable date, never a blank", () => {
    // The distinction the display rule exists for: a blank cell says "no
    // information exists", and the truth is "this row was typed in or imported".
    expect(appliedAge(null, NOW)).toBe("Not listed");
    expect(appliedAge(undefined, NOW)).toBe("Not listed");
    expect(appliedAge("", NOW)).toBe("Not listed");
    expect(appliedAge("not a date", NOW)).toBe("Not listed");
  });

  it("clamps a future date to today rather than counting backwards", () => {
    // A real row: somebody typed tomorrow's date, or a spreadsheet carried one.
    // "Applied -3d ago" is a worse answer than treating it as today.
    expect(appliedAge("2026-07-24", NOW)).toBe("Applied today");
  });
});
