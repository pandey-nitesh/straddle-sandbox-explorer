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
}

export async function createHttpServer(
  options: CreateHttpServerOptions,
): Promise<FastifyInstance> {
  const bus = options.bus ?? createBus();
  const registry = options.registry ?? createRunRegistry(bus);
  const recordingDir = options.recordingDir ?? "runs";
  if (options.attachRecorder !== false) attachRecorder(bus, recordingDir);

  const app = fastify(
    options.logger === false
      ? { logger: false }
      : {
          loggerInstance: createLogger() as unknown as FastifyBaseLogger,
        },
  );
  const epoch = options.epoch ?? randomUUID();

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
