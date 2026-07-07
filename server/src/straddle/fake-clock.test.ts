import { describe, expect, it } from "vitest";
import { FakeClock } from "./fake-clock.js";

describe("FakeClock", () => {
  it("starts at the given epoch and advances now()", async () => {
    const clock = new FakeClock(1_000);
    expect(clock.now()).toBe(1_000);
    await clock.advance(250);
    expect(clock.now()).toBe(1_250);
  });

  it("sleep resolves only once time passes its due point", async () => {
    const clock = new FakeClock();
    let resolved = false;
    void clock.sleep(1_000).then(() => {
      resolved = true;
    });
    await clock.advance(999);
    expect(resolved).toBe(false);
    expect(clock.pendingSleepers()).toBe(1);
    await clock.advance(1);
    expect(resolved).toBe(true);
    expect(clock.pendingSleepers()).toBe(0);
  });

  it("sleep(0) and negative sleeps resolve immediately", async () => {
    const clock = new FakeClock();
    await clock.sleep(0);
    await clock.sleep(-5);
    expect(clock.pendingSleepers()).toBe(0);
  });

  it("releases sleepers in due order and honors chained sleeps in one advance", async () => {
    const clock = new FakeClock();
    const order: string[] = [];
    void clock.sleep(300).then(() => {
      order.push("b");
    });
    void clock.sleep(100).then(async () => {
      order.push("a");
      // Chained sleep scheduled DURING the advance, due within its window.
      await clock.sleep(100); // due at 200
      order.push("a2");
    });
    await clock.advance(500);
    expect(order).toEqual(["a", "a2", "b"]);
    expect(clock.now()).toBe(500);
  });

  it("wakes each sleeper at its own due time", async () => {
    const clock = new FakeClock();
    let observedAtWake = -1;
    void clock.sleep(200).then(() => {
      observedAtWake = clock.now();
    });
    await clock.advance(1_000);
    expect(observedAtWake).toBe(200);
  });

  it("refuses to move backwards", async () => {
    const clock = new FakeClock(500);
    await expect(clock.advanceTo(499)).rejects.toThrow(/backwards/);
  });
});
