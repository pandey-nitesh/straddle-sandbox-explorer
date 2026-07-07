// Scaffold smoke test: proves the vitest harness runs shared-workspace tests
// and that zod (the workspace's only runtime dependency) resolves.
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("scaffold: shared workspace", () => {
  it("resolves zod and parses a trivial schema", () => {
    expect(z.literal("ok").parse("ok")).toBe("ok");
  });
});
