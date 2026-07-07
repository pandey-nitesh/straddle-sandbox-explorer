import { describe, expect, it } from "vitest";
import { FakeClock } from "../straddle/fake-clock.js";
import { poll, PollTimeoutError, RateFloorScheduler } from "./poller.js";

describe("poller", () => {
  it("latches into fast mode after switchToFast returns true", async () => {
    const clock = new FakeClock(0);
    const seen: string[] = [];
    const task = poll({
      clock,
      policy: {
        baseMinMs: 10,
        baseMaxMs: 10,
        fastMs: 1,
        hardTimeoutMs: 100,
      },
      fetch: async () => ({
        status: clock.now() < 11 ? "pending" : "paid",
      }),
      switchToFast: (value) => value.status === "pending",
      isSettled: (value) => value.status === "paid",
      onObservation: (value) => {
        seen.push(`${clock.now()}:${value.status}`);
      },
      statusOf: (value) => value.status,
    });

    await clock.advance(10);
    expect(seen).toEqual(["10:pending"]);
    await clock.advance(1);
    await expect(task).resolves.toEqual({ status: "paid" });
    expect(seen).toEqual(["10:pending", "11:paid"]);
  });

  it("throws a hard-timeout result with the last observed status", async () => {
    const clock = new FakeClock(0);
    const task = poll({
      clock,
      policy: {
        baseMinMs: 10,
        baseMaxMs: 10,
        fastMs: 1,
        hardTimeoutMs: 25,
      },
      fetch: async () => ({ status: "pending" }),
      isSettled: () => false,
      onObservation: () => undefined,
      statusOf: (value) => value.status,
    }).catch((error: unknown) => error);

    await clock.advance(100);
    const caught = await task;
    expect(caught).toBeInstanceOf(PollTimeoutError);
    expect(caught).toMatchObject({ elapsedMs: 25, lastStatus: "pending" });
  });

  it("enforces a process-wide minimum gap between request starts", async () => {
    const clock = new FakeClock(1000);
    const scheduler = new RateFloorScheduler(clock, 250);
    const marks: number[] = [];
    const first = scheduler.waitTurn().then(() => marks.push(clock.now()));
    const second = scheduler.waitTurn().then(() => marks.push(clock.now()));

    await clock.advance(0);
    await first;
    expect(marks).toEqual([1000]);
    await clock.advance(249);
    expect(marks).toEqual([1000]);
    await clock.advance(1);
    await second;
    expect(marks).toEqual([1000, 1250]);
  });
});
