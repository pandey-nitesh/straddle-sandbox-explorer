import { describe, expect, it } from "vitest";
import {
  ApiExchangeEventSchema,
  CustomerReviewChangedEventSchema,
  PaymentStatusChangedEventSchema,
  RetryScheduledEventSchema,
  RunCompletedEventSchema,
  RunEventSchema,
  RunStartedEventSchema,
  RUN_EVENT_TYPES,
  ScenarioAssertionEventSchema,
  WebhookReceivedEventSchema,
  type RunEvent,
} from "./events.js";

const base = {
  seq: 42,
  timestamp: "2026-07-07T06:21:43.8306543Z", // 7-digit live format must pass here too
  run_id: "run-20260707T062143Z-c-9f3a",
  scenario_id: "c",
} as const;

const fixtures: Record<(typeof RUN_EVENT_TYPES)[number], unknown> = {
  "run.started": {
    ...base,
    type: "run.started",
    scenario: {
      id: "c",
      label: "Reversal",
      purpose: "Watch a payment settle and then un-settle.",
      outcomes: { charge: "reversed_insufficient_funds" },
      requiredObservations: [
        { kind: "ordered_statuses", statuses: ["paid", "reversed"] },
      ],
    },
  },
  "api.exchange": {
    ...base,
    type: "api.exchange",
    method: "POST",
    path: "/v1/charges",
    status: 201,
    latency_ms: 512,
    attempt: 1,
    request_body: { amount: 10000, currency: "USD" },
    response_body: { data: { id: "0197e5…" } },
    api_request_id: "req_123",
  },
  "customer.review_changed": {
    ...base,
    type: "customer.review_changed",
    customer_id: "0197e5b3-fake-cust",
    status: "verified",
    review: {
      verification_status: "verified",
      risk_score: 0.01,
      correlation_score: 0.99,
      reason_codes: ["I121", "I553"],
    },
  },
  "payment.status_changed": {
    ...base,
    type: "payment.status_changed",
    resource_id: "0197e5b3-fake-chg",
    from: "pending",
    to: "failed",
    return_code: "R01",
    reason: "insufficient_funds",
    source: "bank_decline",
    changed_at: "2026-07-07T06:27:31.0210043Z",
    detail: { message: "returned by the bank" },
  },
  "retry.scheduled": {
    ...base,
    type: "retry.scheduled",
    method: "GET",
    path: "/v1/charges/0197e5b3-fake-chg",
    status: 429,
    error_class: "RateLimitError",
    attempt: 2,
    delay_ms: 1400,
  },
  "scenario.assertion": {
    ...base,
    type: "scenario.assertion",
    kind: "ordered_statuses",
    pass: false,
    diagnostic: "terminal reversed observed without prior paid",
  },
  "run.completed": {
    ...base,
    type: "run.completed",
    result: "failed",
    duration_ms: 351_000,
    recording_path: "runs/run-20260707T062143Z-c-9f3a.jsonl",
  },
  "webhook.received": {
    ...base,
    type: "webhook.received",
    event_id: "msg_2abc...", // Svix webhook id (dedup key)
    webhook_type: "charge.event.v1", // reversals ride the generic charge event
    verified: true,
    resource_id: "0197e5b3-fake-chg",
    delivered_at: "2026-07-07T06:27:31.0210043Z",
    detail: { type: "charge.event.v1", data: { status: "reversed" } }, // post-redaction summary
  },
};

describe("RunEventSchema — every event type round-trips through the union", () => {
  for (const type of RUN_EVENT_TYPES) {
    it(`accepts a valid ${type} event`, () => {
      const parsed = RunEventSchema.safeParse(fixtures[type]);
      expect(parsed.success, JSON.stringify(parsed)).toBe(true);
      if (parsed.success) expect(parsed.data.type).toBe(type);
    });
  }

  it("RUN_EVENT_TYPES stays in lockstep with the union's discriminator literals", () => {
    const unionTypes = RunEventSchema.options
      .map((o) => o.shape.type.value)
      .sort();
    expect([...RUN_EVENT_TYPES].sort()).toEqual(unionTypes);
  });

  it("rejects an unknown type literal and a missing discriminator", () => {
    expect(
      RunEventSchema.safeParse({ ...base, type: "run.exploded" }).success,
    ).toBe(false);
    expect(RunEventSchema.safeParse({ ...base }).success).toBe(false);
  });
});

describe("base envelope validation (applies to all events)", () => {
  const completed = fixtures["run.completed"] as Record<string, unknown>;

  it("rejects a missing seq", () => {
    const { seq: _seq, ...rest } = completed;
    expect(RunEventSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a non-integer or negative seq", () => {
    expect(RunEventSchema.safeParse({ ...completed, seq: 1.5 }).success).toBe(
      false,
    );
    expect(RunEventSchema.safeParse({ ...completed, seq: -1 }).success).toBe(
      false,
    );
  });

  it("accepts the second-precision no-offset live timestamp format", () => {
    expect(
      RunEventSchema.safeParse({ ...completed, timestamp: "2026-07-07T06:21:44" })
        .success,
    ).toBe(true);
  });

  it("rejects a malformed timestamp, empty run_id, unknown scenario_id", () => {
    expect(
      RunEventSchema.safeParse({ ...completed, timestamp: "yesterday" }).success,
    ).toBe(false);
    expect(
      RunEventSchema.safeParse({ ...completed, run_id: "" }).success,
    ).toBe(false);
    expect(
      RunEventSchema.safeParse({ ...completed, scenario_id: "z" }).success,
    ).toBe(false);
  });
});

describe("per-event field validation", () => {
  it("run.started rejects a malformed scenario snapshot", () => {
    expect(
      RunStartedEventSchema.safeParse({
        ...base,
        type: "run.started",
        scenario: { id: "c" },
      }).success,
    ).toBe(false);
  });

  it("api.exchange requires method/path/status/latency_ms/attempt; bodies optional", () => {
    expect(
      ApiExchangeEventSchema.safeParse({
        ...base,
        type: "api.exchange",
        method: "GET",
        path: "/v1/customers",
        status: 401, // the 0-byte 401: no response_body at all
        latency_ms: 180,
        attempt: 1,
      }).success,
    ).toBe(true);
    expect(
      ApiExchangeEventSchema.safeParse({
        ...base,
        type: "api.exchange",
        method: "GET",
        path: "/v1/customers",
        latency_ms: 180,
        attempt: 1,
      }).success,
    ).toBe(false); // missing status
    expect(
      ApiExchangeEventSchema.safeParse({
        ...fixtures["api.exchange"] as Record<string, unknown>,
        attempt: 0,
      }).success,
    ).toBe(false); // attempts are 1-based
  });

  it("customer.review_changed applies the reason_codes default", () => {
    const parsed = CustomerReviewChangedEventSchema.parse({
      ...base,
      type: "customer.review_changed",
      customer_id: "cust-1",
      status: "rejected",
      review: { verification_status: "rejected" },
    });
    expect(parsed.review.reason_codes).toEqual([]);
  });

  it("payment.status_changed accepts null from (first observation) and minimal shape", () => {
    expect(
      PaymentStatusChangedEventSchema.safeParse({
        ...base,
        type: "payment.status_changed",
        resource_id: "chg-1",
        from: null,
        to: "created",
      }).success,
    ).toBe(true);
    expect(
      PaymentStatusChangedEventSchema.safeParse({
        ...base,
        type: "payment.status_changed",
        resource_id: "chg-1",
        to: "created",
      }).success,
    ).toBe(false); // from must be present (nullable, not optional)
  });

  it("retry.scheduled rejects attempt 1 and negative delay", () => {
    const retry = fixtures["retry.scheduled"] as Record<string, unknown>;
    expect(
      RetryScheduledEventSchema.safeParse({ ...retry, attempt: 1 }).success,
    ).toBe(false);
    expect(
      RetryScheduledEventSchema.safeParse({ ...retry, delay_ms: -5 }).success,
    ).toBe(false);
  });

  it("scenario.assertion accepts a passing row without diagnostic, rejects unknown kind", () => {
    expect(
      ScenarioAssertionEventSchema.safeParse({
        ...base,
        type: "scenario.assertion",
        kind: "terminal_status",
        pass: true,
      }).success,
    ).toBe(true);
    expect(
      ScenarioAssertionEventSchema.safeParse({
        ...base,
        type: "scenario.assertion",
        kind: "vibes",
        pass: true,
      }).success,
    ).toBe(false);
  });

  it('run.completed rejects result "partial" — partial is defined by this event\'s absence', () => {
    expect(
      RunCompletedEventSchema.safeParse({
        ...(fixtures["run.completed"] as Record<string, unknown>),
        result: "partial",
      }).success,
    ).toBe(false);
  });

  it("webhook.received accepts the minimal correlated shape (optionals absent)", () => {
    expect(
      WebhookReceivedEventSchema.safeParse({
        ...base,
        type: "webhook.received",
        event_id: "msg_1",
        webhook_type: "charge.event.v1",
        verified: false,
      }).success,
    ).toBe(true);
  });

  it("webhook.received requires event_id, webhook_type, and verified", () => {
    const full = fixtures["webhook.received"] as Record<string, unknown>;
    for (const field of ["event_id", "webhook_type", "verified"]) {
      const { [field]: _omitted, ...rest } = full;
      expect(
        WebhookReceivedEventSchema.safeParse(rest).success,
        `expected missing ${field} to reject`,
      ).toBe(false);
    }
    // verified is a boolean, not a truthy string
    expect(
      WebhookReceivedEventSchema.safeParse({ ...full, verified: "yes" }).success,
    ).toBe(false);
  });
});

describe("seq gap tolerance (documentation-level)", () => {
  it("parses a per-run slice whose seqs are non-dense", () => {
    const seqs = [3, 17, 18, 250];
    const events = seqs.map((seq) =>
      RunEventSchema.parse({
        ...(fixtures["scenario.assertion"] as Record<string, unknown>),
        seq,
      }),
    );
    expect(events.map((e: RunEvent) => e.seq)).toEqual(seqs);
  });
});
