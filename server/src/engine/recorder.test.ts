import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunEventSchema } from "@sse/shared";
import type { RunEvent, ScenarioId } from "@sse/shared";
import { createBus } from "./bus.js";
import type { EventBus, UnsequencedRunEvent } from "./bus.js";
import { attachRecorder, recordingPathFor } from "./recorder.js";

const RUN_A = "run-20260707T120000Z-a-ab12";
const RUN_C = "run-20260707T120001Z-c-cd34";

function statusChanged(
  runId: string,
  scenarioId: ScenarioId,
  to: string,
): UnsequencedRunEvent {
  return {
    type: "payment.status_changed",
    run_id: runId,
    scenario_id: scenarioId,
    resource_id: "chg_fake_0001",
    from: null,
    to,
  };
}

function completed(
  runId: string,
  scenarioId: ScenarioId,
  recordingPath: string,
): UnsequencedRunEvent {
  return {
    type: "run.completed",
    run_id: runId,
    scenario_id: scenarioId,
    result: "passed",
    duration_ms: 1234,
    recording_path: recordingPath,
  };
}

/** Parse a recording: every line must be independently parseable + schema-valid. */
function readRecording(filePath: string): RunEvent[] {
  const raw = readFileSync(filePath, "utf8");
  expect(raw.endsWith("\n")).toBe(true); // no dangling partial line
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => RunEventSchema.parse(JSON.parse(line)));
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sse-recorder-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("recordingPathFor", () => {
  it("joins dir and run_id with the .jsonl extension", () => {
    expect(recordingPathFor("runs", RUN_A)).toBe(
      path.join("runs", `${RUN_A}.jsonl`),
    );
  });

  it("rejects run_ids that are not safe file names", () => {
    expect(() => recordingPathFor("runs", "../evil")).toThrow(/safe file name/);
    expect(() => recordingPathFor("runs", "a/b")).toThrow(/safe file name/);
    expect(() => recordingPathFor("runs", "")).toThrow(/safe file name/);
  });
});

describe("attachRecorder", () => {
  it("creates the runs directory (recursively) if absent", () => {
    const dir = path.join(tempDir(), "nested", "runs");
    expect(existsSync(dir)).toBe(false);
    attachRecorder(createBus(), dir);
    expect(existsSync(dir)).toBe(true);
  });

  it("writes one file per run containing only that run's events, seq gaps preserved", () => {
    const dir = tempDir();
    const bus = createBus();
    attachRecorder(bus, dir);

    // Interleave two concurrent runs on the one bus.
    bus.emit(statusChanged(RUN_A, "a", "created")); // seq 1
    bus.emit(statusChanged(RUN_C, "c", "created")); // seq 2
    bus.emit(statusChanged(RUN_A, "a", "paid")); // seq 3
    bus.emit(statusChanged(RUN_C, "c", "paid")); // seq 4
    bus.emit(statusChanged(RUN_C, "c", "reversed")); // seq 5

    const eventsA = readRecording(recordingPathFor(dir, RUN_A));
    const eventsC = readRecording(recordingPathFor(dir, RUN_C));

    expect(eventsA.every((e) => e.run_id === RUN_A)).toBe(true);
    expect(eventsC.every((e) => e.run_id === RUN_C)).toBe(true);
    // Global seqs survive verbatim: ordered within a file, NOT dense.
    expect(eventsA.map((e) => e.seq)).toEqual([1, 3]);
    expect(eventsC.map((e) => e.seq)).toEqual([2, 4, 5]);
  });

  it("leaves a valid JSONL prefix when a run never completes (kill mid-run)", () => {
    const dir = tempDir();
    const bus = createBus();
    attachRecorder(bus, dir);

    // N events, then the process "dies" — no run.completed is ever emitted.
    bus.emit(statusChanged(RUN_A, "a", "created"));
    bus.emit(statusChanged(RUN_A, "a", "pending"));
    bus.emit(statusChanged(RUN_A, "a", "paid"));

    // readRecording asserts every line parses and schema-validates.
    const events = readRecording(recordingPathFor(dir, RUN_A));
    expect(events).toHaveLength(3);
    expect(events.some((e) => e.type === "run.completed")).toBe(false);
  });

  it("records the run.completed line, marking clean completion", () => {
    const dir = tempDir();
    const bus = createBus();
    attachRecorder(bus, dir);
    const recordingPath = recordingPathFor(dir, RUN_A);

    bus.emit(statusChanged(RUN_A, "a", "created"));
    bus.emit(statusChanged(RUN_A, "a", "paid"));
    bus.emit(completed(RUN_A, "a", recordingPath));

    const events = readRecording(recordingPath);
    const last = events.at(-1);
    expect(last?.type).toBe("run.completed");
    if (last?.type === "run.completed") {
      expect(last.result).toBe("passed");
      expect(last.recording_path).toBe(recordingPath);
    }
  });

  it("detaches cleanly: no writes after the returned unsubscribe is called", () => {
    const dir = tempDir();
    const bus = createBus();
    const detach = attachRecorder(bus, dir);

    bus.emit(statusChanged(RUN_A, "a", "created"));
    detach();
    bus.emit(statusChanged(RUN_A, "a", "paid"));

    expect(readRecording(recordingPathFor(dir, RUN_A))).toHaveLength(1);
  });

  it("write failures hit the bus isolation policy, not other subscribers", () => {
    const dir = path.join(tempDir(), "runs");
    const onSubscriberError = vi.fn();
    const bus: EventBus = createBus({ onSubscriberError });
    attachRecorder(bus, dir);
    const seen: RunEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    rmSync(dir, { recursive: true, force: true }); // yank the directory mid-run
    bus.emit(statusChanged(RUN_A, "a", "created"));

    expect(onSubscriberError).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1); // the later subscriber still got the event
  });
});
