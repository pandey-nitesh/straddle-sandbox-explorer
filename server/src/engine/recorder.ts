import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { RunEvent } from "@sse/shared";
import type { EventBus } from "./bus.js";

/**
 * JSONL recorder (spec §11) — a bus SUBSCRIBER, wired as
 * `attachRecorder(bus, dir)` next to registry and logger. It never sits on
 * the runner as a parameter (spec §6).
 *
 * One file per run at `<dir>/<run_id>.jsonl`; one line per event, appended
 * and durably handed off per event; every line independently parseable;
 * a `run.completed` line marks clean completion; a file without one is a
 * valid prefix (an interrupted run). No rotation or cleanup at P0.
 *
 * Write mechanism: `fs.appendFileSync` per event, with the full line
 * (`JSON.stringify(event) + "\n"`) passed as a single buffer to a single
 * O_APPEND write. Why partial lines cannot occur:
 *   - The call is synchronous — it returns only after the kernel has accepted
 *     the whole buffer, so a process kill between events never lands mid-line
 *     (the "kill mid-run" case the spec cares about leaves a valid prefix).
 *   - There is no user-space buffering to flush or leave dangling — unlike a
 *     write stream, there is no queued chunk that dies with the process.
 *   - O_APPEND makes each write atomic with respect to the file offset, so
 *     even a second accidental writer could not interleave inside a line.
 * The remaining hole (power loss before the kernel flushes its page cache)
 * would need fsync-per-line; the spec's failure model is process death, not
 * power failure, so we do not pay that cost.
 */

/** run_ids become file names; allow only path-safe characters (no separators). */
const SAFE_RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

/** The recording path for a run — also what `run.completed` should carry. */
export function recordingPathFor(dir: string, runId: string): string {
  if (!SAFE_RUN_ID_RE.test(runId)) {
    throw new Error(
      `recorder: run_id ${JSON.stringify(runId)} is not a safe file name`,
    );
  }
  return path.join(dir, `${runId}.jsonl`);
}

export interface RecorderHandle {
  /** Unsubscribe from the bus — no writes after this returns. */
  detach(): void;
  /**
   * Resolve once every event emitted so far is durably on disk (P2-R.2
   * shutdown seam). With the synchronous `appendFileSync` writer this holds the
   * instant an `emit` returns, so `flush` resolves immediately — its value is
   * making the guarantee EXPLICIT: a graceful shutdown awaits it before writing
   * a final report and exiting, rather than relying on the invariant
   * incidentally. (P2-R.3 extends the recorder with failure handling behind
   * this same handle.)
   */
  flush(): Promise<void>;
}

/**
 * Subscribes a JSONL recorder to the bus and returns a handle (detach + flush).
 * Creates `dir` (recursively) if absent at attach time.
 *
 * Recorder write failures (disk full, dir removed mid-run) throw from the
 * subscriber and are handled by the bus's subscriber-isolation policy — they
 * are reported via `onSubscriberError` and never break other subscribers.
 */
export function createRecorder(bus: EventBus, dir: string): RecorderHandle {
  mkdirSync(dir, { recursive: true });
  const detach = bus.subscribe((event: RunEvent) => {
    appendFileSync(
      recordingPathFor(dir, event.run_id),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
  });
  return {
    detach,
    flush: () => Promise.resolve(),
  };
}

/**
 * Back-compatible wrapper: subscribes a recorder and returns just the
 * unsubscribe function, as before. New callers that need `flush` (graceful
 * shutdown) use {@link createRecorder} for the full handle.
 */
export function attachRecorder(bus: EventBus, dir: string): () => void {
  return createRecorder(bus, dir).detach;
}
