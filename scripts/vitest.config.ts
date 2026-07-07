import { defineConfig } from "vitest/config";

// Repo-level QA guards (Wave 4): cross-workspace tests that belong to no
// single workspace — the web-bundle redactor-unreachability guard and the
// UI-vs-CLI report round-trip. Node environment; run via the root harness.
export default defineConfig({
  test: {
    name: "scripts",
    environment: "node",
    include: ["*.test.ts"],
    passWithNoTests: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
