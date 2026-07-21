import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    // The grid and anything virtualized is tested in Playwright, not here:
    // jsdom has no layout engine, so getBoundingClientRect returns zeros and
    // a virtualizer renders no rows. A green test over an empty list is worse
    // than no test.
    setupFiles: ["./tests/unit/setup.ts"],
  },
});
