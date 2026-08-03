import { describe, expect, it } from "vitest";
import { BANDS, bandOpenByDefault, bandRank, statusBand } from "@/lib/applications/bands";
import { STATUSES, STATUS_ORDER, STATUS_RESOLVED, STATUS_TERMINAL } from "@/lib/status";

/**
 * The Applications bands are a display projection, so the properties worth
 * asserting are about TOTALITY and about what cannot be hidden — not about a
 * hand-copied list of strings, which is the assertion that passes while the
 * mapping is wrong.
 */

describe("statusBand", () => {
  it("places every canonical status in exactly one declared band", () => {
    // Totality, over the whole vocabulary rather than a sample. A status added
    // to `lib/status.ts` that this function has no answer for is the failure
    // this catches — a row that renders in no band is a row that vanishes.
    for (const s of STATUSES) {
      expect(BANDS, s).toContain(statusBand(s));
    }
  });

  it("keeps the live ladder out of Closed", () => {
    // The whole point of the band split. `Offer` is the one STATUS_ORDER member
    // that leaves Active, and it goes UP, into its own band.
    for (const s of STATUS_ORDER) {
      expect(statusBand(s), s).toBe(s === "Offer" ? "Offers" : "Active");
    }
  });

  it("puts an ended-without-an-offer status in Closed and an offer outcome in Offers", () => {
    for (const s of STATUS_TERMINAL) expect(statusBand(s), s).toBe("Closed");
    for (const s of STATUS_RESOLVED) expect(statusBand(s), s).toBe("Offers");
  });

  it("treats a status a human invented as live, not as closed", () => {
    // The deviation from applications-handoff.md §1, pinned so it cannot be
    // "tidied" back. The authored template puts "Waiting on referral" in Active,
    // and Closed is collapsed by default — folding invented statuses in there
    // hides a live application behind a chevron over a typo.
    expect(statusBand("waiting on panel")).toBe("Active");
    expect(statusBand("Aplied")).toBe("Active");
    expect(statusBand("")).toBe("Active");
  });

  it("is not case- or whitespace-fooled into the wrong band", () => {
    expect(statusBand("  Rejected  ")).toBe("Closed");
    // NOT normalized for case on purpose: `applications.status` is compared
    // exactly everywhere else in the app, and a band function that lower-cased
    // would disagree with `statusTone` and `isReopenable` on the same row.
    expect(statusBand("rejected")).toBe("Active");
  });
});

describe("bandRank", () => {
  it("orders the bands as declared and parks an unknown name last", () => {
    expect([...BANDS].sort((a, b) => bandRank(a) - bandRank(b))).toEqual([
      "Active",
      "Offers",
      "Closed",
    ]);
    expect(bandRank("Needs review")).toBeGreaterThanOrEqual(BANDS.length);
  });
});

describe("bandOpenByDefault", () => {
  it("opens live work and collapses the archive", () => {
    // The template's own initial state: `collapsed: { closed: true }`.
    expect(bandOpenByDefault("Active")).toBe(true);
    expect(bandOpenByDefault("Offers")).toBe(true);
    expect(bandOpenByDefault("Closed")).toBe(false);
  });
});
