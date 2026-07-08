import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ScenarioId } from "@sse/shared";
import {
  ApiError,
  createEventPoller,
  getHealth,
  getReport,
  postRuns,
  type FetchLike,
} from "./api";
import { AppShell } from "./components/AppShell";
import { ReplayPanel } from "./components/ReplayPanel";
import { RunOverview } from "./components/RunOverview";
import { RunSummary } from "./components/RunSummary";
import { ScenarioList } from "./components/ScenarioList";
import { Timeline } from "./components/Timeline";
import { Toasts } from "./components/Toasts";
import { WireTabs } from "./components/WireTabs";
import { useNow } from "./components/useNow";
import {
  createEventStore,
  selectedRun,
  SUITE_SCENARIOS,
} from "./state/eventStore";
import { useExplain } from "./state/useExplain";
import {
  projectAssertionRows,
  projectDetailPanel,
  projectEvidence,
  projectEventConsoleEntries,
  projectExchanges,
  projectInspectorEntries,
  projectRunOverview,
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

/** Health re-check cadence — each hit costs a live sandbox request server-side
 *  (routes.ts pings Straddle), so this stays far above the 2s event cadence. */
const HEALTH_POLL_MS = 45_000;
/** Poll cycles that must fail consecutively before the header shows offline. */
const OFFLINE_AFTER_FAILURES = 2;

export function Dashboard({ fetchFn }: DashboardProps) {
  const [store] = useState(() => createEventStore());
  const [replayStore] = useState(() => createEventStore());
  const [replayResetToken, setReplayResetToken] = useState(0);
  const [keyStatus, setKeyStatus] = useState<"ok" | "missing" | "invalid">("ok");
  const [offline, setOffline] = useState(false);
  const pollFailures = useRef(0);
  const [poller] = useState(() =>
    createEventPoller({
      handlers: {
        // Wrap the store handlers so any successful cycle clears the offline
        // indicator and any run of failed cycles raises it (audit: a dead
        // server used to leave chips running and timers ticking, unsignalled).
        onEvents: (events) => {
          pollFailures.current = 0;
          setOffline(false);
          store.handlers.onEvents(events);
        },
        onHydrate: (snapshot) => {
          pollFailures.current = 0;
          setOffline(false);
          store.handlers.onHydrate(snapshot);
        },
        onError: () => {
          pollFailures.current += 1;
          if (pollFailures.current >= OFFLINE_AFTER_FAILURES) setOffline(true);
        },
      },
      ...(fetchFn !== undefined ? { fetchFn } : {}),
    }),
  );

  useEffect(() => {
    poller.start();
    return () => poller.stop();
  }, [poller]);

  // Header key-status pill (spec §13 Wave 5 item 7): a slow health poll keeps
  // the pill honest and feeds the epoch gate (spec §3 — every epoch-carrying
  // response is checked).
  const checkHealth = useCallback(async () => {
    try {
      const health = await getHealth(fetchFn);
      setKeyStatus(health.key);
      poller.observeEpoch(health.epoch);
    } catch {
      // Unreachable server is the poller's offline signal, not a key state.
    }
  }, [fetchFn, poller]);

  useEffect(() => {
    void checkHealth();
    const timer = setInterval(() => void checkHealth(), HEALTH_POLL_MS);
    return () => clearInterval(timer);
  }, [checkHealth]);

  const state = useSyncExternalStore(store.subscribe, store.getState);
  const replayState = useSyncExternalStore(
    replayStore.subscribe,
    replayStore.getState,
  );
  const [explain, toggleExplain] = useExplain();

  const clearReplayView = useCallback(() => {
    setReplayResetToken((token) => token + 1);
  }, []);

  const startRuns = useCallback(
    async (scenarios: readonly ScenarioId[]) => {
      try {
        await postRuns(scenarios, fetchFn);
        // Pick new runs up immediately instead of waiting out the interval.
        await poller.tick();
      } catch (error) {
        // A failed start is not a crash; the health pill / console carry it.
        console.error("failed to start runs", error);
        // A 400 here usually means the key died mid-session — re-check now
        // instead of waiting out the health interval.
        if (error instanceof ApiError && error.status === 400) {
          void checkHealth();
        }
      }
    },
    [checkHealth, fetchFn, poller],
  );

  const onRunAll = useCallback(() => {
    clearReplayView();
    // The center pane needs a subject: default to C, the demo's stage.
    if (store.getState().selectedScenario === null) store.selectScenario("c");
    void startRuns(SUITE_SCENARIOS);
  }, [clearReplayView, store, startRuns]);

  const onRun = useCallback(
    (id: string) => {
      const scenario = toScenarioId(id);
      if (scenario === null) return;
      clearReplayView();
      store.selectScenario(scenario);
      void startRuns([scenario]);
    },
    [clearReplayView, store, startRuns],
  );

  const onSelect = useCallback(
    (id: string) => {
      const scenario = toScenarioId(id);
      if (scenario !== null) {
        clearReplayView();
        store.selectScenario(scenario);
      }
    },
    [clearReplayView, store],
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
  const items = useMemo(
    () => projectScenarioItems(state, { explain }),
    [state, explain],
  );
  const liveRun = selectedRun(state);
  const replayRun = selectedRun(replayState);
  const run = replayRun ?? liveRun;
  const timelineNodes = useMemo(
    () => (run === null ? [] : projectTimelineNodes(run, { explain })),
    [run, explain],
  );
  const runOverview = useMemo(
    () => (run === null ? undefined : projectRunOverview(run, { explain })),
    [run, explain],
  );
  const evidence = useMemo(
    () => (run === null ? undefined : projectEvidence(run)),
    [run],
  );
  const exchanges = useMemo(
    () => (run === null ? [] : projectExchanges(run, { explain })),
    [run, explain],
  );
  const detailPanel = useMemo(
    () => (run === null ? undefined : projectDetailPanel(run, { explain })),
    [run, explain],
  );
  const inspectorEntries = useMemo(
    () => (run === null ? [] : projectInspectorEntries(run)),
    [run],
  );
  const eventConsoleEntries = useMemo(
    () => (run === null ? [] : projectEventConsoleEntries(run)),
    [run],
  );
  const assertionRows = useMemo(() => projectAssertionRows(state), [state]);
  // Recordings appear when runs complete — this token refreshes the replay list.
  const completedCount = useMemo(
    () =>
      Object.values(state.runs).filter((r) => r.completed !== undefined).length,
    [state],
  );

  const summary = state.summary;
  const suiteLive = summary.covered > 0 && !summary.allSettled;
  const now = useNow(suiteLive);
  const elapsedMs =
    summary.elapsedMs ??
    (summary.earliestStartedAt !== null
      ? Math.max(0, now - Date.parse(summary.earliestStartedAt))
      : 0);

  return (
    <>
      <AppShell
        onRunAll={onRunAll}
        keyStatus={keyStatus}
        offline={offline}
        // Offline WHILE a suite is live means the panes are frozen on stale
        // evidence (P2-R.5) — surface it loudly, not just as a header chip.
        stale={offline && suiteLive}
        explainEnabled={explain}
        onToggleExplain={toggleExplain}
        scenarios={
          <div className="space-y-4">
            <ScenarioList
              items={items}
              {...(state.selectedScenario !== null
                ? { selectedId: state.selectedScenario }
                : {})}
              onSelect={onSelect}
              onRun={onRun}
            />
            <ReplayPanel
              fetchFn={fetchFn}
              store={replayStore}
              resetToken={replayResetToken}
              showPreview={false}
              explain={explain}
              refreshToken={completedCount}
            />
          </div>
        }
        lifecycle={
          run === null || runOverview === undefined ? undefined : (
            // Keyed by run so open learning notes never leak across scenario
            // switches or epoch resets (audit finding).
            <div key={run.runId} className="mx-auto w-full max-w-[460px]">
              <RunOverview {...runOverview} />
              <Timeline
                nodes={timelineNodes}
                live={run.completed === undefined}
                {...(evidence !== undefined ? { evidence } : {})}
              />
            </div>
          )
        }
        wire={
          run === null || detailPanel === undefined ? undefined : (
            <WireTabs
              details={detailPanel}
              events={inspectorEntries}
              consoleEntries={eventConsoleEntries}
              exchanges={exchanges}
            />
          )
        }
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
      {/* Offscreen-transition toasts (design §6.5), fed by the LIVE store only —
          replay uses a separate store instance, so playback never toasts. */}
      <Toasts store={store} onSelect={onSelect} />
    </>
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
