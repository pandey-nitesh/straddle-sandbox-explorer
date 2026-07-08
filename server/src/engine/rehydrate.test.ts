import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRecordedEvents } from "./rehydrate.js";

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
    requiredObservations: [{ kind: "ordered_statuses", statuses: ["paid", "reversed"] }],
  };
}

function started(runId: string, seq: number, timestamp: string) {
  return JSON.stringify({
    seq,
    timestamp,
    type: "run.started",
    run_id: runId,
    scenario_id: "c",
    scenario: scenarioC(),
  });
}

function completed(runId: string, seq: number, timestamp: string) {
  return JSON.stringify({
    seq,
    timestamp,
    type: "run.completed",
    run_id: runId,
    scenario_id: "c",
    result: "passed",
    duration_ms: 1_000,
    recording_path: `runs/${runId}.jsonl`,
  });
}

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "straddle-rehydrate-"));
}

describe("loadRecordedEvents", () => {
  it("returns empty for a missing directory", async () => {
    const result = await loadRecordedEvents(path.join(tmpdir(), "does-not-exist-xyz"));
    expect(result.events).toEqual([]);
    expect(result.maxSeq).toBe(0);
    expect(result.stats.files).toBe(0);
  });

  it("renumbers colliding per-session seq into one contiguous stream", async () => {
    const dir = freshDir();
    // Two runs from different past sessions BOTH starting at seq 1 — verbatim
    // reload would collide; renumbering must resolve them.
    writeFileSync(
      path.join(dir, "run-20260707T120000Z-c-0001.jsonl"),
      [
        started("run-20260707T120000Z-c-0001", 1, "2026-07-07T12:00:00.000Z"),
        completed("run-20260707T120000Z-c-0001", 2, "2026-07-07T12:00:02.000Z"),
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(dir, "run-20260707T120100Z-c-0002.jsonl"),
      [
        started("run-20260707T120100Z-c-0002", 1, "2026-07-07T12:01:00.000Z"),
        completed("run-20260707T120100Z-c-0002", 2, "2026-07-07T12:01:02.000Z"),
        "",
      ].join("\n"),
    );

    const result = await loadRecordedEvents(dir);
    expect(result.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(result.maxSeq).toBe(4);
    expect(result.stats.runs).toBe(2);
    // Time-ordered: the earlier run's events come first, in causal order.
    expect(result.events.map((e) => e.run_id)).toEqual([
      "run-20260707T120000Z-c-0001",
      "run-20260707T120000Z-c-0001",
      "run-20260707T120100Z-c-0002",
      "run-20260707T120100Z-c-0002",
    ]);
    expect(result.events[0]?.type).toBe("run.started");
    expect(result.events[1]?.type).toBe("run.completed");
  });

  it("keeps the valid prefix and counts a truncated file", async () => {
    const dir = freshDir();
    writeFileSync(
      path.join(dir, "run-20260707T120000Z-c-0001.jsonl"),
      [
        started("run-20260707T120000Z-c-0001", 1, "2026-07-07T12:00:00.000Z"),
        "{ this is not valid json",
        completed("run-20260707T120000Z-c-0001", 2, "2026-07-07T12:00:02.000Z"),
        "",
      ].join("\n"),
    );

    const result = await loadRecordedEvents(dir);
    // Only the run.started before the bad line survives.
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe("run.started");
    expect(result.stats.truncatedFiles).toBe(1);
    expect(result.stats.skippedLines).toBe(2); // bad line + the completion after it
    expect(result.stats.runs).toBe(1);
  });

  it("drops a file whose very first line is corrupt", async () => {
    const dir = freshDir();
    writeFileSync(
      path.join(dir, "run-20260707T120000Z-c-0001.jsonl"),
      ["garbage line", ""].join("\n"),
    );

    const result = await loadRecordedEvents(dir);
    expect(result.events).toEqual([]);
    expect(result.stats.truncatedFiles).toBe(1);
    expect(result.stats.runs).toBe(0);
  });

  it("ignores non-jsonl entries", async () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, "report.json"), "{}");
    writeFileSync(path.join(dir, "notes.txt"), "hello");
    const result = await loadRecordedEvents(dir);
    expect(result.stats.files).toBe(0);
    expect(result.events).toEqual([]);
  });
});
