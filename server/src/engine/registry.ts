import type {
  Report,
  RunCompletedEvent,
  RunEvent,
  RunStartedEvent,
  ScenarioId,
} from "@sse/shared";
import type { EventBus } from "./bus.js";
import { buildReport } from "./report.js";

export type RunStatus = "running" | "passed" | "failed" | "partial";

export interface RunSnapshot {
  run_id: string;
  scenario_id: ScenarioId;
  scenario: RunStartedEvent["scenario"];
  status: RunStatus;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  recording_path?: string;
  latest_for_scenario: boolean;
  events: RunEvent[];
}

export interface RegistrySnapshot {
  runs: RunSnapshot[];
  latest_by_scenario: Partial<Record<ScenarioId, string>>;
}

interface MutableRun {
  started: RunStartedEvent;
  completed?: RunCompletedEvent;
  events: RunEvent[];
  /**
   * True for runs recovered from disk at boot (P2-R.1). A rehydrated run whose
   * recording lacks a `run.completed` line belongs to a dead process, so it is
   * `partial` (spec §5), never `running` — nothing will ever finish it.
   */
  rehydrated: boolean;
}

/**
 * Delivery-buffer bound (P2-R.5). The flat buffer that backs `eventsSince` is
 * capped so a marathon session can't grow it without limit and a client polling
 * on the interval can't scan an ever-growing array. When the cap is exceeded the
 * OLDEST events are evicted from the delivery buffer only — full per-run history
 * survives in the runs map (that is what backs the snapshot and the report), so
 * evicting delivery events never corrupts either. A client whose cursor predates
 * the evicted window is told to re-hydrate (`resyncNeeded`) rather than silently
 * missing the gap.
 */
export const DEFAULT_MAX_DELIVERY_EVENTS = 10_000;

export interface CreateRegistryOptions {
  /** Delivery-buffer cap (P2-R.5). Default {@link DEFAULT_MAX_DELIVERY_EVENTS}. */
  maxEvents?: number;
}

export interface RunRegistry {
  eventsSince(seq: number): RunEvent[];
  /**
   * True when `seq` predates the evicted delivery window (P2-R.5) — the gap
   * between `seq` and the oldest retained event cannot be served, so the client
   * must re-hydrate from the snapshot instead of trusting an incremental fetch.
   */
  resyncNeeded(seq: number): boolean;
  allEvents(): RunEvent[];
  snapshot(): RegistrySnapshot;
  report(options?: { generatedAt?: string; recordingDir?: string }): Report;
  /**
   * Ingest historical events recovered from `runs/*.jsonl` at boot (spec §3,
   * P2-R.1). Events must already be renumbered into this process's seq space
   * (see `loadRecordedEvents`). Ingested directly, NOT through the bus — they
   * are already recorded on disk, so re-emitting them would double-write and
   * re-assign seq. Call once at boot, before any live run starts.
   */
  hydrate(events: readonly RunEvent[]): void;
}

export function createRunRegistry(
  bus: EventBus,
  options: CreateRegistryOptions = {},
): RunRegistry {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_DELIVERY_EVENTS;
  // Bounded delivery buffer (P2-R.5) — backs eventsSince only.
  const events: RunEvent[] = [];
  // Highest seq evicted from the delivery buffer; a cursor at or below this
  // cannot be served incrementally.
  let droppedBefore = 0;
  const runs = new Map<string, MutableRun>();

  function pushDelivery(event: RunEvent): void {
    events.push(event);
    while (events.length > maxEvents) {
      const removed = events.shift();
      if (removed !== undefined) droppedBefore = Math.max(droppedBefore, removed.seq);
    }
  }

  // Full history for the snapshot/report projections — never evicted, seq-sorted.
  function collectAll(): RunEvent[] {
    return [...runs.values()]
      .flatMap((run) => run.events)
      .sort((a, b) => a.seq - b.seq);
  }

  bus.subscribe((event) => {
    pushDelivery(event);
    if (event.type === "run.started") {
      runs.set(event.run_id, { started: event, events: [event], rehydrated: false });
      return;
    }
    const run = runs.get(event.run_id);
    if (run === undefined) return;
    run.events.push(event);
    if (event.type === "run.completed") run.completed = event;
  });

  return {
    eventsSince(seq: number): RunEvent[] {
      return events.filter((event) => event.seq > seq);
    },

    resyncNeeded(seq: number): boolean {
      return seq < droppedBefore;
    },

    allEvents(): RunEvent[] {
      return collectAll();
    },

    hydrate(historical: readonly RunEvent[]): void {
      for (const event of historical) {
        pushDelivery(event);
        if (event.type === "run.started") {
          runs.set(event.run_id, { started: event, events: [event], rehydrated: true });
          continue;
        }
        const run = runs.get(event.run_id);
        // An event whose run.started was lost to a corrupt first line is an
        // orphan — there is no run to attach it to, so drop it.
        if (run === undefined) continue;
        run.events.push(event);
        if (event.type === "run.completed") run.completed = event;
      }
    },

    snapshot(): RegistrySnapshot {
      const latest = latestByScenario(runs);
      const snapshots = [...runs.values()]
        .sort((a, b) => a.started.seq - b.started.seq)
        .map((run) => toSnapshot(run, latest));
      return {
        runs: snapshots,
        latest_by_scenario: Object.fromEntries(latest) as Partial<
          Record<ScenarioId, string>
        >,
      };
    },

    report(options = {}): Report {
      return buildReport(collectAll(), options);
    },
  };
}

function latestByScenario(
  runs: Map<string, MutableRun>,
): Map<ScenarioId, string> {
  const latest = new Map<ScenarioId, MutableRun>();
  for (const run of runs.values()) {
    const existing = latest.get(run.started.scenario_id);
    if (existing === undefined || run.started.seq > existing.started.seq) {
      latest.set(run.started.scenario_id, run);
    }
  }
  return new Map(
    [...latest.entries()].map(([scenarioId, run]) => [
      scenarioId,
      run.started.run_id,
    ]),
  );
}

function toSnapshot(
  run: MutableRun,
  latest: Map<ScenarioId, string>,
): RunSnapshot {
  const completed = run.completed;
  return {
    run_id: run.started.run_id,
    scenario_id: run.started.scenario_id,
    scenario: run.started.scenario,
    status:
      completed !== undefined
        ? completed.result === "passed"
          ? "passed"
          : "failed"
        : run.rehydrated
          ? "partial"
          : "running",
    started_at: run.started.timestamp,
    ...(completed !== undefined
      ? {
          completed_at: completed.timestamp,
          duration_ms: completed.duration_ms,
          recording_path: completed.recording_path,
        }
      : {}),
    latest_for_scenario:
      latest.get(run.started.scenario_id) === run.started.run_id,
    events: [...run.events],
  };
}
