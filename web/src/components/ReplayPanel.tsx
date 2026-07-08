import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RunEvent } from "@sse/shared";
import {
  getRecordingEvents,
  getRecordings,
  type FetchLike,
  type RecordingSummary,
} from "../api";
import {
  createEventStore,
  selectedRun,
} from "../state/eventStore";
import {
  projectExchanges,
  projectTimelineNodes,
} from "../state/projections";
import { ExchangeLog } from "./ExchangeLog";
import { Timeline } from "./Timeline";

const REPLAY_SPEED = 10;

export interface ReplayPanelProps {
  fetchFn?: FetchLike;
  /** Learning-layer toggle — threaded from the header so replay annotates
   *  exactly like live runs (spec §19). */
  explain?: boolean;
  /** Bump to refetch the recordings list (e.g. when a run completes), so
   *  recordings made during the session appear without a page reload. */
  refreshToken?: number;
}

export function ReplayPanel({ fetchFn, explain = false, refreshToken = 0 }: ReplayPanelProps) {
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loaded, setLoaded] = useState<RecordingSummary | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [store] = useState(() => createEventStore());
  const timers = useRef<number[]>([]);
  const state = useSyncExternalStore(store.subscribe, store.getState);

  const clearReplay = useCallback(() => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getRecordings(fetchFn)
      .then((items) => {
        if (cancelled) return;
        setRecordings(items);
        // Keep the user's selection when it still exists; otherwise default
        // to the first entry.
        setSelected((current) =>
          items.some((item) => item.run_id === current)
            ? current
            : (items[0]?.run_id ?? ""),
        );
      })
      .catch(() => {
        if (!cancelled) setRecordings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchFn, refreshToken]);

  useEffect(() => clearReplay, [clearReplay]);

  const load = useCallback(async () => {
    const summary = recordings.find((item) => item.run_id === selected);
    if (summary === undefined) return;
    try {
      const recording = await getRecordingEvents(summary.run_id, fetchFn);
      setLoadError(null);
      setLoaded(summary);
      setTruncated(recording.truncated);
      replay(recording.events, store, clearReplay, timers.current);
    } catch {
      setLoadError(`could not load ${summary.run_id}`);
    }
  }, [clearReplay, fetchFn, recordings, selected, store]);

  const run = selectedRun(state);
  const timeline = useMemo(
    () => (run === null ? [] : projectTimelineNodes(run, { explain })),
    [run, explain],
  );
  const exchanges = useMemo(
    () => (run === null ? [] : projectExchanges(run, { explain })),
    [run, explain],
  );

  return (
    <div className="space-y-3 border-t border-edge pt-4">
      <div className="flex items-center gap-2">
        <h3 className="pane-header flex-1">Replay</h3>
        {loaded !== null && (!loaded.complete || truncated) && (
          <span className="rounded-chip border border-status-provisional px-2 py-0.5 text-xs text-status-provisional">
            partial
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <select
          aria-label="Recording"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className="wire-quote min-w-0 flex-1 rounded-inset border border-edge bg-surface-inset px-2 py-1 text-xs text-fg"
        >
          {recordings.length === 0 ? (
            <option value="">No recordings</option>
          ) : (
            recordings.map((recording) => (
              <option key={recording.run_id} value={recording.run_id}>
                {recording.run_id}
              </option>
            ))
          )}
        </select>
        <button
          type="button"
          disabled={selected === ""}
          onClick={() => void load()}
          className="chip-transition rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          Play 10x
        </button>
      </div>
      {loadError !== null && (
        <p className="text-xs text-status-fail">
          {loadError} — the recording may have been removed. Pick another.
        </p>
      )}
      {run !== null && (
        <div className="space-y-3">
          <Timeline nodes={timeline} live={run.completed === undefined} />
          {exchanges.length > 0 && <ExchangeLog entries={exchanges} />}
        </div>
      )}
    </div>
  );
}

function replay(
  events: RunEvent[],
  store: ReturnType<typeof createEventStore>,
  clearReplay: () => void,
  timers: number[],
): void {
  clearReplay();
  store.reset();
  if (events.length === 0) return;
  const first = Date.parse(events[0]?.timestamp ?? "");
  for (const event of events) {
    const at = Date.parse(event.timestamp);
    const delay =
      Number.isNaN(first) || Number.isNaN(at)
        ? 0
        : Math.max(0, (at - first) / REPLAY_SPEED);
    const timer = window.setTimeout(() => {
      store.applyEvents([event]);
      if (event.type === "run.started") store.selectScenario(event.scenario_id);
    }, delay);
    timers.push(timer);
  }
}
