/**
 * The e2e port must be derived from the checkout, not shared.
 *
 * A shared default does not fail loudly when two worktrees collide: the loser
 * attaches to the winner's server through `reuseExistingServer` and reports
 * another branch's UI as its own. On 2026-08-02 that cost two parallel runs —
 * one suite triaged rows another was asserting, and a second stalled outright.
 * The property below is the one that prevents it, so it gets a test rather than
 * a comment.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

/** The config's derivation, kept in one line so a drift is visible in a diff. */
function derive(cwd: string): number {
  return 3210 + (createHash("sha256").update(cwd).digest().readUInt16BE(0) % 256);
}

describe("the e2e port", () => {
  it("differs between the main checkout and an agent worktree", () => {
    const main = derive("/Users/s0shaheen/job-hq/webapp");
    const worktree = derive(
      "/Users/s0shaheen/job-hq/.claude/worktrees/agent-a0f866fcfd650cc4a/webapp",
    );
    expect(main).not.toBe(worktree);
  });

  it("is stable for one path across runs", () => {
    const p = "/some/checkout/webapp";
    expect(derive(p)).toBe(derive(p));
  });

  it("stays inside the reserved band", () => {
    // A port outside the band collides with something a developer is running,
    // which is the failure this whole scheme is meant to avoid.
    for (let i = 0; i < 500; i++) {
      const port = derive(`/checkout/number/${i}/webapp`);
      expect(port).toBeGreaterThanOrEqual(3210);
      expect(port).toBeLessThanOrEqual(3465);
    }
  });

  it("spreads paths across the band rather than clustering", () => {
    // The counterexample for this file: a derivation that returned a constant
    // would satisfy every assertion above and reintroduce the exact bug.
    const seen = new Set(
      Array.from({ length: 200 }, (_, i) => derive(`/checkout/${i}/webapp`)),
    );
    expect(seen.size).toBeGreaterThan(100);
  });
});
