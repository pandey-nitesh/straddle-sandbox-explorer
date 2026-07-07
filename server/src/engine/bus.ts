import { RunEventSchema } from "@sse/shared";
import type { RunEvent } from "@sse/shared";

/**
 * Event bus (spec §6).
 *
 * ONE bus per process by construction: the CLI and the HTTP server each call
 * `createBus()` exactly once at wiring time and hand the instance to
 * producers; this module deliberately exports a factory, never a singleton.
 * Registry, recorder, and logger are SUBSCRIBERS of this bus, not constructor
 * parameters of the runner.
 *
 * The bus is the single authority for `seq`: globally monotonic per process
 * (per bus instance), starting at 1, assigned at emit time — producers never
 * set it. Consequence (spec §5): per-run JSONL files contain gaps in `seq`
 * because concurrent runs interleave on the one bus.
 */

/**
 * `Omit` does not distribute over unions — `Omit<RunEvent, "seq">` would
 * collapse the discriminated union to its common keys and destroy the
 * per-variant payload types. This helper preserves the union.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * What producers hand to `emit`: a full RunEvent minus `seq` (bus-assigned)
 * and with `timestamp` optional (bus-stamped when absent).
 */
export type UnsequencedRunEvent = DistributiveOmit<
  RunEvent,
  "seq" | "timestamp"
> & { timestamp?: string };

export type EventBus = {
  /**
   * Assigns the next `seq`, stamps `timestamp` if absent, validates the
   * completed event against `RunEventSchema`, and fans it out synchronously
   * to all subscribers in subscription order. Returns the validated event.
   *
   * An invalid event is a programmer error: emit THROWS (ZodError) before
   * assigning the seq or notifying anyone — invalid events neither consume a
   * sequence number nor reach subscribers.
   */
  emit(e: UnsequencedRunEvent): RunEvent;

  /**
   * Registers a subscriber; returns an idempotent unsubscribe function.
   * A throwing subscriber never breaks fan-out to the others: the error is
   * caught and routed to `onSubscriberError` (default: console.error).
   */
  subscribe(fn: (e: RunEvent) => void): () => void;
};

export type CreateBusOptions = {
  /** Clock for stamping absent timestamps; injectable for tests. */
  now?: () => Date;
  /**
   * Receives errors thrown by subscribers during fan-out. Defaults to
   * console.error — subscriber failures are reported, never silently
   * swallowed, and never propagated to the emitter or other subscribers.
   */
  onSubscriberError?: (error: unknown, event: RunEvent) => void;
};

export function createBus(options: CreateBusOptions = {}): EventBus {
  const now = options.now ?? (() => new Date());
  const onSubscriberError =
    options.onSubscriberError ??
    ((error: unknown, event: RunEvent) => {
      // eslint-disable-next-line no-console
      console.error(
        `event bus: subscriber threw while handling seq=${event.seq} type=${event.type}`,
        error,
      );
    });

  let nextSeq = 1;
  const subscribers: Array<(e: RunEvent) => void> = [];

  return {
    emit(e: UnsequencedRunEvent): RunEvent {
      const candidate = {
        ...e,
        timestamp: e.timestamp ?? now().toISOString(),
        seq: nextSeq,
      };
      // Throws ZodError on a malformed event — before the seq is consumed.
      const event = RunEventSchema.parse(candidate);
      nextSeq += 1;

      // Snapshot so subscribe/unsubscribe during fan-out cannot corrupt the
      // iteration; late subscribers see only subsequent events.
      for (const fn of [...subscribers]) {
        try {
          fn(event);
        } catch (error) {
          try {
            onSubscriberError(error, event);
          } catch {
            // The error reporter must never break emit.
          }
        }
      }
      return event;
    },

    subscribe(fn: (e: RunEvent) => void): () => void {
      subscribers.push(fn);
      return () => {
        const i = subscribers.indexOf(fn);
        if (i !== -1) subscribers.splice(i, 1);
      };
    },
  };
}
