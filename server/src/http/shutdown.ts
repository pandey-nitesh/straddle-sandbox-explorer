import type { FastifyInstance } from "fastify";

/**
 * Graceful server shutdown (P2-R.2).
 *
 * On SIGINT/SIGTERM the server stops accepting work and drains open
 * connections via `app.close()` (Fastify quiesces its request lifecycle),
 * then exits. A hard timeout backstops a wedged connection so shutdown can
 * never hang forever.
 *
 * In-flight runs are abandoned DELIBERATELY: their recordings are valid
 * prefixes (spec §11) and reappear as `partial` on the next boot rehydration
 * (P2-R.1). We never fabricate a `run.completed` for work the process didn't
 * actually finish (spec §5).
 */

export interface ShutdownDeps {
  /** Drain and close the server (e.g. `() => app.close()`). */
  close: () => Promise<void>;
  /** Terminate the process; injectable so the handler is testable. */
  exit: (code: number) => void;
  /** Optional structured log sink. */
  log?: (message: string) => void;
  /** Force-exit budget for a stuck drain (default 10s). */
  timeoutMs?: number;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Builds an idempotent signal handler: the first signal starts the drain, and
 * any further signals during shutdown are ignored (a second Ctrl-C shouldn't
 * race the exit). Exits 0 on a clean drain, 1 on drain error or timeout.
 */
export function createShutdownHandler(
  deps: ShutdownDeps,
): (signal: string) => void {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  let closing = false;
  return (signal: string): void => {
    if (closing) return;
    closing = true;
    deps.log?.(`shutting down (${signal})`);
    const timer = setTimeout(() => deps.exit(1), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    deps.close().then(
      () => {
        clearTimeout(timer);
        deps.exit(0);
      },
      () => {
        clearTimeout(timer);
        deps.exit(1);
      },
    );
  };
}

/** Wires {@link createShutdownHandler} to the process's SIGINT/SIGTERM. */
export function installGracefulShutdown(
  app: FastifyInstance,
  timeoutMs?: number,
): void {
  const handler = createShutdownHandler({
    close: () => app.close(),
    exit: (code) => process.exit(code),
    log: (message) => app.log.info(message),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  process.once("SIGINT", () => handler("SIGINT"));
  process.once("SIGTERM", () => handler("SIGTERM"));
}
