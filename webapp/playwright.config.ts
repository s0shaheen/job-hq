import { createHash } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs against the app in DEMO MODE, so it needs no database and the data
 * is byte-identical every run — which is what makes visual snapshots stable
 * rather than a source of daily false alarms.
 */
/**
 * The port is DERIVED FROM THE WORKTREE, not a shared default anyone has to
 * remember to override.
 *
 * Two git worktrees of this repo cannot both hold one port, and the loser does
 * not fail — `reuseExistingServer` silently attaches it to the FIRST worktree's
 * server, so it reports another branch's UI as this branch's result. A manual
 * `HQ_E2E_PORT` fixed that only for whoever remembered, and on 2026-08-02 the
 * shared default cost two parallel runs: one suite triaged rows another was
 * asserting, and a second stalled on the contention outright.
 *
 * Hashing the checkout path gives every worktree its own port with no
 * coordination and no memory. CI is unaffected: it runs one checkout, and the
 * explicit override still wins where a specific port is needed.
 *
 * Specs that need an absolute origin (cookie `url`s) build it from this.
 */
function portForThisCheckout(): number {
  const explicit = process.env.HQ_E2E_PORT;
  if (explicit) return Number(explicit);
  if (process.env.CI) return 3210;
  // 3210–3465: high enough to avoid the common dev ports, wide enough that two
  // worktrees colliding needs a 1-in-256 hash accident rather than a habit.
  const hash = createHash("sha256").update(process.cwd()).digest();
  return 3210 + (hash.readUInt16BE(0) % 256);
}

const PORT = portForThisCheckout();

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  // Small tolerance: font rasterisation differs slightly across machines, and
  // a zero threshold makes snapshots a nuisance rather than a safety net.
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02 } },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    // Chromium at a phone viewport rather than WebKit: this project exists to
    // catch responsive/overflow regressions, and a second browser engine
    // doubles CI time for a class of bug it rarely finds first.
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/queue`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { HQ_DEMO: "1", NEXT_PUBLIC_HQ_DEMO: "1" },
  },
});
