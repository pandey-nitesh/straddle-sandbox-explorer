import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { RunEventSchema } from "@sse/shared";
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

interface RecordingSummary {
  run_id: string;
  path: string;
  complete: boolean;
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
          // Spec §9/§18.5: error_body carries Straddle's VERBATIM
          // credential-redacted error body and is absent when the 401 had no
          // body — never our own synthesized message (Wave 4 QA fix: it
          // previously sent health.message, which made the UI render our
          // prose as if it were Straddle's response).
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

  app.get("/api/recordings", async () => listRecordings(options.recordingDir));

  app.get<{ Params: { run_id: string } }>(
    "/api/recordings/:run_id",
    async (request, reply) => {
      const runId = request.params.run_id;
      if (!isSafeRunId(runId)) {
        return reply.code(400).send({ error: "invalid run_id" });
      }
      const file = path.join(options.recordingDir, `${runId}.jsonl`);
      try {
        await stat(file);
      } catch {
        return reply.code(404).send({ error: "recording not found" });
      }
      return reply.type("application/x-ndjson").send(createReadStream(file));
    },
  );

  app.get<{ Querystring: { since?: string; once?: string } }>(
    "/api/events/stream",
    async (request, reply) => {
      const rawSince = request.query.since ?? "0";
      if (!/^\d+$/.test(rawSince)) {
        return reply.code(400).send({ error: "since must be a non-negative integer" });
      }
      const since = Number.parseInt(rawSince, 10);
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      writeSse(reply.raw, "epoch", { epoch: options.epoch });
      for (const event of options.registry.eventsSince(since)) {
        writeSse(reply.raw, "run-event", event);
      }
      if (request.query.once === "1") {
        reply.raw.end();
        return;
      }
      const unsubscribe = options.bus.subscribe((event) => {
        writeSse(reply.raw, "run-event", event);
      });
      request.raw.on("close", () => {
        unsubscribe();
      });
    },
  );
}

async function listRecordings(recordingDir: string): Promise<RecordingSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(recordingDir);
  } catch {
    return [];
  }
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".jsonl"))
      .map(async (entry): Promise<RecordingSummary | null> => {
        const runId = entry.slice(0, -".jsonl".length);
        if (!isSafeRunId(runId)) return null;
        const file = path.join(recordingDir, entry);
        const contents = await readFile(file, "utf8");
        const complete = contents
          .split(/\r?\n/)
          .filter((line) => line.trim() !== "")
          .some((line) => {
            try {
              return RunEventSchema.parse(JSON.parse(line)).type === "run.completed";
            } catch {
              return false;
            }
          });
        return { run_id: runId, path: file, complete };
      }),
  );
  return summaries
    .filter((summary): summary is RecordingSummary => summary !== null)
    .sort((a, b) => a.run_id.localeCompare(b.run_id));
}

function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(runId);
}

function writeSse(raw: NodeJS.WritableStream, event: string, data: unknown): void {
  raw.write(`event: ${event}\n`);
  raw.write(`data: ${JSON.stringify(data)}\n\n`);
}
