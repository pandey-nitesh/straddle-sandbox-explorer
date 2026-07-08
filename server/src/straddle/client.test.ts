import { describe, expect, it } from "vitest";
import type { ApiExchangeEvent, RunEvent } from "@sse/shared";
import { createBus } from "../engine/bus.js";
import { createStraddleClient } from "./client.js";
import { StraddleApiError } from "./errors.js";
import type { Clock } from "./types.js";

/**
 * Construction / request-shape tests for the real fetch adapter's charge
 * ACTIONS (hold / release / cancel). The live sandbox is exercised elsewhere
 * (P2-2.2 live smoke) — here we inject `fetchImpl` and never touch the network.
 */

// A clock whose sleep resolves immediately so retry/backoff does not block.
const immediateClock: Clock = { now: () => 0, sleep: () => Promise.resolve() };

function chargeEnvelope(status: string): unknown {
  return {
    data: {
      id: "chg_123",
      status,
      status_history: [
        {
          status,
          reason: "user_request",
          source: "user_action",
          changed_at: "2026-07-08T12:00:00.000Z",
        },
      ],
      amount: 10_000,
      currency: "USD",
      external_id: "run-20260708T120000Z-a-0001",
      created_at: "2026-07-08T12:00:00.000Z",
      updated_at: "2026-07-08T12:00:00.000Z",
    },
    meta: { api_request_id: "req-abc" },
    response_type: "object",
  };
}

function payoutEnvelope(status: string): unknown {
  return {
    data: {
      id: "pyt_123",
      status,
      status_history: [
        {
          status,
          reason: "ok",
          source: "system",
          changed_at: "2026-07-08T12:00:00.000Z",
        },
      ],
      amount: 5_000,
      currency: "USD",
      external_id: "run-20260708T120000Z-a-0001",
      payment_date: "2026-07-08",
      paykey: "abc***.01.******def", // masked server-side (like charges)
      // Payout-only keys (api-notes §P13) — the DTO must tolerate these.
      funding_ids: ["fund_1"],
      is_refund: false,
      is_resubmit: false,
      has_resubmit: false,
      trace_ids: ["trace_1"],
      created_at: "2026-07-08T12:00:00.000Z",
      updated_at: "2026-07-08T12:00:00.000Z",
    },
    meta: { api_request_id: "req-pyt" },
    response_type: "object",
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function harness(responses: Response[]): {
  events: RunEvent[];
  calls: Recorded[];
  client: ReturnType<typeof createStraddleClient>;
} {
  const bus = createBus({ now: () => new Date(0) });
  const events: RunEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const calls: Recorded[] = [];
  let i = 0;
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: headers ?? {},
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : undefined,
    });
    const res = responses[i];
    i += 1;
    if (res === undefined) throw new Error("no scripted response left");
    return res;
  }) as typeof fetch;

  const client = createStraddleClient({
    apiKey: "sk_sandbox_test_key",
    bus,
    context: { run_id: "run-20260708T120000Z-a-0001", scenario_id: "a" },
    baseUrl: "https://sandbox.straddle.io",
    clock: immediateClock,
    fetchImpl,
  });
  return { events, calls, client };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("real client — charge actions (fetch adapter, no network)", () => {
  it("holdCharge PUTs /hold with a UUID Idempotency-Key and empty body by default", async () => {
    const { client, calls, events } = harness([
      jsonResponse(200, chargeEnvelope("on_hold")),
    ]);
    const result = await client.holdCharge("chg_123");
    expect(result.status).toBe("on_hold");

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call.method).toBe("PUT");
    expect(call.url).toBe("https://sandbox.straddle.io/v1/charges/chg_123/hold");
    expect(call.body).toEqual({}); // optional body; empty {} accepted (api-notes §P11)
    const idem = call.headers["Idempotency-Key"];
    expect(idem).toMatch(UUID_RE);
    expect((idem ?? "").length).toBeLessThanOrEqual(40); // §12 item 9 cap
    expect(call.headers["authorization"]).toBe("Bearer sk_sandbox_test_key");

    const exchange = events.find(
      (e): e is ApiExchangeEvent => e.type === "api.exchange",
    );
    expect(exchange).toMatchObject({
      method: "PUT",
      path: "/v1/charges/chg_123/hold",
      status: 200,
      attempt: 1,
    });
  });

  it("sends the reason in the body when provided, and honors a caller idempotency key", async () => {
    const { client, calls } = harness([
      jsonResponse(200, chargeEnvelope("cancelled")),
    ]);
    await client.cancelCharge("chg_123", {
      reason: "customer requested",
      idempotencyKey: "run-cancel-key-1",
    });
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call.url).toBe("https://sandbox.straddle.io/v1/charges/chg_123/cancel");
    expect(call.body).toEqual({ reason: "customer requested" });
    expect(call.headers["Idempotency-Key"]).toBe("run-cancel-key-1");
  });

  it("releaseCharge targets /release", async () => {
    const { client, calls } = harness([
      jsonResponse(200, chargeEnvelope("created")),
    ]);
    const result = await client.releaseCharge("chg_123");
    expect(result.status).toBe("created");
    expect(calls[0]?.url).toBe(
      "https://sandbox.straddle.io/v1/charges/chg_123/release",
    );
  });

  it("retries a transient 500 (§12.20 concurrency error) then succeeds", async () => {
    const { client, calls, events } = harness([
      jsonResponse(500, {
        error: { status: 500, type: "/api_error", title: "Server Error", detail: "Concurrency error for AggregateEventFields - x" },
        meta: { api_request_id: "req-1" },
        response_type: "error",
      }),
      jsonResponse(200, chargeEnvelope("on_hold")),
    ]);
    const result = await client.holdCharge("chg_123");
    expect(result.status).toBe("on_hold");
    expect(calls).toHaveLength(2); // retried once
    expect(events.some((e) => e.type === "retry.scheduled")).toBe(true);
    const puts = events.filter(
      (e): e is ApiExchangeEvent => e.type === "api.exchange",
    );
    expect(puts.map((e) => e.status)).toEqual([500, 200]);
  });

  it("createPayout POSTs /v1/payouts with a payout body, forwards the idempotency key, and emits api.exchange", async () => {
    const { client, calls, events } = harness([
      jsonResponse(201, payoutEnvelope("created")),
    ]);
    const result = await client.createPayout({
      paykey: `deadbeef.01.${"0".repeat(64)}`,
      amount: 5_000,
      currency: "USD",
      description: "test payout",
      device: { ip_address: "0.0.0.0" },
      external_id: "run-20260708T120000Z-a-0001",
      payment_date: "2026-07-08",
      config: { sandbox_outcome: "paid" },
      idempotencyKey: "run-payout-key-1",
    });
    expect(result.status).toBe("created");
    // Payout-only keys survive the blanket DTO cast (tolerate extras).
    expect(result.is_refund).toBe(false);
    expect(result.funding_ids).toEqual(["fund_1"]);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://sandbox.straddle.io/v1/payouts");
    const body = call.body as Record<string, unknown>;
    expect(body["amount"]).toBe(5_000);
    // Payout body OMITS charge-only fields and never carries idempotencyKey.
    expect("consent_type" in body).toBe(false);
    expect(
      "balance_check" in ((body["config"] ?? {}) as Record<string, unknown>),
    ).toBe(false);
    expect("idempotencyKey" in body).toBe(false);
    // The Idempotency-Key rides the HEADER (api-notes §P13 / §3).
    expect(call.headers["Idempotency-Key"]).toBe("run-payout-key-1");
    expect(call.headers["authorization"]).toBe("Bearer sk_sandbox_test_key");

    const exchange = events.find(
      (e): e is ApiExchangeEvent => e.type === "api.exchange",
    );
    expect(exchange).toMatchObject({
      method: "POST",
      path: "/v1/payouts",
      status: 201,
      attempt: 1,
    });
  });

  it("getPayout GETs /v1/payouts/{id}", async () => {
    const { client, calls, events } = harness([
      jsonResponse(200, payoutEnvelope("paid")),
    ]);
    const result = await client.getPayout("pyt_123");
    expect(result.status).toBe("paid");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("https://sandbox.straddle.io/v1/payouts/pyt_123");
    expect(
      events.some(
        (e) => e.type === "api.exchange" && e.path === "/v1/payouts/pyt_123",
      ),
    ).toBe(true);
  });

  it("throws StraddleApiError with the redacted body on a terminal-action 422", async () => {
    const { client } = harness([
      jsonResponse(422, {
        error: {
          status: 422,
          type: "/validation_error",
          title: "Validation Failed",
          detail: "Unable to change status of a cancelled payment.",
        },
        meta: { api_request_id: "req-2" },
        response_type: "error",
      }),
    ]);
    let caught: unknown;
    try {
      await client.holdCharge("chg_123");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StraddleApiError);
    const err = caught as StraddleApiError;
    expect(err.status).toBe(422);
    expect(err.retryable).toBe(false);
    expect(err.path).toBe("/v1/charges/chg_123/hold");
  });
});
