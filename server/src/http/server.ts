import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";
import fastifyStatic from "@fastify/static";
import type { Config } from "../config.js";
import { createBus, type EventBus } from "../engine/bus.js";
import { attachRecorder } from "../engine/recorder.js";
import { loadRecordedEvents } from "../engine/rehydrate.js";
import { createRunRegistry, type RunRegistry } from "../engine/registry.js";
import { createLogger } from "../logger.js";
import { registerRoutes, type RegisterRoutesOptions } from "./routes.js";

export interface CreateHttpServerOptions {
  config: Config;
  epoch?: string;
  bus?: EventBus;
  registry?: RunRegistry;
  recordingDir?: string;
  mockMode?: boolean;
  clock?: RegisterRoutesOptions["clock"];
  clientFactory?: RegisterRoutesOptions["clientFactory"];
  attachRecorder?: boolean;
  serveStatic?: boolean;
  logger?: boolean;
  /**
   * Rebuild the registry from `runs/*.jsonl` at boot (spec §3, P2-R.1). On by
   * default; only applies when this server owns its wiring (no `bus`/`registry`
   * injected), since rehydration must set the bus's starting seq. Callers that
   * inject a bus own their own hydration.
   */
  rehydrate?: boolean;
}

export async function createHttpServer(
  options: CreateHttpServerOptions,
): Promise<FastifyInstance> {
  const recordingDir = options.recordingDir ?? "runs";

  // Rehydrate BEFORE the bus exists so the live bus can continue seq above the
  // recovered high-water mark. Only when this server owns its wiring — an
  // injected bus has its own seq counter we cannot retune.
  const ownsWiring = options.bus === undefined && options.registry === undefined;
  const shouldRehydrate = ownsWiring && options.rehydrate !== false;
  const history = shouldRehydrate
    ? await loadRecordedEvents(recordingDir)
    : { events: [], maxSeq: 0, stats: { files: 0, runs: 0, truncatedFiles: 0, skippedLines: 0 } };

  const bus = options.bus ?? createBus({ startSeq: history.maxSeq + 1 });
  const registry = options.registry ?? createRunRegistry(bus);
  if (history.events.length > 0) registry.hydrate(history.events);
  if (options.attachRecorder !== false) attachRecorder(bus, recordingDir);

  const app = fastify(
    options.logger === false
      ? { logger: false }
      : {
          loggerInstance: createLogger() as unknown as FastifyBaseLogger,
        },
  );
  const epoch = options.epoch ?? randomUUID();

  if (history.stats.runs > 0 || history.stats.truncatedFiles > 0) {
    app.log.info(
      {
        rehydrated_runs: history.stats.runs,
        rehydrated_files: history.stats.files,
        truncated_files: history.stats.truncatedFiles,
        skipped_lines: history.stats.skippedLines,
        max_seq: history.maxSeq,
      },
      "registry rehydrated from recordings",
    );
  }

  await registerRoutes(app, {
    epoch,
    config: options.config,
    bus,
    registry,
    recordingDir,
    mockMode: options.mockMode,
    clock: options.clock,
    clientFactory: options.clientFactory,
  });

  if (options.serveStatic !== false) {
    const dist = path.resolve(process.cwd(), "web", "dist");
    if (existsSync(dist)) {
      await app.register(fastifyStatic, {
        root: dist,
        prefix: "/",
      });
      app.setNotFoundHandler((_request, reply) => {
        reply.sendFile("index.html");
      });
    }
  }

  return app;
}
