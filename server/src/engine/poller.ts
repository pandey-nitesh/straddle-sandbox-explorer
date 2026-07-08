import type { Clock } from "../straddle/types.js";

export interface PollPolicy {
  baseMinMs: number;
  baseMaxMs: number;
  fastMs: number;
  hardTimeoutMs: number;
}

export const DEFAULT_POLL_POLICY: PollPolicy = {
  baseMinMs: 15_000,
  baseMaxMs: 30_000,
  fastMs: 5_000,
  hardTimeoutMs: 600_000,
};

export class PollTimeoutError extends Error {
  readonly elapsedMs: number;
  readonly lastStatus?: string;

  constructor(args: { elapsedMs: number; lastStatus?: string }) {
    super(
      args.lastStatus === undefined
        ? `hard timeout after ${args.elapsedMs}ms`
        : `hard timeout after ${args.elapsedMs}ms in status ${args.lastStatus}`,
    );
    this.name = "PollTimeoutError";
    this.elapsedMs = args.elapsedMs;
    if (args.lastStatus !== undefined) this.lastStatus = args.lastStatus;
  }
}

export class RateFloorScheduler {
  private nextAllowedAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly clock: Clock,
    private readonly minGapMs = 250,
  ) {}

  waitTurn(): Promise<void> {
    const run = this.queue.then(async () => {
      const delay = Math.max(0, this.nextAllowedAt - this.clock.now());
      if (delay > 0) await this.clock.sleep(delay);
      this.nextAllowedAt = this.clock.now() + this.minGapMs;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** What the poller does with an error thrown by `fetch` (P2-R.3). */
export type FetchErrorDecision = "retry" | "fail";

export interface PollArgs<T> {
  fetch: () => Promise<T>;
  isSettled: (value: T, observations: T[]) => boolean;
  switchToFast?: (value: T) => boolean;
  policy?: Partial<PollPolicy>;
  clock: Clock;
  scheduler?: RateFloorScheduler;
  onObservation: (value: T) => Promise<void> | void;
  statusOf?: (value: T) => string | undefined;
  random?: () => number;
  /**
   * Classify an error thrown by `fetch` (P2-R.3). "retry" treats it as a
   * MISSED observation — the loop keeps polling (still bounded by the hard
   * timeout), so a transient sandbox blip can't kill a long run. "fail"
   * rethrows immediately. Absent → "fail" (the pre-P2-R.3 behavior: any fetch
   * error aborts the poll). The poller stays generic over `T`; the caller owns
   * the retryable-vs-terminal decision and any diagnostic it wants to emit.
   */
  onFetchError?: (
    error: unknown,
    context: { elapsedMs: number; nextDelayMs: number },
  ) => FetchErrorDecision;
}

export async function poll<T>(args: PollArgs<T>): Promise<T> {
  const policy = { ...DEFAULT_POLL_POLICY, ...args.policy };
  const random = args.random ?? Math.random;
  const observations: T[] = [];
  const start = args.clock.now();
  let fastLatched = false;
  let last: T | undefined;

  for (;;) {
    const elapsedBeforeSleep = args.clock.now() - start;
    if (elapsedBeforeSleep >= policy.hardTimeoutMs) {
      throw new PollTimeoutError({
        elapsedMs: elapsedBeforeSleep,
        lastStatus: last === undefined ? undefined : args.statusOf?.(last),
      });
    }

    const delay = fastLatched
      ? policy.fastMs
      : jitter(policy.baseMinMs, policy.baseMaxMs, random);
    await args.clock.sleep(Math.min(delay, policy.hardTimeoutMs - elapsedBeforeSleep));

    if (args.scheduler !== undefined) await args.scheduler.waitTurn();

    let value: T;
    try {
      value = await args.fetch();
    } catch (error) {
      const decision =
        args.onFetchError?.(error, {
          elapsedMs: args.clock.now() - start,
          nextDelayMs: fastLatched ? policy.fastMs : policy.baseMinMs,
        }) ?? "fail";
      if (decision === "fail") throw error;
      // Missed observation: skip this cycle and keep polling. The loop-top
      // hard-timeout check still bounds the total wait, so a transient outage
      // delays the run and eventually fails at the timeout rather than dying
      // on the first blip.
      continue;
    }
    last = value;
    observations.push(value);
    await args.onObservation(value);

    if (args.switchToFast?.(value) === true) fastLatched = true;
    if (args.isSettled(value, observations)) return value;
  }
}

function jitter(min: number, max: number, random: () => number): number {
  if (max <= min) return min;
  return Math.floor(min + random() * (max - min));
}
