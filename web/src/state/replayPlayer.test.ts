import { describe, expect, it } from "vitest";
import type { RunEvent, ScenarioDef } from "@sse/shared";
import {
  createReplayPlayer,
  DEFAULT_REPLAY_SPEED,
  type ReplaySink,
  type ReplayTimer,
} from "./replayPlayer";

/**
 * Deterministic playback tests: the player is driven by an injected fake timer
 * and a fake sink capturing every rendered prefix, so no wall-clock time and no
 * React are involved. This is the falsifiable form of "scrubbing is consistent"
 * — the store always reflects exactly `events[0..index]`.
 */

const SCENARIO_C: ScenarioDef = {
  id: "c",
  label: "C. Reversal",
  purpose: "paid before reversed",
  outcomes: { charge: "reversed_insufficient_funds" },
  requiredObservations: [{ kind: "ordered_statuses", statuses: ["paid", "reversed"] }],
};

function at(offsetMs: number): string {
  return new Date(1_700_000_000_000 + offsetMs).toISOString();
}

/** 6 events at offsets 0, 0, 1000, 2000, 2010, 2020 ms. */
function recording(): RunEvent[] {
  const base = { run_id: "run-c", scenario_id: "c" as const };
  return [
    { ...base, type: "run.started", seq: 1, timestamp: at(0), scenario: SCENARIO_C },
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
      recording_path: "runs/run-c.jsonl",
    },
  ];
}

interface FakeTimer extends ReplayTimer {
  advance(ms: number): void;
  pending(): number;
}

function fakeTimer(): FakeTimer {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  return {
    set(fn, ms) {
      const id = nextId++;
      tasks.set(id, { at: now + ms, fn });
      return id;
    },
    clear(handle) {
      tasks.delete(handle);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due: { id: number; at: number; fn: () => void } | null = null;
        for (const [id, task] of tasks) {
          if (task.at <= target && (due === null || task.at < due.at)) {
            due = { id, ...task };
          }
        }
        if (due === null) break;
        tasks.delete(due.id);
        now = due.at;
        due.fn();
      }
      now = target;
    },
    pending: () => tasks.size,
  };
}

interface FakeSink extends ReplaySink {
  renders: RunEvent[][];
  clears: number;
  last(): RunEvent[] | undefined;
}

function fakeSink(): FakeSink {
  const renders: RunEvent[][] = [];
  const sink: FakeSink = {
    renders,
    clears: 0,
    render(prefix) {
      renders.push([...prefix]);
    },
    clear() {
      sink.clears += 1;
    },
    last: () => renders[renders.length - 1],
  };
  return sink;
}

function setup(speed?: 1 | 5 | 10) {
  const timer = fakeTimer();
  const sink = fakeSink();
  const player = createReplayPlayer({
    sink,
    timer,
    ...(speed !== undefined ? { speed } : {}),
  });
  return { timer, sink, player };
}

describe("createReplayPlayer", () => {
  it("loads a recording paused at index 0 with an empty rendered prefix", () => {
    const { sink, player } = setup();
    player.load("run-c", recording(), false);
    const state = player.getState();
    expect(state.runId).toBe("run-c");
    expect(state.index).toBe(0);
    expect(state.total).toBe(6);
    expect(state.playing).toBe(false);
    expect(state.speed).toBe(DEFAULT_REPLAY_SPEED);
    expect(sink.last()).toEqual([]);
  });

  it("play reveals events over (fake) time at 10x, then stops at the end", () => {
    const { timer, player } = setup(10);
    player.load("run-c", recording(), false);
    player.play();
    expect(player.getState().playing).toBe(true);

    // Two zero-delta events reveal immediately; `paid` is 100ms out (1000/10).
    timer.advance(10);
    expect(player.getState().index).toBe(2);

    timer.advance(100); // reveals `paid` at +100
    expect(player.getState().index).toBe(3);

    timer.advance(1_000); // drains the tail
    const state = player.getState();
    expect(state.index).toBe(6);
    expect(state.playing).toBe(false);
    expect(timer.pending()).toBe(0);
  });

  it("pause halts advancement and clears the pending timer", () => {
    const { timer, player } = setup(10);
    player.load("run-c", recording(), false);
    player.play();
    timer.advance(10);
    expect(player.getState().index).toBe(2);

    player.pause();
    expect(player.getState().playing).toBe(false);
    expect(timer.pending()).toBe(0);

    timer.advance(10_000);
    expect(player.getState().index).toBe(2); // frozen while paused
  });

  it("seek rebuilds the store to exactly events[0..index]", () => {
    const { sink, player } = setup();
    const events = recording();
    player.load("run-c", events, false);

    player.seek(3);
    expect(player.getState().index).toBe(3);
    expect(sink.last()).toEqual(events.slice(0, 3));

    player.seek(1); // backward is just as consistent
    expect(player.getState().index).toBe(1);
    expect(sink.last()).toEqual(events.slice(0, 1));

    player.seek(999); // clamps to total
    expect(player.getState().index).toBe(6);
    expect(sink.last()).toEqual(events);
  });

  it("speed changes the cadence", () => {
    const slow = setup(1);
    slow.player.load("run-c", recording(), false);
    slow.player.play();
    slow.timer.advance(100);
    // At 1x, `paid` is 1000ms out — only the two zero-delta events show.
    expect(slow.player.getState().index).toBe(2);

    const fast = setup(10);
    fast.player.load("run-c", recording(), false);
    fast.player.play();
    fast.timer.advance(100);
    // At 10x, the same 100ms reaches `paid`.
    expect(fast.player.getState().index).toBe(3);
  });

  it("changing speed mid-playback re-times the pending step", () => {
    const { timer, player } = setup(1);
    player.load("run-c", recording(), false);
    player.play();
    timer.advance(10);
    expect(player.getState().index).toBe(2); // waiting 1000ms for `paid` at 1x

    player.setSpeed(10);
    timer.advance(100); // now only 100ms to `paid`
    expect(player.getState().index).toBe(3);
  });

  it("reset returns to index 0 with an empty store and no pending timers", () => {
    const { timer, sink, player } = setup(10);
    player.load("run-c", recording(), false);
    player.play();
    timer.advance(10_000); // play to completion
    expect(player.getState().index).toBe(6);

    player.reset();
    const state = player.getState();
    expect(state.index).toBe(0);
    expect(state.playing).toBe(false);
    expect(state.runId).toBe("run-c"); // recording kept — Play restarts it
    expect(state.total).toBe(6);
    expect(sink.last()).toEqual([]);
    expect(timer.pending()).toBe(0);
  });

  it("play after reaching the end restarts from the top", () => {
    const { timer, player } = setup(10);
    player.load("run-c", recording(), false);
    player.play();
    timer.advance(10_000);
    expect(player.getState().index).toBe(6);

    player.play(); // at the end → restart
    expect(player.getState().index).toBe(0);
    timer.advance(10_000);
    expect(player.getState().index).toBe(6);
  });

  it("clear forgets the recording and empties the store", () => {
    const { sink, player } = setup();
    player.load("run-c", recording(), true);
    expect(player.getState().truncated).toBe(true);

    player.clear();
    const state = player.getState();
    expect(state.runId).toBeNull();
    expect(state.total).toBe(0);
    expect(state.index).toBe(0);
    expect(state.truncated).toBe(false);
    expect(sink.clears).toBeGreaterThan(0);
  });

  it("notifies subscribers on state changes", () => {
    const { player } = setup();
    let count = 0;
    const unsubscribe = player.subscribe(() => {
      count += 1;
    });
    player.load("run-c", recording(), false);
    player.play();
    player.pause();
    expect(count).toBeGreaterThan(0);
    unsubscribe();
    const before = count;
    player.reset();
    expect(count).toBe(before); // no longer notified
  });
});
