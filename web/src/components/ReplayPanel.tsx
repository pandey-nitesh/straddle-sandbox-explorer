import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { RunEvent, RunStartedEvent } from "@sse/shared";
import {
  getRecordingEvents,
  getRecordings,
  type FetchLike,
  type RecordingSummary,
} from "../api";
import {
  createEventStore,
  type EventStore,
  selectedRun,
} from "../state/eventStore";
import {
  createReplayPlayer,
  isReplaySpeed,
  REPLAY_SPEEDS,
  type ReplaySink,
  type ReplayTimer,
} from "../state/replayPlayer";
import {
  projectExchanges,
  projectTimelineNodes,
} from "../state/projections";
import { ExchangeLog } from "./ExchangeLog";
import { Timeline } from "./Timeline";

export interface ReplayPanelProps {
  fetchFn?: FetchLike;
  /** Optional shared replay store. Dashboard passes one so playback renders
   *  in the main Lifecycle/Wire panes; standalone tests/components can keep
   *  the local preview store. */
  store?: EventStore;
  /** Bump to cancel an in-flight replay and clear the shared replay state. */
  resetToken?: number;
  /** The dashboard renders replay in the main panes, so it hides this local
   *  preview there while keeping the component useful standalone. */
  showPreview?: boolean;
  /** Learning-layer toggle — threaded from the header so replay annotates
   *  exactly like live runs (spec §19). */
  explain?: boolean;
  /** Bump to refetch the recordings list (e.g. when a run completes), so
   *  recordings made during the session appear without a page reload. */
  refreshToken?: number;
  /** Injectable playback timer (default `window`); tests pass a controllable
   *  one or drive the default with fake timers. */
  timer?: ReplayTimer;
}

export function ReplayPanel({
  fetchFn,
  store: externalStore,
  resetToken = 0,
  showPreview = true,
  explain = false,
  refreshToken = 0,
  timer,
}: ReplayPanelProps) {
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loadedComplete, setLoadedComplete] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ownedStore] = useState(() => createEventStore());
  const store = externalStore ?? ownedStore;

  // The player owns playback state and drives the store through a sink; it
  // never sees React. `store` is stable for this component's life (Dashboard's
  // replayStore / the owned store), so capturing it in the initializer is safe.
  const [player] = useState(() => {
    const sink: ReplaySink = {
      render(prefix) {
        store.reset();
        if (prefix.length > 0) store.applyEvents(prefix as RunEvent[]);
        const started = prefix.find(
          (e): e is RunStartedEvent => e.type === "run.started",
        );
        if (started !== undefined) store.selectScenario(started.scenario_id);
      },
      clear() {
        store.reset();
      },
    };
    return createReplayPlayer({ sink, ...(timer !== undefined ? { timer } : {}) });
  });
  const playback = useSyncExternalStore(player.subscribe, player.getState);
  const state = useSyncExternalStore(store.subscribe, store.getState);

  useEffect(() => () => player.dispose(), [player]);

  useEffect(() => {
    let cancelled = false;
    void getRecordings(fetchFn)
      .then((items) => {
        if (cancelled) return;
        setRecordings(items);
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

  // Dashboard bumps resetToken when a live run takes the panes: tear the replay
  // down fully so the live run shows (also runs harmlessly on mount).
  useEffect(() => {
    player.clear();
    setLoadedComplete(null);
  }, [player, resetToken]);

  const loadThenPlay = useCallback(async () => {
    const summary = recordings.find((item) => item.run_id === selected);
    if (summary === undefined) return;
    try {
      const recording = await getRecordingEvents(summary.run_id, fetchFn);
      setLoadError(null);
      setLoadedComplete(summary.complete);
      player.load(summary.run_id, recording.events, recording.truncated);
      player.play();
    } catch {
      setLoadError(`could not load ${summary.run_id}`);
    }
  }, [fetchFn, player, recordings, selected]);

  const onToggle = useCallback(() => {
    if (playback.playing) {
      player.pause();
      return;
    }
    // Resume the loaded recording, or (re)load a freshly selected one.
    if (playback.runId === selected && playback.total > 0) player.play();
    else void loadThenPlay();
  }, [loadThenPlay, playback.playing, playback.runId, playback.total, player, selected]);

  const isPartial =
    playback.runId !== null && (loadedComplete === false || playback.truncated);

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
        {/* Always-on marker: replay is recorded evidence, never a live run. */}
        <span className="wire-quote rounded-chip border border-accent px-2 py-0.5 text-xs text-accent">
          recorded
        </span>
        {isPartial && (
          <span className="rounded-chip border border-status-provisional px-2 py-0.5 text-xs text-status-provisional">
            partial
          </span>
        )}
      </div>

      <select
        aria-label="Recording"
        value={selected}
        onChange={(event) => setSelected(event.target.value)}
        className="wire-quote w-full min-w-0 rounded-inset border border-edge bg-surface-inset px-2 py-1 text-xs text-fg"
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

      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={playback.playing ? "Pause" : "Play"}
          disabled={selected === ""}
          onClick={onToggle}
          className="chip-transition rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          {playback.playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          aria-label="Reset replay"
          disabled={playback.runId === null}
          onClick={() => player.reset()}
          className="chip-transition rounded-lg border border-edge px-3 py-1 text-xs font-medium text-fg-muted hover:border-edge-strong disabled:opacity-50"
        >
          Reset
        </button>
        <select
          aria-label="Speed"
          value={playback.speed}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (isReplaySpeed(next)) player.setSpeed(next);
          }}
          className="wire-quote rounded-inset border border-edge bg-surface-inset px-2 py-1 text-xs text-fg"
        >
          {REPLAY_SPEEDS.map((option) => (
            <option key={option} value={option}>
              {option}×
            </option>
          ))}
        </select>
        <span className="flex-1" />
        {playback.total > 0 && (
          <span className="wire-quote shrink-0 text-xs text-fg-muted">
            {`event ${playback.index} / ${playback.total}`}
          </span>
        )}
      </div>

      {playback.total > 0 && (
        <input
          type="range"
          aria-label="Seek"
          min={0}
          max={playback.total}
          step={1}
          value={playback.index}
          onChange={(event) => player.seek(Number(event.target.value))}
          className="w-full accent-accent"
        />
      )}

      {loadError !== null && (
        <p className="text-xs text-status-fail">
          {loadError} — the recording may have been removed. Pick another.
        </p>
      )}

      {showPreview && run !== null && (
        <div className="space-y-3">
          <Timeline nodes={timeline} live={run.completed === undefined} />
          {exchanges.length > 0 && <ExchangeLog entries={exchanges} />}
        </div>
      )}
    </div>
  );
}
