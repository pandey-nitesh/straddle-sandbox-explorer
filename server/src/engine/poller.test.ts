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

  it("treats a retryable fetch error as a missed observation and keeps polling", async () => {
    const clock = new FakeClock(0);
    let calls = 0;
    const seen: string[] = [];
    const task = poll({
      clock,
      policy: { baseMinMs: 10, baseMaxMs: 10, fastMs: 10, hardTimeoutMs: 1_000 },
      fetch: async () => {
        calls += 1;
        if (calls <= 2) throw { status: 503, path: "/v1/charges", retryable: true, errorBody: {} };
        return { status: "paid" };
      },
      onFetchError: (error) =>
        (error as { retryable?: boolean }).retryable === true ? "retry" : "fail",
      isSettled: (value) => value.status === "paid",
      onObservation: (value) => {
        seen.push(value.status);
      },
      statusOf: (value) => value.status,
    });

    await clock.advance(1_000);
    await expect(task).resolves.toEqual({ status: "paid" });
    expect(calls).toBe(3); // two transient failures, then success
    expect(seen).toEqual(["paid"]); // only the successful fetch is an observation
  });

  it("rethrows a non-retryable fetch error immediately", async () => {
    const clock = new FakeClock(0);
    let calls = 0;
    const task = poll({
      clock,
      policy: { baseMinMs: 10, baseMaxMs: 10, fastMs: 10, hardTimeoutMs: 1_000 },
      fetch: async () => {
        calls += 1;
        throw { status: 404, path: "/v1/charges", retryable: false, errorBody: {} };
      },
      onFetchError: (error) =>
        (error as { retryable?: boolean }).retryable === true ? "retry" : "fail",
      isSettled: () => true,
      onObservation: () => undefined,
      statusOf: () => undefined,
    }).catch((error: unknown) => error);

    await clock.advance(50);
    expect(await task).toMatchObject({ status: 404 });
    expect(calls).toBe(1); // failed once, did not keep polling
  });

  it("hard-times-out when a transient error never clears", async () => {
    const clock = new FakeClock(0);
    const task = poll({
      clock,
      policy: { baseMinMs: 10, baseMaxMs: 10, fastMs: 10, hardTimeoutMs: 35 },
      fetch: async () => {
        throw { status: 503, path: "/v1/charges", retryable: true, errorBody: {} };
      },
      onFetchError: () => "retry",
      isSettled: () => true,
      onObservation: () => undefined,
      statusOf: () => undefined,
    }).catch((error: unknown) => error);

    await clock.advance(100);
    expect(await task).toBeInstanceOf(PollTimeoutError);
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
