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

export function ReplayPanel({ fetchFn }: { fetchFn?: FetchLike }) {
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loaded, setLoaded] = useState<RecordingSummary | null>(null);
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
        if (items[0] !== undefined) setSelected(items[0].run_id);
      })
      .catch(() => {
        if (!cancelled) setRecordings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchFn]);

  useEffect(() => clearReplay, [clearReplay]);

  const load = useCallback(async () => {
    const summary = recordings.find((item) => item.run_id === selected);
    if (summary === undefined) return;
    const events = await getRecordingEvents(summary.run_id, fetchFn);
    setLoaded(summary);
    replay(events, store, clearReplay, timers.current);
  }, [clearReplay, fetchFn, recordings, selected, store]);

  const run = selectedRun(state);
  const timeline = useMemo(
    () => (run === null ? [] : projectTimelineNodes(run)),
    [run],
  );
  const exchanges = useMemo(
    () => (run === null ? [] : projectExchanges(run)),
    [run],
  );

  return (
    <div className="space-y-3 border-t border-edge pt-4">
      <div className="flex items-center gap-2">
        <h3 className="pane-header flex-1">Replay</h3>
        {loaded !== null && !loaded.complete && (
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
