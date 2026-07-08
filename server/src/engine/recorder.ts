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

export interface RecorderWriteFailure {
  /** The run whose event could not be written. */
  runId: string;
  /** The underlying error from the final failed write attempt. */
  error: unknown;
  /** True when a retry (after recreating the directory) succeeded. */
  recovered: boolean;
}

export interface RecorderOptions {
  /**
   * Notified on every write failure (P2-R.3), recovered or not. Default logs a
   * warning to stderr. Deliberately NOT emitted onto the bus: a broken disk
   * can't record the diagnostic event either, and re-emitting would recurse
   * through this same subscriber. The incomplete file self-classifies as
   * `partial` on the next boot rehydration (P2-R.1) instead.
   */
  onWriteError?: (failure: RecorderWriteFailure) => void;
  /**
   * Append one line to a file (injectable for fault-injection tests). Default
   * is a single synchronous, atomic `appendFileSync` — no user-space buffer, so
   * a crash between events leaves a valid prefix (spec §11).
   */
  appendLine?: (file: string, line: string) => void;
  /** Ensure `dir` exists (injectable). Default `mkdirSync(dir, recursive)`. */
  ensureDir?: (dir: string) => void;
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
   * incidentally.
   */
  flush(): Promise<void>;
  /**
   * Runs whose recording suffered an unrecoverable write failure (P2-R.3) and
   * is therefore incomplete/unreliable. Empty on the happy path.
   */
  failedRuns(): Set<string>;
}

function defaultOnWriteError(failure: RecorderWriteFailure): void {
  const detail =
    failure.error instanceof Error ? failure.error.message : String(failure.error);
  // eslint-disable-next-line no-console
  console.error(
    failure.recovered
      ? `recorder: recovered a write failure for ${failure.runId} (${detail})`
      : `recorder: UNRECOVERABLE write failure for ${failure.runId}; recording is incomplete (${detail})`,
  );
}

/**
 * Subscribes a JSONL recorder to the bus and returns a handle
 * (detach + flush + failedRuns). Creates `dir` (recursively) if absent.
 *
 * Fault tolerance (P2-R.3): a failed append first triggers a single recovery
 * attempt — recreate the directory (it may have been removed mid-run) and retry
 * — because a transient disk/dir blip must not kill a 10-minute run. If that
 * also fails the recorder NEVER throws (the process survives, other bus
 * subscribers are unaffected), marks the run's recording unreliable, and routes
 * the failure to `onWriteError`. Atomicity of the append still guarantees no
 * partial line is ever written (spec §11).
 */
export function createRecorder(
  bus: EventBus,
  dir: string,
  options: RecorderOptions = {},
): RecorderHandle {
  const appendLine =
    options.appendLine ?? ((file, line) => appendFileSync(file, line, "utf8"));
  const ensureDir = options.ensureDir ?? ((d) => mkdirSync(d, { recursive: true }));
  const onWriteError = options.onWriteError ?? defaultOnWriteError;
  const failedRuns = new Set<string>();

  ensureDir(dir);

  const detach = bus.subscribe((event: RunEvent) => {
    const file = recordingPathFor(dir, event.run_id);
    const line = `${JSON.stringify(event)}\n`;
    try {
      appendLine(file, line);
    } catch (firstError) {
      try {
        ensureDir(dir); // recover the common case: the directory was removed
        appendLine(file, line);
        onWriteError({ runId: event.run_id, error: firstError, recovered: true });
      } catch (secondError) {
        failedRuns.add(event.run_id);
        onWriteError({ runId: event.run_id, error: secondError, recovered: false });
      }
    }
  });

  return {
    detach,
    flush: () => Promise.resolve(),
    failedRuns: () => new Set(failedRuns),
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
