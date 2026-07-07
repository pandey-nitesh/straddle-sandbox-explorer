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
    const value = await args.fetch();
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
