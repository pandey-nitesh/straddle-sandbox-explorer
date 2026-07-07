import { describe, expect, it } from "vitest";
import { SEEDED_BANK } from "@sse/shared";
import type { ApiExchangeEvent, RunEvent, ScenarioId } from "@sse/shared";
import { createBus } from "../engine/bus.js";
import { FakeClock } from "./fake-clock.js";
import {
  createMockStraddleClient,
  MockApiError,
  SCHEDULES,
} from "./mock.js";
import type { ChargeSchedule } from "./mock.js";
import type {
  ChargeResult,
  ChargeSandboxOutcome,
  CustomerSandboxOutcome,
  StraddleClient,
} from "./types.js";

// Fixed fake epoch (synthetic; any value works — chosen near the project era).
const T0 = Date.parse("2026-07-07T12:00:00.000Z");

function makeHarness(
  scenarioId: ScenarioId,
  opts: { chargeSchedule?: ChargeSchedule } = {},
): {
  clock: FakeClock;
  events: RunEvent[];
  client: StraddleClient;
  runId: string;
} {
  const clock = new FakeClock(T0);
  const bus = createBus({ now: () => new Date(clock.now()) });
  const events: RunEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const runId = `run-20260707T120000Z-${scenarioId}-0001`;
  const client = createMockStraddleClient({
    bus,
    clock,
    context: { run_id: runId, scenario_id: scenarioId },
    ...(opts.chargeSchedule !== undefined
      ? { chargeSchedule: opts.chargeSchedule }
      : {}),
  });
  return { clock, events, client, runId };
}

/** Runs the standard A–D resource flow up to charge creation. */
async function createChargeFlow(
  client: StraddleClient,
  runId: string,
  chargeOutcome: ChargeSandboxOutcome,
  customerOutcome: CustomerSandboxOutcome = "verified",
): Promise<ChargeResult> {
  const customer = await client.createCustomer({
    name: "Jane Mock",
    type: "individual",
    email: "jane.mock@example.com",
    phone: "+15555550100",
    device: { ip_address: "0.0.0.0" },
    config: { sandbox_outcome: customerOutcome },
    external_id: runId,
  });
  const paykey = await client.createPaykey({
    customer_id: customer.id,
    routing_number: SEEDED_BANK.routing_number,
    account_number: SEEDED_BANK.preferred_account_number,
    account_type: "checking",
    config: { sandbox_outcome: "active" },
  });
  return client.createCharge({
    paykey: paykey.paykey,
    amount: 10_000,
    currency: "USD",
    description: "mock scenario charge",
    consent_type: "internet",
    device: { ip_address: "0.0.0.0" },
    external_id: runId,
    payment_date: "2026-07-07",
    config: { balance_check: "disabled", sandbox_outcome: chargeOutcome },
  });
}

/** Polls the charge on the fake clock, collecting each distinct status. */
async function pollDistinctStatuses(
  client: StraddleClient,
  clock: FakeClock,
  charge: ChargeResult,
  args: { stepMs: number; untilMs: number; terminal: readonly string[] },
): Promise<{ statuses: string[]; final: ChargeResult }> {
  const statuses: string[] = [charge.status];
  let final = charge;
  for (let t = 0; t < args.untilMs; t += args.stepMs) {
    await clock.advance(args.stepMs);
    final = await client.getCharge(charge.id);
    if (final.status !== statuses.at(-1)) statuses.push(final.status);
    if (args.terminal.includes(final.status)) break;
  }
  return { statuses, final };
}

describe("scenario C — spec-contract schedule (Wave 1 exit criterion)", () => {
  it("observes created -> pending -> paid -> reversed in order, with the R-code on the reversal", async () => {
    const { clock, client, runId } = makeHarness("c");
    const charge = await createChargeFlow(
      client,
      runId,
      "reversed_insufficient_funds",
    );
    expect(charge.status).toBe("created");
    expect(charge.status_details?.code).toBeUndefined(); // absent, not null

    // 5 s fast-poll cadence (api-notes §9 recommended fastMs).
    const { statuses, final } = await pollDistinctStatuses(
      client,
      clock,
      charge,
      { stepMs: 5_000, untilMs: 400_000, terminal: ["reversed", "failed"] },
    );

    expect(statuses).toEqual(["created", "pending", "paid", "reversed"]);

    // Terminal detail: R-code in status_details.code (api-notes §8 nesting).
    expect(final.status_details).toMatchObject({
      code: "R01",
      reason: "insufficient_funds",
      source: "bank_decline",
    });

    // status_history keeps BOTH paid and reversed, ordered, with
    // authoritative changed_at times derived from the injected clock.
    const historyStatuses = final.status_history.map((h) => h.status);
    expect(historyStatuses).toEqual(["created", "pending", "paid", "reversed"]);
    const paid = final.status_history.find((h) => h.status === "paid");
    const reversed = final.status_history.find((h) => h.status === "reversed");
    expect(paid).toBeDefined();
    expect(reversed).toBeDefined();
    expect(paid?.changed_at).toBe(new Date(T0 + 117_000).toISOString());
    expect(reversed?.changed_at).toBe(new Date(T0 + 358_000).toISOString());
    expect(Date.parse(reversed?.changed_at ?? "")).toBeGreaterThan(
      Date.parse(paid?.changed_at ?? ""),
    );
    // paid is NOT the terminal detail; only the reversal carries the code.
    expect(paid?.code).toBeUndefined();
  });

  it("c_live schedule reproduces the observed live shape: pending x3 then failed+R01, never paid/reversed", async () => {
    const { clock, client, runId } = makeHarness("c", {
      chargeSchedule: SCHEDULES.c_live,
    });
    const charge = await createChargeFlow(
      client,
      runId,
      "reversed_insufficient_funds",
    );
    const { statuses, final } = await pollDistinctStatuses(
      client,
      clock,
      charge,
      { stepMs: 5_000, untilMs: 400_000, terminal: ["failed"] },
    );
    expect(statuses).toEqual(["created", "scheduled", "pending", "failed"]);
    expect(statuses).not.toContain("paid");
    expect(statuses).not.toContain("reversed");
    // Event-level history: three consecutive pending entries (api-notes §8).
    const pendingEntries = final.status_history.filter(
      (h) => h.status === "pending",
    );
    expect(pendingEntries).toHaveLength(3);
    expect(final.status_details?.code).toBe("R01");
    expect(final.status_details?.source).toBe("bank_decline");
    // Terminal lands at the measured +351 s analog.
    expect(final.status_details?.changed_at).toBe(
      new Date(T0 + 351_000).toISOString(),
    );
  });
});

describe("scenario E — rejected customer refusal", () => {
  it("createCustomer(rejected) settles rejected synchronously; review keeps the canned accept quirk", async () => {
    const { client, runId } = makeHarness("e");
    const customer = await client.createCustomer({
      name: "Rex Rejected",
      type: "individual",
      email: "rex@example.com",
      phone: "+15555550101",
      device: { ip_address: "0.0.0.0" },
      config: { sandbox_outcome: "rejected" },
      external_id: runId,
    });
    expect(customer.status).toBe("rejected");

    const review = await client.getCustomerReview(customer.id);
    // Authoritative status is the customer status...
    expect(review.status).toBe("rejected");
    expect(review.summary.verification_status).toBe("rejected");
    // ...while identity_details.decision is canned "accept" (api-notes §6).
    expect(review.decision).toBe("accept");
    expect(review.summary.reason_codes).toEqual(["I121", "I553"]);
    expect(review.summary.risk_score).toBeCloseTo(0.184);
    expect(review.summary.correlation_score).toBeCloseTo(0.99);
  });

  it("createPaykey for a rejected customer throws the 422 refusal with the verbatim api-notes §10 envelope", async () => {
    const { client, events, runId } = makeHarness("e");
    const customer = await client.createCustomer({
      name: "Rex Rejected",
      type: "individual",
      email: "rex@example.com",
      phone: "+15555550101",
      device: { ip_address: "0.0.0.0" },
      config: { sandbox_outcome: "rejected" },
      external_id: runId,
    });

    let caught: unknown;
    try {
      await client.createPaykey({
        customer_id: customer.id,
        routing_number: SEEDED_BANK.routing_number,
        account_number: SEEDED_BANK.preferred_account_number,
        account_type: "checking",
        // Sandbox forcing does not bypass the rejection check (api-notes §10).
        config: { sandbox_outcome: "active" },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MockApiError);
    const err = caught as MockApiError;
    expect(err.status).toBe(422);
    expect(err.retryable).toBe(false);
    expect(err.path).toBe("/v1/bridge/bank_account");

    const body = err.errorBody as {
      error: Record<string, unknown>;
      response_type: string;
    };
    expect(body.response_type).toBe("error");
    expect(body.error).toEqual({
      status: 422,
      type: "/validation_error",
      title: "Validation Failed",
      detail: "Cannot create paykey as customer is rejected.",
    });
    // The distinguisher from generic validation 422s: items is ABSENT.
    expect("items" in body.error).toBe(false);

    // The refused attempt is still telemetry: an api.exchange with 422.
    const refusalExchange = events.find(
      (e) => e.type === "api.exchange" && e.status === 422,
    );
    expect(refusalExchange).toMatchObject({
      type: "api.exchange",
      method: "POST",
      path: "/v1/bridge/bank_account",
      status: 422,
      attempt: 1,
      run_id: runId,
      scenario_id: "e",
    });
  });
});

describe("scenarios A, B, D — scripted terminals", () => {
  it("A reaches terminal paid with no return code", async () => {
    const { clock, client, runId } = makeHarness("a");
    const charge = await createChargeFlow(client, runId, "paid");
    await clock.advance(600_000);
    const final = await client.getCharge(charge.id);
    expect(final.status).toBe("paid");
    expect(final.status_details?.code).toBeUndefined();
    expect(final.status_details?.reason).toBe("ok");
    expect(final.status_history.map((h) => h.status)).toEqual([
      "created",
      "scheduled",
      "pending",
      "paid",
    ]);
  });

  it("B reaches terminal failed with R01 from bank_decline", async () => {
    const { clock, client, runId } = makeHarness("b");
    const charge = await createChargeFlow(
      client,
      runId,
      "failed_insufficient_funds",
    );
    await clock.advance(600_000);
    const final = await client.getCharge(charge.id);
    expect(final.status).toBe("failed");
    expect(final.status_details).toMatchObject({
      code: "R01",
      reason: "insufficient_funds",
      source: "bank_decline", // B's evaluator keys on source + code (api-notes §8)
    });
  });

  it("D reaches terminal cancelled with reason detail and no return code", async () => {
    const { clock, client, runId } = makeHarness("d");
    const charge = await createChargeFlow(
      client,
      runId,
      "cancelled_for_fraud_risk",
    );
    await clock.advance(60_000);
    const final = await client.getCharge(charge.id);
    expect(final.status).toBe("cancelled");
    expect(final.status_details?.reason).toBe("fraudulent");
    expect(final.status_details?.source).toBe("watchtower");
    expect(final.status_details?.message).toBeTruthy(); // D requires reason detail
    expect(final.status_details?.code).toBeUndefined(); // watchtower: no code
  });
});

describe("api.exchange telemetry", () => {
  it("emits one attempt-1 exchange per call, with run identity and bus-assigned monotonic seq", async () => {
    const { clock, client, events, runId } = makeHarness("a");
    await client.health();
    const customer = await client.createCustomer({
      name: "Jane Mock",
      type: "individual",
      email: "jane.mock@example.com",
      phone: "+15555550100",
      device: { ip_address: "0.0.0.0" },
      config: { sandbox_outcome: "verified" },
    });
    await client.getCustomerReview(customer.id);
    const paykey = await client.createPaykey({
      customer_id: customer.id,
      routing_number: SEEDED_BANK.routing_number,
      account_number: SEEDED_BANK.preferred_account_number,
      account_type: "checking",
    });
    const charge = await client.createCharge({
      paykey: paykey.paykey,
      amount: 10_000,
      currency: "USD",
      description: "telemetry test",
      consent_type: "internet",
      device: { ip_address: "0.0.0.0" },
      external_id: runId,
      payment_date: "2026-07-07",
      config: { balance_check: "disabled", sandbox_outcome: "paid" },
    });
    await clock.advance(200_000);
    await client.getCharge(charge.id);

    const exchanges = events.filter(
      (e): e is ApiExchangeEvent => e.type === "api.exchange",
    );
    expect(exchanges.map((e) => [e.method, e.path])).toEqual([
      ["GET", "/v1/customers"],
      ["POST", "/v1/customers"],
      ["GET", `/v1/customers/${customer.id}/review`],
      ["POST", "/v1/bridge/bank_account"],
      ["POST", "/v1/charges"],
      ["GET", `/v1/charges/${charge.id}`],
    ]);
    for (const e of exchanges) {
      expect(e.attempt).toBe(1);
      expect(e.run_id).toBe(runId);
      expect(e.scenario_id).toBe("a");
      expect(e.latency_ms).toBeGreaterThan(0);
      expect(e.api_request_id).toMatch(/^mock-req-\d+$/);
    }
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("emitted bodies preserve sandbox evidence but redact credentials and bank canaries", async () => {
    const { clock, client, events, runId } = makeHarness("a");
    const customer = await client.createCustomer({
      name: "Jane Mock",
      type: "individual",
      email: "jane.mock@example.com",
      phone: "+15555550100",
      device: { ip_address: "10.1.2.3" },
      config: { sandbox_outcome: "verified" },
      metadata: { note: "secret-metadata-value" },
    });
    await client.getCustomerReview(customer.id);
    const paykey = await client.createPaykey({
      customer_id: customer.id,
      routing_number: SEEDED_BANK.routing_number,
      account_number: SEEDED_BANK.preferred_account_number,
      account_type: "checking",
    });
    const charge = await client.createCharge({
      paykey: paykey.paykey,
      amount: 10_000,
      currency: "USD",
      description: "redaction test",
      consent_type: "internet",
      device: { ip_address: "10.1.2.3" },
      external_id: runId,
      payment_date: "2026-07-07",
      config: { balance_check: "disabled", sandbox_outcome: "paid" },
    });
    await clock.advance(200_000);
    await client.getCharge(charge.id);

    const serialized = JSON.stringify(events);
    // Canary values (spec §8): raw seeded bank numbers must not survive.
    expect(serialized).not.toContain(SEEDED_BANK.routing_number);
    expect(serialized).not.toContain(SEEDED_BANK.preferred_account_number);
    expect(serialized).not.toContain(SEEDED_BANK.blocked_account_number);
    // The credential-like paykey token must not survive (api-notes §11).
    expect(serialized).not.toContain(paykey.paykey);
    // Non-credential sandbox evidence survives for the Wire inspector.
    expect(serialized).toContain("Jane Mock");
    expect(serialized).toContain("jane.mock@example.com");
    expect(serialized).toContain("+15555550100");
    expect(serialized).toContain("secret-metadata-value");
    // Hard identifiers still do not survive.
    expect(serialized).not.toContain("10.1.2.3");
    // Results returned to the ENGINE stay usable: the token is intact there.
    expect(paykey.paykey).toMatch(/^[0-9a-f]{8}\.\d{2}\.[0-9a-f]{64}$/);
    // external_id (= run_id) is explicitly safe evidence and survives.
    expect(serialized).toContain(runId);
  });
});

describe("charge input guards (api-notes §8 constraints)", () => {
  it("rejects an unknown paykey token with a generic validation 422 (items PRESENT)", async () => {
    const { client, runId } = makeHarness("a");
    await expect(
      client.createCharge({
        paykey: "not-a-real-token",
        amount: 10_000,
        currency: "USD",
        description: "bad token",
        consent_type: "internet",
        device: { ip_address: "0.0.0.0" },
        external_id: runId,
        payment_date: "2026-07-07",
        config: { balance_check: "disabled" },
      }),
    ).rejects.toMatchObject({ status: 422, retryable: false });
  });

  it("rejects a duplicate external_id with 422", async () => {
    const { client, runId } = makeHarness("a");
    const first = await createChargeFlow(client, runId, "paid");
    expect(first.external_id).toBe(runId);
    // Second charge reusing the same external_id must be refused.
    const customer = await client.createCustomer({
      name: "Second Customer",
      type: "individual",
      email: "second@example.com",
      phone: "+15555550102",
      device: { ip_address: "0.0.0.0" },
      config: { sandbox_outcome: "verified" },
    });
    const paykey = await client.createPaykey({
      customer_id: customer.id,
      routing_number: SEEDED_BANK.routing_number,
      account_number: SEEDED_BANK.preferred_account_number,
      account_type: "checking",
    });
    let caught: unknown;
    try {
      await client.createCharge({
        paykey: paykey.paykey,
        amount: 10_000,
        currency: "USD",
        description: "duplicate external_id",
        consent_type: "internet",
        device: { ip_address: "0.0.0.0" },
        external_id: runId,
        payment_date: "2026-07-07",
        config: { balance_check: "disabled" },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MockApiError);
    const body = (caught as MockApiError).errorBody as {
      error: { items?: unknown[] };
    };
    // Generic validation 422s DO carry items — unlike the E refusal.
    expect(Array.isArray(body.error.items)).toBe(true);
  });
});
