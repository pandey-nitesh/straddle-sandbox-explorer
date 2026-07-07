/**
 * FakeClock — manual-advance implementation of the Clock interface
 * (server/src/straddle/types.ts) for deterministic tests and for driving the
 * mock Straddle client's scripted schedules (mock.ts) without wall time.
 *
 * Not a vitest-only detail: spec §7 names scripted mock schedules "on an
 * injectable clock" as a first-class Wave 1 deliverable, so this helper is a
 * regular module that Wave 2 (poller/runner tests) imports too.
 *
 * Semantics:
 * - `now()` returns fake epoch milliseconds; starts at `startMs` (default 0).
 * - `sleep(ms)` resolves only when `advance`/`advanceTo` moves time past its
 *   due point (ms <= 0 resolves immediately). Nothing resolves spontaneously.
 * - `advance(ms)` releases due sleepers in due-time order, setting `now()` to
 *   each sleeper's due time as it wakes so a woken continuation reads a
 *   consistent clock, and flushes microtasks between releases so chained
 *   sleeps scheduled by continuations within the window are honored in the
 *   same call.
 */
import type { Clock } from "./types.js";

type Waiter = { due: number; resolve: () => void };

export class FakeClock implements Clock {
  private nowMs: number;
  private waiters: Waiter[] = [];

  constructor(startMs = 0) {
    this.nowMs = startMs;
  }

  now(): number {
    return this.nowMs;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push({ due: this.nowMs + ms, resolve });
    });
  }

  /** Number of sleepers still waiting for time to pass (test introspection). */
  pendingSleepers(): number {
    return this.waiters.length;
  }

  /** Advances fake time by `ms`, releasing every sleep that falls due. */
  async advance(ms: number): Promise<void> {
    await this.advanceTo(this.nowMs + ms);
  }

  /** Advances fake time to the absolute fake-epoch instant `targetMs`. */
  async advanceTo(targetMs: number): Promise<void> {
    if (targetMs < this.nowMs) {
      throw new Error(
        `FakeClock cannot move backwards (now=${this.nowMs}, target=${targetMs})`,
      );
    }
    for (;;) {
      let next: Waiter | undefined;
      for (const w of this.waiters) {
        if (w.due <= targetMs && (next === undefined || w.due < next.due)) {
          next = w;
        }
      }
      if (next === undefined) break;
      this.waiters.splice(this.waiters.indexOf(next), 1);
      if (next.due > this.nowMs) this.nowMs = next.due;
      next.resolve();
      // Let the woken continuation run (and possibly schedule further sleeps
      // inside the window) before picking the next due waiter.
      await flushMicrotasks();
    }
    this.nowMs = targetMs;
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  // A macrotask boundary drains the entire microtask queue, including
  // promise chains created while draining.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
