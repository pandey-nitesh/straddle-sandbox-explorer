import { describe, expect, it, vi } from "vitest";
import { RunEventSchema } from "@sse/shared";
import type { RunEvent, ScenarioId } from "@sse/shared";
import { createBus } from "./bus.js";
import type { UnsequencedRunEvent } from "./bus.js";

/** Synthetic payment.status_changed input (no seq, no timestamp). */
function statusChanged(
  runId: string,
  scenarioId: ScenarioId,
  to: string,
): UnsequencedRunEvent {
  return {
    type: "payment.status_changed",
    run_id: runId,
    scenario_id: scenarioId,
    resource_id: "chg_fake_0001",
    from: null,
    to,
  };
}

const RUN_A = "run-20260707T120000Z-a-ab12";
const RUN_C = "run-20260707T120001Z-c-cd34";

describe("createBus", () => {
  it("assigns seq starting at 1, strictly monotonic across interleaved runs", () => {
    const bus = createBus();
    const seen: RunEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const e1 = bus.emit(statusChanged(RUN_A, "a", "created"));
    const e2 = bus.emit(statusChanged(RUN_C, "c", "created"));
    const e3 = bus.emit(statusChanged(RUN_A, "a", "pending"));
    const e4 = bus.emit(statusChanged(RUN_C, "c", "paid"));

    expect([e1.seq, e2.seq, e3.seq, e4.seq]).toEqual([1, 2, 3, 4]);
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    // Per-run projections have gaps — the global counter never resets per run.
    expect(seen.filter((e) => e.run_id === RUN_C).map((e) => e.seq)).toEqual([
      2, 4,
    ]);
  });

  it("stamps a valid ISO timestamp when absent and preserves one when given", () => {
    const fixed = new Date("2026-07-07T12:00:00.000Z");
    const bus = createBus({ now: () => fixed });

    const stamped = bus.emit(statusChanged(RUN_A, "a", "created"));
    expect(stamped.timestamp).toBe("2026-07-07T12:00:00.000Z");

    const given = bus.emit({
      ...statusChanged(RUN_A, "a", "pending"),
      timestamp: "2026-07-07T06:21:43.8306543Z",
    });
    expect(given.timestamp).toBe("2026-07-07T06:21:43.8306543Z");
  });

  it("returns the validated event, which re-parses against RunEventSchema", () => {
    const bus = createBus();
    const event = bus.emit(statusChanged(RUN_A, "a", "paid"));
    expect(RunEventSchema.safeParse(event).success).toBe(true);
  });

  it("throws on an invalid event without consuming a seq or notifying subscribers", () => {
    const bus = createBus();
    const seen: RunEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    // retry.scheduled with attempt 1 violates the min(2) contract.
    expect(() =>
      bus.emit({
        type: "retry.scheduled",
        run_id: RUN_A,
        scenario_id: "a",
        attempt: 1,
        delay_ms: 1000,
      }),
    ).toThrow();
    // scenario_id outside the a–i enum is a programmer error too.
    expect(() =>
      bus.emit(
        statusChanged(RUN_A, "z" as ScenarioId, "created"),
      ),
    ).toThrow();

    expect(seen).toEqual([]);
    const next = bus.emit(statusChanged(RUN_A, "a", "created"));
    expect(next.seq).toBe(1); // failed emits burned nothing
  });

  it("fans out synchronously in subscription order", () => {
    const bus = createBus();
    const order: string[] = [];
    bus.subscribe(() => order.push("first"));
    bus.subscribe(() => order.push("second"));
    bus.subscribe(() => order.push("third"));

    bus.emit(statusChanged(RUN_A, "a", "created"));
    expect(order).toEqual(["first", "second", "third"]); // fully delivered before emit returns
  });

  it("isolates a throwing subscriber and reports it via onSubscriberError", () => {
    const boom = new Error("subscriber exploded");
    const onSubscriberError = vi.fn();
    const bus = createBus({ onSubscriberError });
    const seen: RunEvent[] = [];

    bus.subscribe(() => {
      throw boom;
    });
    bus.subscribe((e) => seen.push(e));

    const event = bus.emit(statusChanged(RUN_A, "a", "created"));

    expect(seen).toEqual([event]); // later subscriber still ran
    expect(onSubscriberError).toHaveBeenCalledTimes(1);
    expect(onSubscriberError).toHaveBeenCalledWith(boom, event);
  });

  it("survives a throwing onSubscriberError handler", () => {
    const bus = createBus({
      onSubscriberError: () => {
        throw new Error("reporter exploded");
      },
    });
    const seen: RunEvent[] = [];
    bus.subscribe(() => {
      throw new Error("subscriber exploded");
    });
    bus.subscribe((e) => seen.push(e));

    expect(() => bus.emit(statusChanged(RUN_A, "a", "created"))).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("unsubscribe stops delivery and is idempotent", () => {
    const bus = createBus();
    const seen: RunEvent[] = [];
    const unsubscribe = bus.subscribe((e) => seen.push(e));

    bus.emit(statusChanged(RUN_A, "a", "created"));
    unsubscribe();
    unsubscribe(); // second call is a no-op
    bus.emit(statusChanged(RUN_A, "a", "pending"));

    expect(seen).toHaveLength(1);
  });

  it("tolerates unsubscribe during fan-out without skipping other subscribers", () => {
    const bus = createBus();
    const order: string[] = [];
    const unsubscribeSecond: { fn?: () => void } = {};
    bus.subscribe(() => {
      order.push("first");
      unsubscribeSecond.fn?.();
    });
    unsubscribeSecond.fn = bus.subscribe(() => order.push("second"));
    bus.subscribe(() => order.push("third"));

    bus.emit(statusChanged(RUN_A, "a", "created"));
    // The current fan-out snapshot still includes "second"; "third" is not skipped.
    expect(order).toEqual(["first", "second", "third"]);

    order.length = 0;
    bus.emit(statusChanged(RUN_A, "a", "pending"));
    expect(order).toEqual(["first", "third"]); // unsubscribed for subsequent events
  });
});
