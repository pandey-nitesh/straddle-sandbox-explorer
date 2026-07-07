import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ScenarioId } from "@sse/shared";
import {
  createEventPoller,
  getReport,
  postRuns,
  type FetchLike,
} from "./api";
import { AppShell } from "./components/AppShell";
import { ExchangeLog } from "./components/ExchangeLog";
import { RunSummary } from "./components/RunSummary";
import { ScenarioList } from "./components/ScenarioList";
import { Timeline } from "./components/Timeline";
import { useNow } from "./components/useNow";
import {
  createEventStore,
  selectedRun,
  SUITE_SCENARIOS,
} from "./state/eventStore";
import {
  projectAssertionRows,
  projectEvidence,
  projectExchanges,
  projectScenarioItems,
  projectTimelineNodes,
} from "./state/projections";

/**
 * The ready-state screen (spec §10): one event store fed by one poller; every
 * pane is a projection of the store. `fetchFn` is injectable for tests; the
 * browser uses the bound window fetch defaults in api.ts.
 */
export interface DashboardProps {
  fetchFn?: FetchLike;
}

const SCENARIO_IDS = new Set<string>(SUITE_SCENARIOS);

function toScenarioId(id: string): ScenarioId | null {
  return SCENARIO_IDS.has(id) ? (id as ScenarioId) : null;
}

export function Dashboard({ fetchFn }: DashboardProps) {
  const [store] = useState(() => createEventStore());
  const [poller] = useState(() =>
    createEventPoller({
      handlers: store.handlers,
      ...(fetchFn !== undefined ? { fetchFn } : {}),
    }),
  );

  useEffect(() => {
    poller.start();
    return () => poller.stop();
  }, [poller]);

  const state = useSyncExternalStore(store.subscribe, store.getState);

  const startRuns = useCallback(
    async (scenarios: readonly ScenarioId[]) => {
      try {
        await postRuns(scenarios, fetchFn);
        // Pick new runs up immediately instead of waiting out the interval.
        await poller.tick();
      } catch (error) {
        // A failed start is not a crash; the health pill / console carry it.
        console.error("failed to start runs", error);
      }
    },
    [fetchFn, poller],
  );

  const onRunAll = useCallback(() => {
    // The center pane needs a subject: default to C, the demo's stage.
    if (store.getState().selectedScenario === null) store.selectScenario("c");
    void startRuns(SUITE_SCENARIOS);
  }, [store, startRuns]);

  const onRun = useCallback(
    (id: string) => {
      const scenario = toScenarioId(id);
      if (scenario === null) return;
      store.selectScenario(scenario);
      void startRuns([scenario]);
    },
    [store, startRuns],
  );

  const onSelect = useCallback(
    (id: string) => {
      const scenario = toScenarioId(id);
      if (scenario !== null) store.selectScenario(scenario);
    },
    [store],
  );

  const onDownloadReport = useCallback(() => {
    void (async () => {
      try {
        const report = await getReport(fetchFn);
        downloadJson(report, "report.json");
      } catch (error) {
        console.error("failed to download report", error);
      }
    })();
  }, [fetchFn]);

  // ---- Projections ---------------------------------------------------------
  const items = useMemo(() => projectScenarioItems(state), [state]);
  const run = selectedRun(state);
  const timelineNodes = useMemo(
    () => (run === null ? [] : projectTimelineNodes(run)),
    [run],
  );
  const evidence = useMemo(
    () => (run === null ? undefined : projectEvidence(run)),
    [run],
  );
  const exchanges = useMemo(
    () => (run === null ? [] : projectExchanges(run)),
    [run],
  );
  const assertionRows = useMemo(() => projectAssertionRows(state), [state]);

  const summary = state.summary;
  const suiteLive = summary.covered > 0 && !summary.allSettled;
  const now = useNow(suiteLive);
  const elapsedMs =
    summary.elapsedMs ??
    (summary.earliestStartedAt !== null
      ? Math.max(0, now - Date.parse(summary.earliestStartedAt))
      : 0);

  return (
    <AppShell
      onRunAll={onRunAll}
      scenarios={
        <ScenarioList
          items={items}
          {...(state.selectedScenario !== null
            ? { selectedId: state.selectedScenario }
            : {})}
          onSelect={onSelect}
          onRun={onRun}
        />
      }
      lifecycle={
        run === null ? undefined : (
          <Timeline
            nodes={timelineNodes}
            live={run.completed === undefined}
            {...(evidence !== undefined ? { evidence } : {})}
          />
        )
      }
      wire={run === null || exchanges.length === 0 ? undefined : (
        <ExchangeLog entries={exchanges} />
      )}
      summary={
        summary.covered === 0 ? undefined : (
          <RunSummary
            passed={summary.passed}
            total={summary.total}
            elapsedMs={elapsedMs}
            scenarios={assertionRows}
            onDownloadReport={onDownloadReport}
          />
        )
      }
    />
  );
}

/** UI export path: the blob the user downloads IS the /api/report payload. */
function downloadJson(value: unknown, filename: string): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
