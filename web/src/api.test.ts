import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunEvent, ScenarioDef } from "@sse/shared";
import {
  ApiError,
  createEpochGate,
  createEventPoller,
  getEvents,
  getHealth,
  getRecordingEvents,
  getRecordings,
  getReport,
  getRuns,
  postRuns,
  type FetchLike,
  type PollerHandlers,
  type RegistrySnapshot,
} from "./api";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEF_A: ScenarioDef = {
  id: "a",
  label: "Happy path",
  purpose: "charge settles",
  outcomes: { customer: "verified", charge: "paid" },
  requiredObservations: [{ kind: "terminal_status", status: "paid" }],
};

function started(seq: number, runId: string): RunEvent {
  return {
    type: "run.started",
    seq,
    timestamp: "2026-07-07T14:00:00.000Z",
    run_id: runId,
    scenario_id: "a",
    scenario: DEF_A,
  };
}

function statusEvent(seq: number, runId: string, to: string): RunEvent {
  return {
    type: "payment.status_changed",
    seq,
    timestamp: "2026-07-07T14:00:05.000Z",
    run_id: runId,
    scenario_id: "a",
    resource_id: "chg_1",
    from: null,
    to,
  };
}

function snapshotWith(events: RunEvent[]): RegistrySnapshot {
  const first = events[0];
  if (first === undefined) return { runs: [], latest_by_scenario: {} };
  return {
    runs: [
      {
        run_id: first.run_id,
        scenario_id: "a",
        scenario: DEF_A,
        status: "running",
        started_at: first.timestamp,
        latest_for_scenario: true,
        events,
      },
    ],
    latest_by_scenario: { a: first.run_id },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Route-based fake server whose epoch/snapshot/events mutate mid-test. */
function fakeServer(initial: {
  epoch: string;
  snapshot?: RegistrySnapshot;
  events?: RunEvent[];
  recordings?: Record<string, RunEvent[]>;
}) {
  const state = {
    epoch: initial.epoch,
    snapshot: initial.snapshot ?? { runs: [], latest_by_scenario: {} },
    events: initial.events ?? [],
    recordings: initial.recordings ?? {},
  };
  const calls: Array<{ input: string; method: string }> = [];
  const fetchFn: FetchLike = async (input, init) => {
    calls.push({ input, method: init?.method ?? "GET" });
    if (input === "/api/runs" && init?.method === "POST") {
      return json({ run_ids: ["run-1"] }, 202);
    }
    if (input === "/api/runs") return json(state.snapshot);
    if (input.startsWith("/api/events?since=")) {
      const since = Number(input.slice("/api/events?since=".length));
      return json({
        epoch: state.epoch,
        events: state.events.filter((e) => e.seq > since),
      });
    }
    if (input === "/api/recordings") {
      return json(
        Object.entries(state.recordings).map(([run_id, recording]) => ({
          run_id,
          path: `/tmp/${run_id}.jsonl`,
          complete: recording.some((event) => event.type === "run.completed"),
        })),
      );
    }
    if (input.startsWith("/api/recordings/")) {
      const runId = decodeURIComponent(input.slice("/api/recordings/".length));
      const recording = state.recordings[runId];
      if (recording === undefined) return json({ error: "not found" }, 404);
      return new Response(
        `${recording.map((event) => JSON.stringify(event)).join("\n")}\n`,
        { headers: { "content-type": "application/x-ndjson" } },
      );
    }
    if (input === "/api/health") return json({ epoch: state.epoch, key: "ok" });
    if (input === "/api/report") return json({ generated_at: "x" });
    return json({ error: "not found" }, 404);
  };
  return { state, calls, fetchFn };
}

class FakeEventSource {
  onerror: (() => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }

  fail(): void {
    this.onerror?.();
  }
}

function collectingHandlers() {
  const hydrations: RegistrySnapshot[] = [];
  const batches: RunEvent[][] = [];
  const errors: unknown[] = [];
  const handlers: PollerHandlers = {
    onHydrate: (snapshot) => hydrations.push(snapshot),
    onEvents: (events) => batches.push(events),
    onError: (error) => errors.push(error),
  };
  return { handlers, hydrations, batches, errors };
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("typed endpoint wrappers", () => {
  it("hit the documented paths with the right methods and bodies", async () => {
    const server = fakeServer({ epoch: "e1" });

    await getHealth(server.fetchFn);
    await getRuns(server.fetchFn);
    await getEvents(7, server.fetchFn);
    await getReport(server.fetchFn);
    await getRecordings(server.fetchFn);
    await getRecordingEvents("run-1", server.fetchFn).catch(() => undefined);
    const created = await postRuns(["a", "c"], server.fetchFn);

    expect(server.calls.map((c) => `${c.method} ${c.input}`)).toEqual([
      "GET /api/health",
      "GET /api/runs",
      "GET /api/events?since=7",
      "GET /api/report",
      "GET /api/recordings",
      "GET /api/recordings/run-1",
      "POST /api/runs",
    ]);
    expect(created).toEqual({ run_ids: ["run-1"] });
  });

  it("parses recording summaries and JSONL recording events", async () => {
    const runId = "run-1";
    const recording = [started(1, runId), statusEvent(2, runId, "paid")];
    const server = fakeServer({
      epoch: "e1",
      recordings: { [runId]: recording },
    });

    await expect(getRecordings(server.fetchFn)).resolves.toEqual([
      { run_id: runId, path: `/tmp/${runId}.jsonl`, complete: false },
    ]);
    await expect(getRecordingEvents(runId, server.fetchFn)).resolves.toEqual({
      events: recording,
      truncated: false,
    });
  });

  it("postRuns serializes the scenario selection as JSON", async () => {
    let captured: RequestInit | undefined;
    const fetchFn: FetchLike = async (_input, init) => {
      captured = init;
      return json({ run_ids: [] }, 202);
    };
    await postRuns(["b"], fetchFn);
    expect(captured?.headers).toEqual({ "content-type": "application/json" });
    expect(captured?.body).toBe('{"scenarios":["b"]}');
  });

  it("throws ApiError with the parsed body on non-2xx", async () => {
    const fetchFn: FetchLike = async () =>
      json({ error: "STRADDLE_API_KEY is missing" }, 400);
    const error = await postRuns(["a"], fetchFn).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    if (error instanceof ApiError) {
      expect(error.status).toBe(400);
      expect(error.body).toEqual({ error: "STRADDLE_API_KEY is missing" });
    }
  });

  it("tolerates empty and non-JSON bodies", async () => {
    const empty: FetchLike = async () => new Response("", { status: 502 });
    const error = await getHealth(empty).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    if (error instanceof ApiError) expect(error.body).toBeUndefined();
  });
});

describe("epoch gate", () => {
  it("adopts first, matches same, flags and adopts on change", () => {
    const gate = createEpochGate();
    expect(gate.current()).toBeNull();
    expect(gate.check("e1")).toBe("first");
    expect(gate.check("e1")).toBe("match");
    expect(gate.check("e2")).toBe("mismatch");
    expect(gate.current()).toBe("e2"); // the new process is now the truth
    expect(gate.check("e2")).toBe("match");
  });
});

describe("event poller", () => {
  it("hydrates from /api/runs, then delivers incremental events past the cursor", async () => {
    const seeded = [started(1, "run-1"), statusEvent(3, "run-1", "created")];
    const server = fakeServer({
      epoch: "e1",
      snapshot: snapshotWith(seeded),
      events: seeded,
    });
    const collected = collectingHandlers();
    const poller = createEventPoller({
      handlers: collected.handlers,
      fetchFn: server.fetchFn,
    });

    await poller.tick();
    expect(collected.hydrations).toHaveLength(1);
    expect(collected.hydrations[0]?.runs[0]?.run_id).toBe("run-1");
    expect(collected.batches).toEqual([]); // nothing past the snapshot cursor
    expect(poller.cursor()).toBe(3);

    // New events land (seq gap 3 → 9 is fine — density never assumed)
    server.state.events = [...seeded, statusEvent(9, "run-1", "paid")];
    await poller.tick();
    expect(collected.batches).toHaveLength(1);
    expect(collected.batches[0]?.map((e) => e.seq)).toEqual([9]);
    expect(poller.cursor()).toBe(9);

    // Nothing new: no empty onEvents call
    await poller.tick();
    expect(collected.batches).toHaveLength(1);
  });

  it("on epoch mismatch: discards the batch, resets, re-hydrates from /api/runs", async () => {
    const oldEvents = [started(1, "run-old"), statusEvent(900, "run-old", "paid")];
    const server = fakeServer({
      epoch: "e1",
      snapshot: snapshotWith(oldEvents),
      events: oldEvents,
    });
    const collected = collectingHandlers();
    const poller = createEventPoller({
      handlers: collected.handlers,
      fetchFn: server.fetchFn,
    });

    await poller.tick(); // adopt e1, cursor 900
    expect(poller.cursor()).toBe(900);

    // Server restarts: fresh epoch, seq restarted below the stale cursor
    const newEvents = [started(1, "run-new"), statusEvent(2, "run-new", "created")];
    server.state.epoch = "e2";
    server.state.snapshot = snapshotWith(newEvents);
    server.state.events = newEvents;

    await poller.tick();
    expect(collected.hydrations).toHaveLength(2); // full re-hydration
    expect(collected.hydrations[1]?.runs[0]?.run_id).toBe("run-new");
    expect(collected.batches).toEqual([]); // mismatch batch was discarded
    expect(poller.cursor()).toBe(2); // rebuilt from the new snapshot

    // Next cycle continues incrementally in the new epoch
    server.state.events = [...newEvents, statusEvent(5, "run-new", "paid")];
    await poller.tick();
    expect(collected.batches[0]?.map((e) => e.seq)).toEqual([5]);
  });

  it("routes cycle failures to onError and keeps polling", async () => {
    const server = fakeServer({ epoch: "e1" });
    const collected = collectingHandlers();
    let failNext = true;
    const flaky: FetchLike = async (input, init) => {
      if (failNext) {
        failNext = false;
        throw new TypeError("network down");
      }
      return server.fetchFn(input, init);
    };
    const poller = createEventPoller({ handlers: collected.handlers, fetchFn: flaky });

    await poller.tick(); // hydrate fails
    expect(collected.errors).toHaveLength(1);
    expect(collected.hydrations).toHaveLength(0);

    await poller.tick(); // recovers
    expect(collected.hydrations).toHaveLength(1);
  });

  it("re-hydrates when the server signals resync (P2-R.5)", async () => {
    const server = fakeServer({
      epoch: "e1",
      snapshot: snapshotWith([started(1, "run-1")]),
    });
    const collected = collectingHandlers();
    let resyncOnce = true;
    const withResync: FetchLike = async (input, init) => {
      if (input.startsWith("/api/events?since=") && resyncOnce) {
        resyncOnce = false;
        return json({ epoch: "e1", resync: true, events: [] });
      }
      return server.fetchFn(input, init);
    };
    const poller = createEventPoller({
      handlers: collected.handlers,
      fetchFn: withResync,
    });

    // One cycle: hydrate → getEvents returns resync → invalidate + re-hydrate.
    await poller.tick();
    expect(collected.hydrations.length).toBeGreaterThanOrEqual(2);
    // The resync batch carried no events and was not delivered as a delta.
    expect(collected.batches).toEqual([]);
  });

  it("observeEpoch (e.g. from a health response) forces re-hydration on mismatch", async () => {
    const server = fakeServer({ epoch: "e1", snapshot: snapshotWith([started(1, "run-1")]) });
    const collected = collectingHandlers();
    const poller = createEventPoller({
      handlers: collected.handlers,
      fetchFn: server.fetchFn,
    });
    await poller.tick();
    expect(collected.hydrations).toHaveLength(1);

    poller.observeEpoch("e1"); // matches — nothing happens
    await poller.tick();
    expect(collected.hydrations).toHaveLength(1);

    server.state.epoch = "e2";
    server.state.snapshot = snapshotWith([started(1, "run-2")]);
    poller.observeEpoch("e2"); // health saw the restart first
    await poller.tick();
    expect(collected.hydrations).toHaveLength(2);
    expect(collected.hydrations[1]?.runs[0]?.run_id).toBe("run-2");
  });

  it("start() polls on the ~2s default interval until stop()", async () => {
    vi.useFakeTimers();
    const server = fakeServer({ epoch: "e1" });
    const collected = collectingHandlers();
    const poller = createEventPoller({
      handlers: collected.handlers,
      fetchFn: server.fetchFn,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0); // immediate first cycle
    const eventCalls = () =>
      server.calls.filter((c) => c.input.startsWith("/api/events")).length;
    expect(collected.hydrations).toHaveLength(1);
    expect(eventCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(eventCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(eventCalls()).toBe(3);

    poller.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(eventCalls()).toBe(3);
  });

  it("concurrent tick() calls share one in-flight cycle", async () => {
    const server = fakeServer({ epoch: "e1" });
    const collected = collectingHandlers();
    const poller = createEventPoller({
      handlers: collected.handlers,
      fetchFn: server.fetchFn,
    });
    await Promise.all([poller.tick(), poller.tick(), poller.tick()]);
    expect(server.calls.filter((c) => c.input === "/api/runs")).toHaveLength(1);
  });

  it("uses SSE and reconnects with backoff on a transient drop (not a downgrade)", async () => {
    vi.useFakeTimers();
    const initial = [started(1, "run-1")];
    const server = fakeServer({
      epoch: "e1",
      snapshot: snapshotWith(initial),
      events: initial,
    });
    const collected = collectingHandlers();
    const sources: FakeEventSource[] = [];
    const urls: string[] = [];
    const poller = createEventPoller({
      handlers: collected.handlers,
      fetchFn: server.fetchFn,
      eventSourceFactory: (url) => {
        urls.push(url);
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as EventSource;
      },
      sseMaxRetries: 3,
      sseReconnectMinMs: 100,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0); // hydrate resolves, first source opens
    expect(urls[0]).toBe("/api/events/stream?since=1");
    sources[0]?.emit("epoch", { epoch: "e1" });
    sources[0]?.emit("run-event", statusEvent(3, "run-1", "paid"));
    expect(poller.cursor()).toBe(3);

    // A drop reconnects SSE (resuming at the cursor) rather than polling.
    sources[0]?.fail();
    expect(sources[0]?.closed).toBe(true);
    expect(server.calls.some((c) => c.input.startsWith("/api/events?since="))).toBe(false);
    await vi.advanceTimersByTimeAsync(100); // exponential backoff, first step
    expect(sources).toHaveLength(2);
    expect(urls[1]).toBe("/api/events/stream?since=3");

    sources[1]?.emit("run-event", statusEvent(5, "run-1", "reversed"));
    expect(poller.cursor()).toBe(5);
    poller.stop();
  });

  it("downgrades to polling after repeated SSE failures, then upgrades back on recovery", async () => {
    vi.useFakeTimers();
    const initial = [started(1, "run-1")];
    const server = fakeServer({
      epoch: "e1",
      snapshot: snapshotWith(initial),
      events: initial,
    });
    const collected = collectingHandlers();
    const sources: FakeEventSource[] = [];
    const poller = createEventPoller({
      handlers: collected.handlers,
      fetchFn: server.fetchFn,
      eventSourceFactory: (url) => {
        void url;
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as EventSource;
      },
      intervalMs: 10_000,
      sseMaxRetries: 2,
      sseReconnectMinMs: 100,
      sseUpgradeIntervalMs: 1_000,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0); // source[0]
    // A live event arrives before the outage, so polling has something to fetch.
    server.state.events = [...initial, statusEvent(7, "run-1", "paid")];

    sources[0]?.fail(); // failure 1 → reconnect
    await vi.advanceTimersByTimeAsync(100);
    sources[1]?.fail(); // failure 2 → reconnect
    await vi.advanceTimersByTimeAsync(200);
    sources[2]?.fail(); // failure 3 > max(2) → downgrade to polling
    await vi.advanceTimersByTimeAsync(0);

    const pollCount = () =>
      server.calls.filter((c) => c.input.startsWith("/api/events?since=")).length;
    expect(pollCount()).toBeGreaterThanOrEqual(1);
    expect(collected.batches.at(-1)?.map((e) => e.seq)).toContain(7);
    const sourcesAfterDowngrade = sources.length;

    // The upgrade timer reconnects SSE; a delivered event proves recovery.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sources.length).toBeGreaterThan(sourcesAfterDowngrade);
    sources.at(-1)?.emit("run-event", statusEvent(9, "run-1", "reversed"));
    expect(poller.cursor()).toBe(9);
    poller.stop();
  });
});
