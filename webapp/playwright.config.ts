import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs against the app in DEMO MODE, so it needs no database and the data
 * is byte-identical every run — which is what makes visual snapshots stable
 * rather than a source of daily false alarms.
 */
const PORT = 3210;

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
