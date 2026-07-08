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

/** Load a recording and play; leaves fake timers installed for the caller. */
async function loadAndPlay(recordingId?: string): Promise<void> {
  render(<ReplayPanel fetchFn={createRecordingApi()} />);
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "run-c-partial" })).toBeTruthy(),
  );
  if (recordingId !== undefined) {
    fireEvent.change(screen.getByRole("combobox", { name: "Recording" }), {
      target: { value: recordingId },
    });
  }
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
}

describe("ReplayPanel scrubber", () => {
  it("marks partial recordings while replaying available Scenario C evidence", async () => {
    await loadAndPlay();
    await vi.advanceTimersByTimeAsync(200);

    expect(screen.getByText("partial")).toBeTruthy();
    expect(screen.getByText("paid — provisional")).toBeTruthy();
    // Replay is always marked as recorded, never a live run.
    expect(screen.getByText("recorded")).toBeTruthy();
  });

  it("replays a complete recorded Scenario C through paid and reversed offline", async () => {
    await loadAndPlay("run-c-complete");
    await vi.advanceTimersByTimeAsync(250);

    expect(screen.getByText("paid — provisional")).toBeTruthy();
    expect(screen.getByText("reversed")).toBeTruthy();
    expect(screen.getByText("R01")).toBeTruthy();
    expect(screen.queryByText("partial")).toBeNull();
  });

  it("play advances the current-event marker; pause halts it", async () => {
    await loadAndPlay("run-c-complete");

    // Two zero-delta events reveal at once; `paid` is 100ms out.
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.getByText("event 2 / 6")).toBeTruthy();
    // Toggle turned into Pause while playing.
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(screen.getByText("event 2 / 6")).toBeTruthy(); // frozen
  });

  it("seek rebuilds the replay store to events 0..index", async () => {
    await loadAndPlay("run-c-complete");
    await vi.advanceTimersByTimeAsync(1_000); // play to completion
    expect(screen.getByText("event 6 / 6")).toBeTruthy();

    // Scrub back to 3: store reflects run.started + created + paid, no reversal.
    fireEvent.change(screen.getByRole("slider", { name: "Seek" }), {
      target: { value: "3" },
    });
    expect(screen.getByText("event 3 / 6")).toBeTruthy();
    expect(screen.getByText("paid — provisional")).toBeTruthy();
    expect(screen.queryByText("reversed")).toBeNull();

    // Scrub back to 2: `paid` is gone too.
    fireEvent.change(screen.getByRole("slider", { name: "Seek" }), {
      target: { value: "2" },
    });
    expect(screen.getByText("event 2 / 6")).toBeTruthy();
    expect(screen.queryByText("paid — provisional")).toBeNull();
  });

  it("speed selection changes the cadence", async () => {
    await loadAndPlay("run-c-complete");
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.getByText("event 2 / 6")).toBeTruthy();

    // Slow to 1x, seek to start, replay: `paid` (1000ms out) does not reach in 100ms.
    fireEvent.change(screen.getByRole("combobox", { name: "Speed" }), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "Seek" }), {
      target: { value: "0" },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(screen.getByText("event 2 / 6")).toBeTruthy(); // still pre-paid at 1x
  });

  it("reset returns to a clean initial state with no pending timers", async () => {
    await loadAndPlay("run-c-complete");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(screen.getByText("event 6 / 6")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reset replay" }));
    expect(screen.getByText("event 0 / 6")).toBeTruthy();
    expect(screen.queryByText("reversed")).toBeNull();
    expect(screen.queryByText("paid — provisional")).toBeNull();
    expect(vi.getTimerCount()).toBe(0); // deterministic: nothing left ticking

    await vi.advanceTimersByTimeAsync(5_000);
    expect(screen.getByText("event 0 / 6")).toBeTruthy(); // stays put
  });
});
