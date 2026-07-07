import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RunEvent, ScenarioDef } from "@sse/shared";
import type { FetchLike } from "../api";
import { ReplayPanel } from "./ReplayPanel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SCENARIO_C: ScenarioDef = {
  id: "c",
  label: "C. Reversal",
  purpose: "Mock/replay reversal evidence: paid before reversed.",
  outcomes: { customer: "verified", paykey: "active", charge: "reversed_insufficient_funds" },
  requiredObservations: [{ kind: "ordered_statuses", statuses: ["paid", "reversed"] }],
};

function at(offsetMs: number): string {
  return new Date(1_700_000_000_000 + offsetMs).toISOString();
}

function scenarioCRecording(runId: string, complete: boolean): RunEvent[] {
  const base = {
    run_id: runId,
    scenario_id: "c" as const,
  };
  const events: RunEvent[] = [
    {
      ...base,
      type: "run.started",
      seq: 1,
      timestamp: at(0),
      scenario: SCENARIO_C,
    },
    {
      ...base,
      type: "payment.status_changed",
      seq: 2,
      timestamp: at(0),
      resource_id: "chg_1",
      from: null,
      to: "created",
    },
    {
      ...base,
      type: "payment.status_changed",
      seq: 3,
      timestamp: at(1_000),
      resource_id: "chg_1",
      from: "created",
      to: "paid",
    },
  ];
  if (!complete) return events;
  return [
    ...events,
    {
      ...base,
      type: "payment.status_changed",
      seq: 4,
      timestamp: at(2_000),
      resource_id: "chg_1",
      from: "paid",
      to: "reversed",
      return_code: "R01",
    },
    {
      ...base,
      type: "scenario.assertion",
      seq: 5,
      timestamp: at(2_010),
      kind: "ordered_statuses",
      pass: true,
    },
    {
      ...base,
      type: "run.completed",
      seq: 6,
      timestamp: at(2_020),
      result: "passed",
      duration_ms: 2_020,
      recording_path: `runs/${runId}.jsonl`,
    },
  ];
}

function createRecordingApi(): FetchLike {
  const recordings = {
    "run-c-partial": scenarioCRecording("run-c-partial", false),
    "run-c-complete": scenarioCRecording("run-c-complete", true),
  };
  return async (input) => {
    if (input === "/api/recordings") {
      return new Response(
        JSON.stringify([
          { run_id: "run-c-partial", path: "/tmp/run-c-partial.jsonl", complete: false },
          { run_id: "run-c-complete", path: "/tmp/run-c-complete.jsonl", complete: true },
        ]),
        { status: 200 },
      );
    }
    if (input.startsWith("/api/recordings/")) {
      const runId = decodeURIComponent(input.slice("/api/recordings/".length));
      const events = recordings[runId as keyof typeof recordings];
      return new Response(
        `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  };
}

describe("ReplayPanel", () => {
  it("marks partial recordings while replaying available Scenario C evidence at 10x", async () => {
    render(<ReplayPanel fetchFn={createRecordingApi()} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "run-c-partial" })).toBeTruthy());

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Play 10x" }));
    await vi.advanceTimersByTimeAsync(100);

    expect(screen.getByText("partial")).toBeTruthy();
    expect(screen.getByText("paid — provisional")).toBeTruthy();
  });

  it("replays a complete recorded Scenario C through paid and reversed offline", async () => {
    render(<ReplayPanel fetchFn={createRecordingApi()} />);
    const select = await screen.findByRole("combobox", { name: "Recording" });
    fireEvent.change(select, { target: { value: "run-c-complete" } });

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Play 10x" }));
    await vi.advanceTimersByTimeAsync(250);

    expect(screen.getByText("paid — provisional")).toBeTruthy();
    expect(screen.getByText("reversed")).toBeTruthy();
    expect(screen.getByText("R01")).toBeTruthy();
  });
});
