/**
 * Formatting helpers for anything time- or wire-shaped in the components.
 * Pure functions — kept beside the components so the state workspace never
 * needs to import them.
 */

/** `71_000` → `"1:11"` (design §6.2/§6.5 m:ss). Never negative. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Elapsed-since-previous timeline delta: `+m:ss` (design §6.2). */
export function formatDelta(ms: number): string {
  return `+${formatElapsed(ms)}`;
}

/** ISO timestamp → local wall-clock `hh:mm:ss`, muted right-aligned per §6.2. */
export function formatWallClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Backoff delay label: `1400` → `"1.4s"`, `2000` → `"2s"` (design §6.3). */
export function formatBackoff(ms: number): string {
  const seconds = ms / 1000;
  const rounded = Math.round(seconds * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}s`;
}
