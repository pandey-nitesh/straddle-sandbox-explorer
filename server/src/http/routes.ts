import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { createBus, type EventBus } from "../engine/bus.js";
import type { RunRegistry } from "../engine/registry.js";
import { runScenarios, type RunContext } from "../engine/runner.js";
import { parseScenarioSelection } from "../engine/scenarios.js";
import { createMockStraddleClient } from "../straddle/mock.js";
import { createStraddleClient } from "../straddle/client.js";
import type { Clock, StraddleClient } from "../straddle/types.js";

export interface RegisterRoutesOptions {
  epoch: string;
  config: Config;
  bus: EventBus;
  registry: RunRegistry;
  clock?: Clock;
  recordingDir: string;
  mockMode?: boolean;
  clientFactory?: (context: RunContext) => StraddleClient;
}

interface RunsPostBody {
  scenarios?: string[];
}

export async function registerRoutes(
  app: FastifyInstance,
  options: RegisterRoutesOptions,
): Promise<void> {
  app.get("/api/health", async () => {
    if (options.mockMode === true) {
      return { epoch: options.epoch, key: "ok" };
    }
    if (!options.config.keyPresent) {
      return { epoch: options.epoch, key: "missing" };
    }
    const healthBus = createBus();
    const client = createStraddleClient({
      apiKey: options.config.straddleApiKey ?? "",
      bus: healthBus,
      clock: options.clock,
      context: {
        run_id: "health",
        scenario_id: "a",
      },
    });
    const health = await client.health();
    return health.ok
      ? { epoch: options.epoch, key: "ok" }
      : {
          epoch: options.epoch,
          key: "invalid",
          // Spec §9/§18.5: error_body carries Straddle's VERBATIM (redacted)
          // error body and is absent when the 401 had no body — never our own
          // synthesized message (Wave 4 QA fix: it previously sent
          // health.message, which made the UI render our prose as if it were
          // Straddle's response).
          ...(health.error_body !== undefined
            ? { error_body: health.error_body }
            : {}),
        };
  });

  app.post<{ Body: RunsPostBody }>("/api/runs", async (request, reply) => {
    if (options.mockMode !== true && !options.config.keyPresent) {
      return reply.code(400).send({
        error: "STRADDLE_API_KEY is missing",
      });
    }
    let scenarioIds;
    try {
      scenarioIds = parseScenarioSelection({
        scenarios: request.body?.scenarios,
      });
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let createdRunIds: string[] = [];
    void runScenarios({
      scenarios: scenarioIds,
      concurrency: "concurrent",
      bus: options.bus,
      clock: options.clock,
      recordingDir: options.recordingDir,
      pollPolicy: options.config.pollPolicyOverrides,
      mode: options.mockMode === true ? "contract" : "live",
      onRunIds: (runIds) => {
        createdRunIds = runIds;
      },
      clientFactory:
        options.clientFactory ??
        ((context) =>
          options.mockMode === true
            ? createMockStraddleClient({
                bus: options.bus,
                clock: context.clock,
                context: {
                  run_id: context.run_id,
                  scenario_id: context.scenario_id,
                },
              })
            : createStraddleClient({
                apiKey: options.config.straddleApiKey ?? "",
                bus: options.bus,
                clock: context.clock,
                context: {
                  run_id: context.run_id,
                  scenario_id: context.scenario_id,
                },
              })),
    });

    return reply.code(202).send({ run_ids: createdRunIds });
  });

  app.get("/api/runs", async () => options.registry.snapshot());

  app.get<{ Querystring: { since?: string } }>("/api/events", async (request, reply) => {
    const rawSince = request.query.since ?? "0";
    if (!/^\d+$/.test(rawSince)) {
      return reply.code(400).send({ error: "since must be a non-negative integer" });
    }
    const since = Number.parseInt(rawSince, 10);
    return {
      epoch: options.epoch,
      events: options.registry.eventsSince(since),
    };
  });

  app.get("/api/report", async () =>
    options.registry.report({
      recordingDir: options.recordingDir,
    }),
  );

  app.get("/api/recordings", async () => []);

  app.get("/api/recordings/:run_id", async (_request, reply) =>
    reply.code(501).send({ error: "recording playback lands in Wave 5" }),
  );
}
