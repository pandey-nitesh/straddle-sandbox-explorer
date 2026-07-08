import {
  RunEventSchema,
  type Report,
  type RunEvent,
  type ScenarioDef,
  type ScenarioId,
} from "@sse/shared";

/**
 * Typed wrappers for the HTTP API (spec §9/§10), plus the event polling loop.
 *
 * Epoch discipline (spec §3): the server generates a fresh `epoch` at boot and
 * stamps it on every /api/events and /api/health response. `seq` is globally
 * monotonic only within one process, so a cursor from a dead epoch is
 * meaningless — on mismatch the client discards its state and re-hydrates
 * from GET /api/runs. That logic lives in `createEventPoller` below; the
 * event store consumes it through `PollerHandlers`.
 *
 * web/ never imports from server/ (redactor invariant), so the response
 * shapes that are not shared contracts (registry snapshot, health, run ids)
 * are declared here, mirroring server/src/http/routes.ts + registry.ts.
 */

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface HealthResponse {
  epoch: string;
  key: "ok" | "missing" | "invalid";
  /** M0 §18.5: the sandbox 401 body is empty, so this is normally absent. */
  error_body?: unknown;
}

export type RunSnapshotStatus = "running" | "passed" | "failed" | "partial";

/** One run in the registry snapshot (mirrors server RunSnapshot). */
export interface RunSnapshot {
  run_id: string;
  scenario_id: ScenarioId;
  scenario: ScenarioDef;
  status: RunSnapshotStatus;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  recording_path?: string;
  latest_for_scenario: boolean;
  events: RunEvent[];
}

/** GET /api/runs (mirrors server RegistrySnapshot). Carries no epoch. */
export interface RegistrySnapshot {
  runs: RunSnapshot[];
  latest_by_scenario: Partial<Record<ScenarioId, string>>;
}

/** GET /api/events?since=<seq> envelope. */
export interface EventsResponse {
  epoch: string;
  events: RunEvent[];
}

/** POST /api/runs 202 body. */
export interface StartRunsResponse {
  run_ids: string[];
}

export interface RecordingSummary {
  run_id: string;
  path: string;
  complete: boolean;
}

// ---------------------------------------------------------------------------
// Fetch plumbing
// ---------------------------------------------------------------------------

/** Injectable fetch (tests pass a fake; production uses window fetch). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// `fetch` must stay bound to its global — passing the bare reference around
// throws "Illegal invocation" in browsers.
const boundFetch: FetchLike = (input, init) => fetch(input, init);

/** Non-2xx API response, with the parsed body when one exists. */
export class ApiError extends Error {
  readonly path: string;
  readonly status: number;
  readonly body: unknown;

  constructor(path: string, status: number, body: unknown) {
    super(`${path} returned ${status}`);
    this.name = "ApiError";
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

async function requestJson<T>(
  fetchFn: FetchLike,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetchFn(path, init);
  const text = await response.text();
  let body: unknown;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) throw new ApiError(path, response.status, body);
  return body as T;
}

// ---------------------------------------------------------------------------
// Typed endpoint wrappers
// ---------------------------------------------------------------------------

export function getHealth(fetchFn: FetchLike = boundFetch): Promise<HealthResponse> {
  return requestJson<HealthResponse>(fetchFn, "/api/health");
}

export function getRuns(fetchFn: FetchLike = boundFetch): Promise<RegistrySnapshot> {
  return requestJson<RegistrySnapshot>(fetchFn, "/api/runs");
}

export function postRuns(
  scenarios: readonly ScenarioId[],
  fetchFn: FetchLike = boundFetch,
): Promise<StartRunsResponse> {
  return requestJson<StartRunsResponse>(fetchFn, "/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarios }),
  });
}

export function getEvents(
  since: number,
  fetchFn: FetchLike = boundFetch,
): Promise<EventsResponse> {
  return requestJson<EventsResponse>(
    fetchFn,
    `/api/events?since=${encodeURIComponent(since)}`,
  );
}

export function getReport(fetchFn: FetchLike = boundFetch): Promise<Report> {
  return requestJson<Report>(fetchFn, "/api/report");
}

export function getRecordings(
  fetchFn: FetchLike = boundFetch,
): Promise<RecordingSummary[]> {
  return requestJson<RecordingSummary[]>(fetchFn, "/api/recordings");
}

export interface RecordingEvents {
  events: RunEvent[];
  /** True when an invalid line cut the recording short — the valid prefix
   *  above it still plays (spec §11: partial files are valid prefixes). */
  truncated: boolean;
}

export async function getRecordingEvents(
  runId: string,
  fetchFn: FetchLike = boundFetch,
): Promise<RecordingEvents> {
  const response = await fetchFn(`/api/recordings/${encodeURIComponent(runId)}`);
  const text = await response.text();
  if (!response.ok) throw new ApiError(`/api/recordings/${runId}`, response.status, text);
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const events: RunEvent[] = [];
  for (const line of lines) {
    try {
      events.push(RunEventSchema.parse(JSON.parse(line)));
    } catch {
      // First bad line ends the valid prefix; everything after is suspect.
      return { events, truncated: true };
    }
  }
  return { events, truncated: false };
}

// ---------------------------------------------------------------------------
// Epoch gate
// ---------------------------------------------------------------------------

export type EpochCheck = "first" | "match" | "mismatch";

export interface EpochGate {
  /** The epoch currently trusted, or null before any response was seen. */
  current(): string | null;
  /**
   * Compare an observed epoch against the stored one. Adopts it when none is
   * stored ("first") and on "mismatch" (the new process is now the truth).
   */
  check(observed: string): EpochCheck;
  reset(): void;
}

export function createEpochGate(): EpochGate {
  let epoch: string | null = null;
  return {
    current: () => epoch,
    check(observed: string): EpochCheck {
      if (epoch === null) {
        epoch = observed;
        return "first";
      }
      if (epoch === observed) return "match";
      epoch = observed;
      return "mismatch";
    },
    reset() {
      epoch = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Event poller
// ---------------------------------------------------------------------------

export const DEFAULT_POLL_INTERVAL_MS = 2_000; // spec §9: client polling every ~2s

/**
 * The store side of the polling contract. `createEventStore().handlers`
 * satisfies this directly:
 *
 *   const store = createEventStore();
 *   const poller = createEventPoller({ handlers: store.handlers });
 *   poller.start();
 */
export interface PollerHandlers {
  /** Incremental delivery: events with seq > cursor, current epoch. */
  onEvents(events: RunEvent[]): void;
  /**
   * Full state replacement — fires on initial load and after an epoch
   * mismatch. The consumer must DISCARD everything it holds and rebuild from
   * this snapshot (spec §3).
   */
  onHydrate(snapshot: RegistrySnapshot): void;
  /** Network/HTTP failure for one cycle; polling continues regardless. */
  onError?(error: unknown): void;
}

export interface EventPollerOptions {
  handlers: PollerHandlers;
  /** Poll interval; default 2s. */
  intervalMs?: number;
  /** Injectable for tests. */
  fetchFn?: FetchLike;
  /** Share a gate with other epoch-carrying calls (e.g. header health pill). */
  epochGate?: EpochGate;
  /** Injectable EventSource factory; tests can force fallback by omitting it. */
  eventSourceFactory?: (url: string) => EventSource;
}

export interface EventPoller {
  /** Hydrates from GET /api/runs, then polls GET /api/events on the interval. */
  start(): void;
  stop(): void;
  /**
   * One poll cycle on demand (also used internally). Never rejects — errors
   * are routed to handlers.onError. Concurrent calls share one in-flight cycle.
   */
  tick(): Promise<void>;
  /** Highest seq seen in the current epoch (0 before hydration). */
  cursor(): number;
  /**
   * Feed an epoch observed OUTSIDE the events loop (e.g. from a
   * getHealth() response — spec §3: every epoch-carrying response is
   * checked). On mismatch the poller schedules a full re-hydration.
   */
  observeEpoch(epoch: string): void;
}

export function createEventPoller(options: EventPollerOptions): EventPoller {
  const handlers = options.handlers;
  const fetchFn = options.fetchFn ?? boundFetch;
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const gate = options.epochGate ?? createEpochGate();
  const eventSourceFactory =
    options.eventSourceFactory ??
    (options.fetchFn === undefined && typeof EventSource !== "undefined"
      ? (url: string) => new EventSource(url)
      : undefined);

  let cursor = 0;
  let hydrated = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;
  let source: EventSource | null = null;

  function invalidate(): void {
    cursor = 0;
    hydrated = false;
  }

  async function hydrate(): Promise<void> {
    const snapshot = await getRuns(fetchFn);
    cursor = snapshot.runs.reduce(
      (max, run) => run.events.reduce((m, event) => Math.max(m, event.seq), max),
      0,
    );
    hydrated = true;
    handlers.onHydrate(snapshot);
  }

  async function cycle(): Promise<void> {
    try {
      if (!hydrated) await hydrate();
      const response = await getEvents(cursor, fetchFn);
      if (gate.check(response.epoch) === "mismatch") {
        // Server restarted: the cursor and all downstream state belong to a
        // dead epoch. Drop this batch (the fresh snapshot supersedes it),
        // clear, re-hydrate (spec §3).
        invalidate();
        await hydrate();
        return;
      }
      if (response.events.length > 0) {
        // seq is monotonic but NOT dense — take the max, never count.
        cursor = response.events.reduce((max, event) => Math.max(max, event.seq), cursor);
        handlers.onEvents(response.events);
      }
    } catch (error) {
      handlers.onError?.(error);
    }
  }

  function tick(): Promise<void> {
    if (inFlight === null) {
      inFlight = cycle().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  function loop(): void {
    if (!running) return;
    void tick().finally(() => {
      if (!running) return;
      timer = setTimeout(loop, intervalMs);
    });
  }

  async function startSse(): Promise<void> {
    try {
      if (!hydrated) await hydrate();
      if (!running || source !== null) return;
      source = eventSourceFactory?.(`/api/events/stream?since=${cursor}`) ?? null;
      if (source === null) {
        loop();
        return;
      }
      source.addEventListener("epoch", (message: MessageEvent<string>) => {
        try {
          const payload = JSON.parse(message.data) as { epoch: string };
          if (gate.check(payload.epoch) === "mismatch") {
            source?.close();
            source = null;
            invalidate();
            if (running) void startSse();
          }
        } catch (error) {
          handlers.onError?.(error);
        }
      });
      source.addEventListener("run-event", (message: MessageEvent<string>) => {
        try {
          const event = RunEventSchema.parse(JSON.parse(message.data));
          cursor = Math.max(cursor, event.seq);
          handlers.onEvents([event]);
        } catch (error) {
          handlers.onError?.(error);
        }
      });
      source.onerror = () => {
        source?.close();
        source = null;
        if (running) loop();
      };
    } catch (error) {
      handlers.onError?.(error);
      if (running) loop();
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      if (eventSourceFactory !== undefined) void startSse();
      else loop();
    },
    stop(): void {
      running = false;
      if (source !== null) {
        source.close();
        source = null;
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    tick,
    cursor: () => cursor,
    observeEpoch(epoch: string): void {
      if (gate.check(epoch) !== "mismatch") return;
      invalidate();
      if (running) void tick();
    },
  };
}
