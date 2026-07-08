/**
 * Server-Sent Events framing + resume helpers (P2-R.4).
 *
 * Pulled out of routes.ts so the fiddly, correctness-critical bits (the resume
 * point, the wire framing) are unit-testable without a live socket.
 */

/** Default heartbeat cadence — comments keep proxies from reaping an idle stream. */
export const SSE_HEARTBEAT_MS = 15_000;

/**
 * A comment line (`: ...`). Carries no event; its only job is to push bytes so
 * an idle connection stays open and a dead one surfaces as a write/connection
 * error the client can react to.
 */
export function sseComment(text: string): string {
  return `: ${text}\n\n`;
}

/**
 * One SSE frame. When `id` is provided it is emitted as the `id:` field, which
 * the browser echoes back as the `Last-Event-ID` header on automatic
 * reconnect — that is how a native EventSource resumes exactly where it left
 * off (see {@link resolveResumePoint}).
 */
export function sseFrame(event: string, data: unknown, id?: number): string {
  const idLine = id === undefined ? "" : `id: ${id}\n`;
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Where a (re)connecting client should resume from. The standard
 * `Last-Event-ID` header — sent automatically by a native EventSource on
 * reconnect — is authoritative and wins over the explicit `?since=` query
 * (used on the first manual connect). Either being absent/malformed falls back
 * to 0 (full backfill).
 */
export function resolveResumePoint(
  querySince: string | undefined,
  lastEventId: string | undefined,
): number {
  return parseSeq(lastEventId) ?? parseSeq(querySince) ?? 0;
}

function parseSeq(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  return Number.parseInt(value, 10);
}
