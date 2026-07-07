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

/**
 * Subscribes a JSONL recorder to the bus. Creates `dir` (recursively) if
 * absent at attach time. Returns the unsubscribe function (detach).
 *
 * Recorder write failures (disk full, dir removed mid-run) throw from the
 * subscriber and are handled by the bus's subscriber-isolation policy — they
 * are reported via `onSubscriberError` and never break other subscribers.
 */
export function attachRecorder(bus: EventBus, dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  return bus.subscribe((event: RunEvent) => {
    appendFileSync(
      recordingPathFor(dir, event.run_id),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
  });
}
