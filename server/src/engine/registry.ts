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
}

export interface RunRegistry {
  eventsSince(seq: number): RunEvent[];
  allEvents(): RunEvent[];
  snapshot(): RegistrySnapshot;
  report(options?: { generatedAt?: string; recordingDir?: string }): Report;
}

export function createRunRegistry(bus: EventBus): RunRegistry {
  const events: RunEvent[] = [];
  const runs = new Map<string, MutableRun>();

  bus.subscribe((event) => {
    events.push(event);
    if (event.type === "run.started") {
      runs.set(event.run_id, { started: event, events: [event] });
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

    allEvents(): RunEvent[] {
      return [...events];
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
      return buildReport(events, options);
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
      completed === undefined
        ? "running"
        : completed.result === "passed"
          ? "passed"
          : "failed",
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
