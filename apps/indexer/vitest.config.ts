import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The scenario test boots Anvil, forge and Ponder.
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
