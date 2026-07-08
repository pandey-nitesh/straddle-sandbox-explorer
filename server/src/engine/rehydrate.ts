import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { RunEventSchema, type RunEvent } from "@sse/shared";

/**
 * Boot-time registry rehydration (spec §3, P2-R.1).
 *
 * The registry is in-memory, so a server restart would otherwise start blank —
 * reports, the recordings list, and the dashboard would forget every prior run
 * until new ones are recorded. This module reloads `runs/*.jsonl` at boot and
 * rebuilds the registry from that evidence.
 *
 * Two facts force a RENUMBER rather than a verbatim reload:
 *   1. `seq` is monotonic only WITHIN one process (spec §5). Every past server
 *      session restarted its counter at 1, so recordings from different
 *      sessions carry COLLIDING seq ranges — reloading them verbatim would put
 *      two distinct events at the same seq and corrupt `eventsSince`.
 *   2. After reload the live bus must keep issuing seq ABOVE the rehydrated
 *      high-water mark, or a client that hydrates from `/api/runs` (cursor =
 *      max seq seen) would compute a cursor above every fresh live event and
 *      never receive them.
 *
 * So we flatten every recording into one deterministic, time-ordered stream and
 * assign a fresh contiguous `seq` (1..N). The caller then starts the live bus
 * at `maxSeq + 1` (see `createBus({ startSeq })`), making seq monotonic across
 * the restart boundary. The on-disk files keep their original seq — replay
 * (spec §11) reads a single file's self-consistent sequence and never mixes it
 * with the live registry, so the divergence is invisible.
 *
 * Corrupt/truncated lines obey the valid-prefix rule (spec §11): within a file
 * we take every event up to the first unparseable line and stop; the rest of
 * that file is discarded and counted. A run whose `run.started` line is itself
 * corrupt contributes nothing.
 */

export interface RehydrateStats {
  /** JSONL files scanned. */
  files: number;
  /** Distinct runs recovered (files that yielded a `run.started`). */
  runs: number;
  /** Files cut short by an unparseable line (valid prefix kept). */
  truncatedFiles: number;
  /** Non-empty lines discarded across all files. */
  skippedLines: number;
}

export interface RehydrateResult {
  /** Historical events, renumbered to a contiguous 1..N and time-ordered. */
  events: RunEvent[];
  /** N — the highest assigned seq (0 when nothing was recovered). */
  maxSeq: number;
  stats: RehydrateStats;
}

const EMPTY: RehydrateResult = {
  events: [],
  maxSeq: 0,
  stats: { files: 0, runs: 0, truncatedFiles: 0, skippedLines: 0 },
};

interface LoadedEvent {
  event: RunEvent;
  /** Position within its source file — preserves per-run causal order. */
  fileIndex: number;
}

/**
 * Reads `dir`, parses every `*.jsonl` recording under the valid-prefix rule,
 * and returns the renumbered, time-ordered historical event stream plus stats.
 * A missing directory is not an error — it yields the empty result.
 */
export async function loadRecordedEvents(dir: string): Promise<RehydrateResult> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return EMPTY;
  }

  const files = entries.filter((entry) => entry.endsWith(".jsonl")).sort();
  const stats: RehydrateStats = {
    files: 0,
    runs: 0,
    truncatedFiles: 0,
    skippedLines: 0,
  };
  const loaded: LoadedEvent[] = [];

  for (const entry of files) {
    stats.files += 1;
    let contents: string;
    try {
      contents = await readFile(path.join(dir, entry), "utf8");
    } catch {
      // A file we can list but cannot read counts as fully skipped.
      continue;
    }
    const lines = contents.split(/\r?\n/).filter((line) => line.trim() !== "");
    let sawStart = false;
    let fileIndex = 0;
    for (const [i, raw] of lines.entries()) {
      let event: RunEvent;
      try {
        event = RunEventSchema.parse(JSON.parse(raw));
      } catch {
        // Valid-prefix rule: the first bad line ends this file; the remainder
        // (however much of it) is unusable and counted as skipped.
        stats.truncatedFiles += 1;
        stats.skippedLines += lines.length - i;
        break;
      }
      loaded.push({ event, fileIndex });
      fileIndex += 1;
      if (event.type === "run.started") sawStart = true;
    }
    if (sawStart) stats.runs += 1;
  }

  if (loaded.length === 0) return { ...EMPTY, stats };

  // Deterministic global order: by timestamp, then run_id, then in-file order.
  // The fileIndex tiebreak guarantees a run's own events never reorder even
  // when two of them share a timestamp.
  loaded.sort((a, b) => {
    if (a.event.timestamp !== b.event.timestamp) {
      return a.event.timestamp < b.event.timestamp ? -1 : 1;
    }
    if (a.event.run_id !== b.event.run_id) {
      return a.event.run_id < b.event.run_id ? -1 : 1;
    }
    return a.fileIndex - b.fileIndex;
  });

  const events = loaded.map((item, index) => ({ ...item.event, seq: index + 1 }));
  return { events, maxSeq: events.length, stats };
}
