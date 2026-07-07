import { defineConfig } from "vitest/config";

// Root harness: `npm test` runs every workspace's suite in one pass.
// Per-workspace settings live in <workspace>/vitest.config.ts.
export default defineConfig({
  test: {
    projects: [
      "shared/vitest.config.ts",
      "server/vitest.config.ts",
      "web/vitest.config.ts",
      "scripts/vitest.config.ts",
    ],
    passWithNoTests: true,
  },
});
