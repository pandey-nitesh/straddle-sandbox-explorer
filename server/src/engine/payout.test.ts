import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReportSchema, type RunEvent } from "@sse/shared";
import { createBus } from "./bus.js";
import { attachRecorder } from "./recorder.js";
import { runPayoutSuite } from "./payout.js";
import { createMockStraddleClient } from "../straddle/mock.js";
import { FakeClock } from "../straddle/fake-clock.js";

describe("payout run path (P2-4)", () => {
  it("emits the standard RunEvents and writes a schema-valid report (payout settles paid)", async () => {
    const clock = new FakeClock(Date.parse("2026-07-07T12:00:00.000Z"));
    const bus = createBus({ now: () => new Date(clock.now()) });
    const events: RunEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const dir = mkdtempSync(path.join(tmpdir(), "straddle-payout-"));
    const runsDir = path.join(dir, "runs");
    const reportPath = path.join(dir, "report.json");
    attachRecorder(bus, runsDir);

    const task = runPayoutSuite({
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
    const result = await task;

    // The payout run flows through the SAME event machinery as a scenario run.
    const seenTypes = new Set(events.map((e) => e.type));
    for (const t of [
      "run.started",
      "api.exchange",
      "customer.review_changed",
      "payment.status_changed",
      "run.completed",
    ] as const) {
      expect(seenTypes.has(t)).toBe(true);
    }

    // Payout-specific exchanges are present; no charge lifecycle was touched.
    expect(
      events.some(
        (e) =>
          e.type === "api.exchange" &&
          e.method === "POST" &&
          e.path === "/v1/payouts",
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "api.exchange" &&
          e.method === "GET" &&
          e.path.startsWith("/v1/payouts/"),
      ),
    ).toBe(true);
    expect(
      events.some((e) => e.type === "api.exchange" && e.path === "/v1/charges"),
    ).toBe(false);

    const report = ReportSchema.parse(
      JSON.parse(readFileSync(reportPath, "utf8")),
    );
    // A standalone payout report: suite `partial` (A–E not all covered), the one
    // reported entry passed, terminal `paid`. The borrowed scenario_id "a" is
    // disambiguated by the entry's payout `name`.
    expect(report.suite.status).toBe("partial");
    expect(report.suite.covered_scenarios).toEqual(["a"]);
    expect(report.scenarios).toHaveLength(1);
    const only = report.scenarios[0];
    expect(only).toBeDefined();
    if (only === undefined) return;
    expect(only.name).toMatch(/payout/i);
    expect(only.status).toBe("passed");
    expect(only.final_status).toBe("paid");
    expect(only.transitions.map((t) => t.to)).toEqual([
      "created",
      "scheduled",
      "pending",
      "paid",
    ]);
    // The paykey resource id is captured; a payout resource id shows as `charge`
    // (observeCharge tags the payment.status_changed resource_id) — assert it is
    // the mock payout id, not a charge.
    expect(only.resource_ids["charge"]).toMatch(/^mock-payout-/);

    // Recording is a clean, parseable prefix ending in run.completed.
    const runId = result.runIds[0];
    expect(runId).toBeDefined();
    if (runId === undefined) return;
    const recorded = readFileSync(path.join(runsDir, `${runId}.jsonl`), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as RunEvent);
    expect(recorded.some((e) => e.type === "run.completed")).toBe(true);
    expect(
      events.some((e) => e.type === "run.completed" && e.result === "failed"),
    ).toBe(false);
    expect(result.interrupted).toBe(false);

    // Credential discipline: the raw paykey token never survives into events.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(/[0-9a-f]{8}\.\d{2}\.[0-9a-f]{64}/);
  });

  it("returns interrupted without running when the signal is already aborted", async () => {
    const clock = new FakeClock(Date.parse("2026-07-07T12:00:00.000Z"));
    const bus = createBus({ now: () => new Date(clock.now()) });
    const events: RunEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const dir = mkdtempSync(path.join(tmpdir(), "straddle-payout-abort-"));
    const reportPath = path.join(dir, "report.json");
    const abort = new AbortController();
    abort.abort();

    const result = await runPayoutSuite({
      bus,
      clock,
      recordingDir: path.join(dir, "runs"),
      reportPath,
      signal: abort.signal,
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

    expect(result.interrupted).toBe(true);
    // Nothing was started; a partial (empty) report is still written.
    expect(events.some((e) => e.type === "run.started")).toBe(false);
    const report = ReportSchema.parse(
      JSON.parse(readFileSync(reportPath, "utf8")),
    );
    expect(report.scenarios).toHaveLength(0);
    expect(report.suite.status).toBe("partial");
  });
});

async function waitForSleepers(clock: FakeClock): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (clock.pendingSleepers() > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("payout run did not reach polling sleeps");
}
