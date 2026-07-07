/**
 * GET /api/health — the one inline fetch in the app (Stage 2 replaces this
 * with the typed api.ts client; keep the fetch isolated here so that swap is
 * a one-file change).
 *
 * Response shape per spec §9: { epoch, key: "ok"|"missing"|"invalid", error_body? }.
 * M0 (§18.5): the sandbox 401 has an empty body, so `error_body` is normally
 * absent for invalid keys.
 */
export interface HealthResponse {
  epoch: string;
  key: "ok" | "missing" | "invalid";
  error_body?: unknown;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/health");
  if (!response.ok) {
    throw new Error(`health check returned ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}
