import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReportSchema, type RunEvent } from "@sse/shared";
import { createBus } from "./bus.js";
import { attachRecorder } from "./recorder.js";
import { runScenarios } from "./runner.js";
import { createMockStraddleClient } from "../straddle/mock.js";
import { FakeClock } from "../straddle/fake-clock.js";

describe("runner", () => {
  it("runs A-E against the scripted mock and writes a schema-valid report", async () => {
    const clock = new FakeClock(Date.parse("2026-07-07T12:00:00.000Z"));
    const bus = createBus({ now: () => new Date(clock.now()) });
    const events: RunEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const dir = mkdtempSync(path.join(tmpdir(), "straddle-runner-"));
    const runsDir = path.join(dir, "runs");
    const reportPath = path.join(dir, "report.json");
    attachRecorder(bus, runsDir);

    const task = runScenarios({
      scenarios: ["a", "b", "c", "d", "e"],
      concurrency: "concurrent",
      bus,
      clock,
      recordingDir: runsDir,
      reportPath,
      pollPolicy: {
        baseMinMs: 5_000,
        baseMaxMs: 5_000,
        fastMs: 5_000,
        hardTimeoutMs: 600_000,
      },
      clientFactory: (context) =>
        createMockStraddleClient({
          bus,
          clock,
          context: {
            run_id: context.run_id,
            scenario_id: context.scenario_id,
          },
        }),
    });

    await waitForSleepers(clock);
    await clock.advance(600_000);
    await task;

    const report = ReportSchema.parse(
      JSON.parse(readFileSync(reportPath, "utf8")),
    );
    expect(report.suite.status).toBe("passed");
    expect(report.suite.covered_scenarios).toEqual(["a", "b", "c", "d", "e"]);
    expect(report.scenarios.find((s) => s.id === "c")?.transitions.map((t) => t.to)).toEqual([
      "created",
      "pending",
      "paid",
      "reversed",
    ]);
    expect(report.scenarios.find((s) => s.id === "e")?.refusal).toMatchObject({
      attempted_action: "create_paykey",
      http_status: 422,
    });
    expect(events.some((e) => e.type === "run.completed" && e.result === "failed")).toBe(false);
    const customerCreates = events.filter(
      (event) =>
        event.type === "api.exchange" &&
        event.method === "POST" &&
        event.path === "/v1/customers",
    );
    expect(customerCreates).toHaveLength(5);
    const names = customerCreates.map((event) => {
      const body =
        event.type === "api.exchange" &&
        typeof event.request_body === "object" &&
        event.request_body !== null
          ? (event.request_body as { name?: unknown; email?: unknown; phone?: unknown })
          : {};
      expect(body.name).toEqual(expect.any(String));
      expect(body.name).not.toMatch(/^Straddle Sandbox/);
      expect(body.email).toEqual(expect.stringMatching(/@example\.com$/));
      expect(body.phone).toEqual(expect.stringMatching(/^\+\d{10,15}$/));
      return body.name;
    });
    expect(new Set(names).size).toBe(names.length);
  });
});

async function waitForSleepers(clock: FakeClock): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (clock.pendingSleepers() > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("runner did not reach polling sleeps");
}
