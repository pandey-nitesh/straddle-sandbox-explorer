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
import type { StraddleClient } from "../straddle/types.js";

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

  it("abandons in-flight work on abort, snapshots a partial report, never fabricates completion", async () => {
    const clock = new FakeClock(Date.parse("2026-07-07T12:00:00.000Z"));
    const bus = createBus({ now: () => new Date(clock.now()) });
    const dir = mkdtempSync(path.join(tmpdir(), "straddle-runner-abort-"));
    const runsDir = path.join(dir, "runs");
    const reportPath = path.join(dir, "report.json");
    attachRecorder(bus, runsDir);
    const abort = new AbortController();

    const task = runScenarios({
      scenarios: ["a"],
      concurrency: "concurrent",
      bus,
      clock,
      recordingDir: runsDir,
      reportPath,
      signal: abort.signal,
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
          context: { run_id: context.run_id, scenario_id: context.scenario_id },
        }),
    });

    // Let the run reach its first poll sleep (still mid-lifecycle, not
    // terminal), then interrupt WITHOUT advancing the clock.
    await waitForSleepers(clock);
    abort.abort();
    const result = await task;

    expect(result.interrupted).toBe(true);
    const report = ReportSchema.parse(JSON.parse(readFileSync(reportPath, "utf8")));
    const scenarioA = report.scenarios.find((s) => s.id === "a");
    expect(scenarioA?.status).toBe("partial");
    expect(report.suite.status).toBe("partial");

    // The recording is a valid prefix with no manufactured completion.
    const runId = result.runIds[0];
    const recording = readFileSync(path.join(runsDir, `${runId}.jsonl`), "utf8");
    const events = recording
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as RunEvent);
    expect(events.some((e) => e.type === "run.started")).toBe(true);
    expect(events.some((e) => e.type === "run.completed")).toBe(false);
  });

  it("polls through transient sandbox failures without failing the run (P2-R.3)", async () => {
    const clock = new FakeClock(Date.parse("2026-07-07T12:00:00.000Z"));
    const bus = createBus({ now: () => new Date(clock.now()) });
    const events: RunEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const dir = mkdtempSync(path.join(tmpdir(), "straddle-runner-transient-"));
    const runsDir = path.join(dir, "runs");
    const reportPath = path.join(dir, "report.json");
    attachRecorder(bus, runsDir);

    let getChargeCalls = 0;
    const task = runScenarios({
      scenarios: ["a"],
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
      clientFactory: (context) => {
        const mock = createMockStraddleClient({
          bus,
          clock,
          context: { run_id: context.run_id, scenario_id: context.scenario_id },
        });
        // Delegate every method explicitly — the mock is a class instance, so
        // its methods live on the prototype and a spread wouldn't copy them.
        const flaky: StraddleClient = {
          health: () => mock.health(),
          createCustomer: (input) => mock.createCustomer(input),
          getCustomerReview: (id) => mock.getCustomerReview(id),
          createPaykey: (input) => mock.createPaykey(input),
          createCharge: (input) => mock.createCharge(input),
          getCharge: (id) => {
            getChargeCalls += 1;
            // The first two polls hit a retryable-exhausted 503 (a transient
            // sandbox outage); the run must poll through it, not die.
            if (getChargeCalls <= 2) {
              return Promise.reject({
                status: 503,
                path: "/v1/charges",
                retryable: true,
                errorBody: {},
              });
            }
            return mock.getCharge(id);
          },
        };
        return flaky;
      },
    });

    await waitForSleepers(clock);
    await clock.advance(600_000);
    await task;

    const report = ReportSchema.parse(JSON.parse(readFileSync(reportPath, "utf8")));
    const scenarioA = report.scenarios.find((s) => s.id === "a");
    expect(scenarioA?.status).toBe("passed"); // survived the transient blips
    expect(scenarioA?.final_status).toBe("paid");
    expect(getChargeCalls).toBeGreaterThanOrEqual(3);
    expect(
      events.some((e) => e.type === "retry.scheduled" && e.attempt >= 2),
    ).toBe(true);
  });

  it("stops before starting new work when already aborted (serial)", async () => {
    const clock = new FakeClock(Date.parse("2026-07-07T12:00:00.000Z"));
    const bus = createBus({ now: () => new Date(clock.now()) });
    const events: RunEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const dir = mkdtempSync(path.join(tmpdir(), "straddle-runner-preabort-"));
    const abort = new AbortController();
    abort.abort(); // aborted before the suite even starts

    const result = await runScenarios({
      scenarios: ["a", "b"],
      concurrency: "serial",
      bus,
      clock,
      recordingDir: path.join(dir, "runs"),
      reportPath: path.join(dir, "report.json"),
      signal: abort.signal,
      clientFactory: (context) =>
        createMockStraddleClient({
          bus,
          clock,
          context: { run_id: context.run_id, scenario_id: context.scenario_id },
        }),
    });

    expect(result.interrupted).toBe(true);
    // No scenario ever started — nothing new was launched after the abort.
    expect(events.some((e) => e.type === "run.started")).toBe(false);
  });
});

async function waitForSleepers(clock: FakeClock): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (clock.pendingSleepers() > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("runner did not reach polling sleeps");
}
