import { describe, expect, it } from "vitest";
import type { RunEvent } from "@sse/shared";
import { createBus } from "./bus.js";
import { createRunRegistry } from "./registry.js";

function scenarioC() {
  return {
    id: "c" as const,
    label: "C. Reversal",
    purpose: "Mock/replay reversal evidence.",
    outcomes: {
      customer: "verified",
      paykey: "active",
      charge: "reversed_insufficient_funds",
    },
    requiredObservations: [
      { kind: "ordered_statuses" as const, statuses: ["paid", "reversed"] },
    ],
  };
}

function startedEvent(runId: string, seq: number, timestamp: string): RunEvent {
  return {
    seq,
    timestamp,
    type: "run.started",
    run_id: runId,
    scenario_id: "c",
    scenario: scenarioC(),
  } as RunEvent;
}

function completedEvent(
  runId: string,
  seq: number,
  timestamp: string,
  result: "passed" | "failed",
): RunEvent {
  return {
    seq,
    timestamp,
    type: "run.completed",
    run_id: runId,
    scenario_id: "c",
    result,
    duration_ms: 1_000,
    recording_path: `runs/${runId}.jsonl`,
  } as RunEvent;
}

describe("registry hydrate", () => {
  it("recovers a completed run with its real result", () => {
    const bus = createBus();
    const registry = createRunRegistry(bus);
    registry.hydrate([
      startedEvent("run-a", 1, "2026-07-07T12:00:00.000Z"),
      completedEvent("run-a", 2, "2026-07-07T12:00:02.000Z", "failed"),
    ]);
    const snapshot = registry.snapshot();
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]).toMatchObject({ run_id: "run-a", status: "failed" });
  });

  it("marks a rehydrated run without a completion line as partial, not running", () => {
    const bus = createBus();
    const registry = createRunRegistry(bus);
    registry.hydrate([startedEvent("run-b", 1, "2026-07-07T12:00:00.000Z")]);
    expect(registry.snapshot().runs[0]?.status).toBe("partial");
  });

  it("keeps live runs (from the bus) as running until they complete", () => {
    const bus = createBus();
    const registry = createRunRegistry(bus);
    bus.emit({ type: "run.started", run_id: "run-live", scenario_id: "c", scenario: scenarioC() });
    expect(registry.snapshot().runs[0]?.status).toBe("running");
  });

  it("drops orphan events whose run.started was lost", () => {
    const bus = createBus();
    const registry = createRunRegistry(bus);
    registry.hydrate([completedEvent("ghost", 1, "2026-07-07T12:00:02.000Z", "passed")]);
    expect(registry.snapshot().runs).toHaveLength(0);
  });

  it("evicts old delivery events and flags resync, but keeps the full report (P2-R.5)", () => {
    const bus = createBus();
    const registry = createRunRegistry(bus, { maxEvents: 2 });
    bus.emit({ type: "run.started", run_id: "run-a", scenario_id: "c", scenario: scenarioC() }); // seq 1
    bus.emit({
      type: "payment.status_changed",
      run_id: "run-a",
      scenario_id: "c",
      resource_id: "chg_1",
      from: null,
      to: "pending",
    }); // seq 2
    bus.emit({
      type: "payment.status_changed",
      run_id: "run-a",
      scenario_id: "c",
      resource_id: "chg_1",
      from: "pending",
      to: "paid",
    }); // seq 3 — evicts seq 1 from the 2-slot delivery buffer

    // A cursor at/below the evicted seq needs a full re-hydration.
    expect(registry.resyncNeeded(0)).toBe(true);
    expect(registry.resyncNeeded(1)).toBe(false); // seq 1 was the evicted one
    expect(registry.eventsSince(1).map((e) => e.seq)).toEqual([2, 3]);

    // Full history is intact for the snapshot and report projections.
    expect(registry.allEvents().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(registry.snapshot().runs[0]?.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("interleaves hydrated history with subsequent live events by seq", () => {
    // Simulates the boot wiring: bus started above the rehydrated high-water
    // mark, history ingested, then a live event emitted.
    const bus = createBus({ startSeq: 3 });
    const registry = createRunRegistry(bus);
    registry.hydrate([
      startedEvent("run-old", 1, "2026-07-07T12:00:00.000Z"),
      completedEvent("run-old", 2, "2026-07-07T12:00:02.000Z", "passed"),
    ]);
    bus.emit({ type: "run.started", run_id: "run-new", scenario_id: "c", scenario: scenarioC() });

    const all = registry.allEvents();
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    // A client cursor at the rehydrated max (2) still receives the live event.
    expect(registry.eventsSince(2).map((e) => e.run_id)).toEqual(["run-new"]);
  });
});
