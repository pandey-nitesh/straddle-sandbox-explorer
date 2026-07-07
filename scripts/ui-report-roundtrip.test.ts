import { afterAll, describe, expect, it } from "vitest";
import { ReportSchema } from "@sse/shared";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../server/src/config.js";
import { createBus } from "../server/src/engine/bus.js";
import { createRunRegistry } from "../server/src/engine/registry.js";
import { buildReport } from "../server/src/engine/report.js";
import { createHttpServer } from "../server/src/http/server.js";
import type { Clock } from "../server/src/straddle/types.js";
import { getReport, getRuns, postRuns, type FetchLike } from "../web/src/api.js";
import { SUITE_SCENARIOS } from "../web/src/state/eventStore.js";

/**
 * UI export round-trip (spec §12): the report blob the UI downloads
 * (GET /api/report through web/src/api.ts, serialized exactly as the
 * Dashboard's download handler serializes it) must parse via ReportSchema and
 * deep-equal the server engine's buildReport output over the same events.
 *
 * Runs against a real createHttpServer instance in mock mode with an
 * auto-advancing clock — no sandbox, no wall-clock waits (the same falsifiable
 * form as the Wave 3 CLI/HTTP round-trip, extended to the UI path).
 */

/** Auto-advancing fake clock: every sleep lands instantly, time still moves. */
function createAutoClock(startMs: number): Clock {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

/** web/src/api.ts FetchLike over fastify's inject — no sockets involved. */
function injectFetch(app: FastifyInstance): FetchLike {
  return async (input, init) => {
    const response = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST",
      url: input,
      ...(init?.body !== undefined
        ? {
            payload: String(init.body),
            headers: { "content-type": "application/json" },
          }
        : {}),
    });
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      text: async () => response.body,
    } as unknown as Response;
  };
}

let app: FastifyInstance | undefined;

afterAll(async () => {
  await app?.close();
});

describe("UI export round-trip", () => {
  it("UI-path report parses and deep-equals the engine's buildReport", async () => {
    const bus = createBus();
    const registry = createRunRegistry(bus);
    const clock = createAutoClock(Date.parse("2026-07-07T12:00:00.000Z"));
    app = await createHttpServer({
      config: loadConfig({ env: {}, envFilePath: false }),
      bus,
      registry,
      mockMode: true,
      clock,
      recordingDir: "runs",
      attachRecorder: false, // no files; recording paths still derive
      serveStatic: false,
      logger: false,
    });
    const fetchFn = injectFetch(app);

    // Kick off the full suite through the same POST the Run all button uses.
    const { run_ids } = await postRuns(SUITE_SCENARIOS, fetchFn);
    expect(run_ids.length).toBe(5);

    // The auto-clock collapses the mock schedules; wait for all completions.
    await waitUntil(async () => {
      const snapshot = await getRuns(fetchFn);
      return (
        snapshot.runs.length === 5 &&
        snapshot.runs.every((run) => run.status !== "running")
      );
    });

    // UI path: GET /api/report → the exact bytes the download blob contains.
    const uiReport = await getReport(fetchFn);
    const blobText = `${JSON.stringify(uiReport, null, 2)}\n`;
    const parsed = ReportSchema.parse(JSON.parse(blobText));

    // Engine path over the same events (same generated_at: the route stamps
    // its own timestamp, which is not part of the evidence being compared).
    const engineReport = ReportSchema.parse(
      buildReport(registry.allEvents(), {
        recordingDir: "runs",
        generatedAt: parsed.generated_at,
      }),
    );

    expect(parsed).toEqual(engineReport);

    // Mock-mode suite semantics sanity: all five covered and passed.
    expect(parsed.suite.covered_scenarios).toEqual(["a", "b", "c", "d", "e"]);
    expect(parsed.suite.status).toBe("passed");
  });
});

async function waitUntil(
  condition: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}
