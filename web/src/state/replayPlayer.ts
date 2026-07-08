import type { RunEvent } from "@sse/shared";

/**
 * Replay playback controller (spec §11, P2-1.2).
 *
 * A framework-agnostic external store that owns the scrubber's playback state:
 * which prefix of a recording is currently applied (`index`), whether it is
 * playing, the speed, and the partial-recording marker. It is deliberately NOT
 * a React hook so it can be unit-tested deterministically with an injected
 * timer, and it never touches the event store directly — a {@link ReplaySink}
 * bridges to whatever store drives the panes.
 *
 * Determinism rules that make the scrubber safe:
 * - The store ALWAYS reflects exactly `events[0..index]`. Every index change —
 *   forward step, backward seek, reset — rebuilds through `sink.render` from
 *   that prefix, so scrubbing in either direction is consistent (spec §11:
 *   "plays each JSONL line through the same reducer used live").
 * - Playback schedules one step at a time via an injectable timer (default
 *   `window`), so pause/seek/speed changes cancel and re-arm cleanly and tests
 *   drive it with fake timers.
 * - Relative wire timing is preserved: the gap before revealing the next event
 *   is its real inter-event delta divided by `speed` (10× keeps spec §11's
 *   default cadence). Identical/unparseable timestamps step immediately.
 */

export const REPLAY_SPEEDS = [1, 5, 10] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
export const DEFAULT_REPLAY_SPEED: ReplaySpeed = 10;

export function isReplaySpeed(value: number): value is ReplaySpeed {
  return (REPLAY_SPEEDS as readonly number[]).includes(value);
}

/** Injectable timer; the default binds to `window` so fake timers intercept it. */
export interface ReplayTimer {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

const REAL_TIMER: ReplayTimer = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (handle) => window.clearTimeout(handle),
};

/** Bridge from the player to the event store that drives the panes. */
export interface ReplaySink {
  /** Rebuild the store to reflect exactly `events[0..index]`. */
  render(prefix: readonly RunEvent[]): void;
  /** Empty the store (full teardown). */
  clear(): void;
}

export interface ReplayPlayerState {
  /** The loaded recording's run id, or null when nothing is loaded. */
  runId: string | null;
  /** Events applied so far (0..total); the store reflects `events[0..index]`. */
  index: number;
  total: number;
  playing: boolean;
  speed: ReplaySpeed;
  /** Partial recording: a bad line cut it short (spec §11 valid-prefix rule). */
  truncated: boolean;
}

export interface ReplayPlayer {
  getState(): ReplayPlayerState;
  subscribe(listener: () => void): () => void;
  /** Load a recording paused at index 0 with an empty store. */
  load(runId: string, events: readonly RunEvent[], truncated: boolean): void;
  play(): void;
  pause(): void;
  seek(index: number): void;
  setSpeed(speed: ReplaySpeed): void;
  /** Restart the loaded recording: index 0, paused, store cleared, no timers. */
  reset(): void;
  /** Full teardown: forget the recording and empty the store. */
  clear(): void;
  /** Cancel any pending timer and drop listeners (component unmount). */
  dispose(): void;
}

export interface ReplayPlayerOptions {
  sink: ReplaySink;
  timer?: ReplayTimer;
  speed?: ReplaySpeed;
}

export function createReplayPlayer(options: ReplayPlayerOptions): ReplayPlayer {
  const sink = options.sink;
  const timer = options.timer ?? REAL_TIMER;
  const listeners = new Set<() => void>();

  let events: readonly RunEvent[] = [];
  let runId: string | null = null;
  let index = 0;
  let playing = false;
  let speed: ReplaySpeed = options.speed ?? DEFAULT_REPLAY_SPEED;
  let truncated = false;
  let handle: number | null = null;
  let snapshot: ReplayPlayerState = compute();

  function compute(): ReplayPlayerState {
    return { runId, index, total: events.length, playing, speed, truncated };
  }
  function emit(): void {
    snapshot = compute();
    for (const listener of [...listeners]) listener();
  }
  function cancelTimer(): void {
    if (handle !== null) {
      timer.clear(handle);
      handle = null;
    }
  }

  /** Delay before revealing `events[next]` at the current speed. */
  function delayFor(next: number): number {
    if (next <= 0) return 0;
    const prev = Date.parse(events[next - 1]?.timestamp ?? "");
    const cur = Date.parse(events[next]?.timestamp ?? "");
    if (Number.isNaN(prev) || Number.isNaN(cur)) return 0;
    return Math.max(0, (cur - prev) / speed);
  }

  function render(): void {
    sink.render(events.slice(0, index));
  }

  /** Arm the next playback step; re-armable after pause/seek/speed change. */
  function schedule(): void {
    cancelTimer();
    if (!playing) return;
    if (index >= events.length) {
      playing = false;
      emit();
      return;
    }
    handle = timer.set(() => {
      handle = null;
      index += 1;
      render();
      if (index >= events.length) {
        playing = false;
        emit();
        return;
      }
      emit();
      schedule();
    }, delayFor(index));
  }

  return {
    getState: () => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load(id, evts, isTruncated): void {
      cancelTimer();
      events = [...evts];
      runId = id;
      index = 0;
      playing = false;
      truncated = isTruncated;
      render(); // empty prefix — play reveals from 0
      emit();
    },
    play(): void {
      if (events.length === 0 || playing) return;
      if (index >= events.length) {
        // At the end: restart from the top so Play always replays.
        index = 0;
        render();
      }
      playing = true;
      emit();
      schedule();
    },
    pause(): void {
      cancelTimer();
      if (!playing) return;
      playing = false;
      emit();
    },
    seek(target): void {
      const clamped = Math.max(0, Math.min(events.length, Math.round(target)));
      cancelTimer();
      index = clamped;
      render();
      emit();
      if (playing) schedule(); // continue from the new position
    },
    setSpeed(next): void {
      if (speed === next) return;
      speed = next;
      emit();
      if (playing) schedule(); // re-time the pending step
    },
    reset(): void {
      cancelTimer();
      index = 0;
      playing = false;
      render(); // empty prefix; events/runId kept so Play restarts
      emit();
    },
    clear(): void {
      cancelTimer();
      events = [];
      runId = null;
      index = 0;
      playing = false;
      truncated = false;
      sink.clear();
      emit();
    },
    dispose(): void {
      cancelTimer();
      listeners.clear();
    },
  };
}
