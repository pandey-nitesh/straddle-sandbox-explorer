import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReportSchema } from "@sse/shared";
import { createBus } from "./bus.js";
import { runScenarios } from "./runner.js";
import { getScenario } from "./scenarios.js";
import { createMockStraddleClient, SCHEDULES } from "../straddle/mock.js";
import { FakeClock } from "../straddle/fake-clock.js";

describe("scenario C live mode (spec §18.1)", () => {
  it("selects the deviation-evidence def only for C in live mode", () => {
    const contract = getScenario("c", "contract");
    const live = getScenario("c", "live");
    expect(contract?.requiredObservations).toEqual([
      { kind: "ordered_statuses", statuses: ["paid", "reversed"] },
    ]);
    expect(live?.requiredObservations).toEqual([
      { kind: "terminal_status", status: "failed", returnCode: "R01" },
    ]);
    expect(live?.outcomes.charge).toBe("reversed_insufficient_funds");
    for (const id of ["a", "b", "e"] as const) {
      expect(getScenario(id, "live")).toBe(getScenario(id, "contract"));
    }
  });

  it("selects the watchtower deviation def for D in live mode (spec §18.9)", () => {
    const contract = getScenario("d", "contract");
    const live = getScenario("d", "live");
    expect(contract?.requiredObservations).toEqual([
      { kind: "terminal_status", status: "cancelled", requireReasonDetail: true },
    ]);
    expect(live?.requiredObservations).toEqual([
      { kind: "terminal_status", status: "failed", requireReasonDetail: true },
    ]);
    expect(live?.outcomes.charge).toBe("cancelled_for_fraud_risk");
  });

  it("selects the closed-account deviation def for G in live mode (spec §18.1 / api-notes §P14)", () => {
    const contract = getScenario("g", "contract");
    const live = getScenario("g", "live");
    expect(contract?.requiredObservations).toEqual([
      { kind: "ordered_statuses", statuses: ["paid", "reversed"] },
    ]);
    expect(live?.requiredObservations).toEqual([
      { kind: "terminal_status", status: "failed", returnCode: "R02" },
    ]);
    expect(live?.outcomes.charge).toBe("reversed_closed_bank_account");
    // F/H/I have no live/contract split — same def in both modes.
    for (const id of ["f", "h", "i"] as const) {
      expect(getScenario(id, "live")).toBe(getScenario(id, "contract"));
    }
  });

  it("passes live-mode G against the observed live sandbox shape", async () => {
    const clock = new FakeClock(Date.parse("2026-07-07T12:00:00.000Z"));
    const bus = createBus({ now: () => new Date(clock.now()) });
    const dir = mkdtempSync(path.join(tmpdir(), "straddle-live-mode-g-"));
    const reportPath = path.join(dir, "report.json");

    const task = runScenarios({
      scenarios: ["g"],
      concurrency: "concurrent",
      bus,
      clock,
      mode: "live",
      recordingDir: path.join(dir, "runs"),
      reportPath,
      clientFactory: (context) =>
        createMockStraddleClient({
          bus,
          clock,
          context: {
            run_id: context.run_id,
            scenario_id: context.scenario_id,
          },
          chargeSchedule: SCHEDULES.g_live,
        }),
    });

    await waitForSleepers(clock);
    await clock.advance(600_000);
    const result = await task;

    const report = ReportSchema.parse(JSON.parse(readFileSync(reportPath, "utf8")));
    const scenario = report.scenarios.find((s) => s.id === "g");
    expect(scenario?.status).toBe("passed");
    expect(scenario?.final_status).toBe("failed");
    expect(scenario?.return_code).toBe("R02");
    expect(scenario?.transitions.map((t) => t.to)).not.toContain("paid");
    expect(result.report).toEqual(report);
  });

  it("passes live-mode C against the observed live sandbox shape", async () => {
    const clock = new FakeClock(Date.parse("2026-07-07T12:00:00.000Z"));
    const bus = createBus({ now: () => new Date(clock.now()) });
    const dir = mkdtempSync(path.join(tmpdir(), "straddle-live-mode-"));
    const reportPath = path.join(dir, "report.json");

    const task = runScenarios({
      scenarios: ["c"],
      concurrency: "concurrent",
      bus,
      clock,
      mode: "live",
      recordingDir: path.join(dir, "runs"),
      reportPath,
      clientFactory: (context) =>
        createMockStraddleClient({
          bus,
          clock,
          context: {
            run_id: context.run_id,
            scenario_id: context.scenario_id,
          },
          chargeSchedule: SCHEDULES.c_live,
        }),
    });

    await waitForSleepers(clock);
    await clock.advance(600_000);
    const result = await task;

    const report = ReportSchema.parse(JSON.parse(readFileSync(reportPath, "utf8")));
    const scenario = report.scenarios.find((s) => s.id === "c");
    expect(scenario?.status).toBe("passed");
    expect(scenario?.final_status).toBe("failed");
    expect(scenario?.return_code).toBe("R01");
    expect(scenario?.transitions.map((t) => t.to)).not.toContain("paid");
    expect(result.report).toEqual(report);
  });

  it("still fails contract-mode C against the live sandbox shape, loudly", async () => {
    const clock = new FakeClock(Date.parse("2026-07-07T12:00:00.000Z"));
    const bus = createBus({ now: () => new Date(clock.now()) });
    const dir = mkdtempSync(path.join(tmpdir(), "straddle-live-mode-fail-"));
    const reportPath = path.join(dir, "report.json");

    const task = runScenarios({
      scenarios: ["c"],
      concurrency: "concurrent",
      bus,
      clock,
      mode: "contract",
      recordingDir: path.join(dir, "runs"),
      reportPath,
      clientFactory: (context) =>
        createMockStraddleClient({
          bus,
          clock,
          context: {
            run_id: context.run_id,
            scenario_id: context.scenario_id,
          },
          chargeSchedule: SCHEDULES.c_live,
        }),
    });

    await waitForSleepers(clock);
    await clock.advance(600_000);
    await task;

    const report = ReportSchema.parse(JSON.parse(readFileSync(reportPath, "utf8")));
    const scenario = report.scenarios.find((s) => s.id === "c");
    expect(scenario?.status).toBe("failed");
    expect(scenario?.diagnostics.join(" ")).toMatch(/paid/);
  });
});

async function waitForSleepers(clock: FakeClock): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (clock.pendingSleepers() > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("runner did not reach polling sleeps");
}
