// Scaffold smoke test: proves the vitest harness runs server-workspace tests
// and that the @sse/shared workspace dependency resolves inside vitest.
import { describe, expect, it } from "vitest";

describe("scaffold: server workspace", () => {
  it("resolves the @sse/shared workspace dependency", async () => {
    await expect(import("@sse/shared")).resolves.toBeDefined();
  });
});
