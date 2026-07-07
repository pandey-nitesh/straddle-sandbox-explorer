import { z } from "zod";
import { LenientDatetimeSchema } from "./datetime.js";
import {
  RequiredObservationKindSchema,
  ScenarioDefSchema,
  ScenarioIdSchema,
} from "./scenario.js";
import { IdentityReviewSummarySchema } from "./report.js";

/**
 * RunEvent contracts (spec §5/§6).
 *
 * Every event carries a globally monotonic per-process `seq` (assigned by the
 * bus, never by producers), an ISO `timestamp` (lenient — see datetime.ts),
 * `run_id`, and `scenario_id`. Per-run JSONL files contain GAPS in `seq`
 * (other runs' events interleave); no consumer may assume density.
 *
 * `run_id` format: `run-<yyyymmddThhmmssZ>-<scenario>-<rand4>`.
 */
const eventBase = {
  seq: z.number().int().nonnegative(),
  timestamp: LenientDatetimeSchema,
  run_id: z.string().min(1),
  scenario_id: ScenarioIdSchema,
} as const;

/**
 * The stable event-type literals the whole system keys on. Kept in lockstep
 * with the literals in the union below (a unit test asserts they match).
 */
export const RUN_EVENT_TYPES = [
  "run.started",
  "api.exchange",
  "customer.review_changed",
  "payment.status_changed",
  "retry.scheduled",
  "scenario.assertion",
  "run.completed",
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const RunStartedEventSchema = z.object({
  ...eventBase,
  type: z.literal("run.started"),
  scenario: ScenarioDefSchema, // scenario def snapshot
});
export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;

/**
 * One per HTTP exchange, attempt-numbered, emitted by the Straddle client's
 * instrumented fetch. Bodies are ALWAYS redacted before the event is
 * constructed (spec §8) — this schema cannot enforce that; the redactor and
 * canary tests do.
 */
export const ApiExchangeEventSchema = z.object({
  ...eventBase,
  type: z.literal("api.exchange"),
  method: z.string(), // "POST"
  path: z.string(), // "/v1/charges" — never the full URL with query secrets
  status: z.number().int(), // HTTP status of this attempt
  latency_ms: z.number().nonnegative(),
  attempt: z.number().int().min(1), // 1-based attempt number
  request_body: z.unknown().optional(), // redacted
  response_body: z.unknown().optional(), // redacted; absent for empty bodies (e.g. the 0-byte 401)
  api_request_id: z.string().optional(), // meta.api_request_id — the only trace id (api-notes §3)
});
export type ApiExchangeEvent = z.infer<typeof ApiExchangeEventSchema>;

/**
 * Settled review state. `status` is the authoritative customer `status`
 * (api-notes §6: `identity_details.decision` is canned and must not be used).
 */
export const CustomerReviewChangedEventSchema = z.object({
  ...eventBase,
  type: z.literal("customer.review_changed"),
  customer_id: z.string(),
  status: z.string(), // settled customer status, e.g. "verified" | "rejected"
  review: IdentityReviewSummarySchema,
});
export type CustomerReviewChangedEvent = z.infer<
  typeof CustomerReviewChangedEventSchema
>;

export const PaymentStatusChangedEventSchema = z.object({
  ...eventBase,
  type: z.literal("payment.status_changed"),
  resource_id: z.string(), // charge id
  from: z.string().nullable(), // null for the first observation
  to: z.string(), // observed statuses are extensible — plain string, never a closed enum
  return_code: z.string().optional(), // status_details.code — absent (not null) when inapplicable
  reason: z.string().optional(), // status_details.reason — extensible enum (api-notes §8)
  source: z.string().optional(), // status_details.source — B's evaluator keys on "bank_decline"
  changed_at: LenientDatetimeSchema.optional(), // authoritative server-side transition time
  detail: z.unknown().optional(), // redacted status detail (message etc.)
});
export type PaymentStatusChangedEvent = z.infer<
  typeof PaymentStatusChangedEventSchema
>;

/**
 * Emitted by the client wrapper before sleeping ahead of a retry.
 * `attempt` is the UPCOMING attempt number (so always >= 2); at least one of
 * `status` / `error_class` describes what failed (a discriminated-union-safe
 * cross-field rule, so it is documented rather than schema-enforced).
 */
export const RetryScheduledEventSchema = z.object({
  ...eventBase,
  type: z.literal("retry.scheduled"),
  method: z.string().optional(),
  path: z.string().optional(),
  status: z.number().int().optional(), // HTTP status that triggered the retry (429/5xx)
  error_class: z.string().optional(), // e.g. "APIConnectionError" when no HTTP response exists
  attempt: z.number().int().min(2),
  delay_ms: z.number().nonnegative(), // real backoff delay (SDK retries disabled — api-notes §1)
});
export type RetryScheduledEvent = z.infer<typeof RetryScheduledEventSchema>;

/** One per RequiredObservation, emitted by the evaluator. */
export const ScenarioAssertionEventSchema = z.object({
  ...eventBase,
  type: z.literal("scenario.assertion"),
  kind: RequiredObservationKindSchema,
  pass: z.boolean(),
  diagnostic: z.string().optional(), // required in spirit on failure; e.g. C's loud reversed-without-paid message
});
export type ScenarioAssertionEvent = z.infer<
  typeof ScenarioAssertionEventSchema
>;

/**
 * Clean completion marker. `result` is only ever passed|failed — a "partial"
 * scenario is DEFINED by the absence of this event (spec §5), so the literal
 * "partial" cannot appear here.
 */
export const RunCompletedEventSchema = z.object({
  ...eventBase,
  type: z.literal("run.completed"),
  result: z.enum(["passed", "failed"]),
  duration_ms: z.number().nonnegative(),
  recording_path: z.string(), // runs/<run_id>.jsonl
});
export type RunCompletedEvent = z.infer<typeof RunCompletedEventSchema>;

export const RunEventSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  ApiExchangeEventSchema,
  CustomerReviewChangedEventSchema,
  PaymentStatusChangedEventSchema,
  RetryScheduledEventSchema,
  ScenarioAssertionEventSchema,
  RunCompletedEventSchema,
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
