/**
 * Compile-level contract test for the StraddleClient boundary: a synthetic
 * in-memory implementation must satisfy the interface, and DTO fields must
 * line up with api-notes.md names. All values below are SYNTHETIC — fake IDs,
 * the documented seeded bank constants, never captured sandbox output.
 */
import { describe, expect, it } from "vitest";
import { SEEDED_BANK } from "@sse/shared";
import type {
  ChargeInput,
  ChargeResult,
  Clock,
  CustomerInput,
  CustomerResult,
  CustomerReviewResult,
  HealthResult,
  PaykeyInput,
  PaykeyResult,
  StraddleClient,
} from "./types.js";

const customer: CustomerResult = {
  id: "0197e5b3-0000-7000-8000-fakecust0001",
  status: "verified",
  name: "Test Person",
  email: "test@example.com",
  phone: "+15555550100",
  type: "individual",
  external_id: "run-20260707T062143Z-a-0001",
  created_at: "2026-07-07T06:21:43.8306543Z",
  updated_at: "2026-07-07T06:21:44", // GET-style lenient timestamp
};

const paykey: PaykeyResult = {
  id: "0197e5b3-0000-7000-8000-fakepkey0001",
  paykey: "deadbeef.01." + "0".repeat(64), // synthetic token in the documented format
  customer_id: customer.id,
  status: "active",
  label: "JPMORGAN CHASE BANK, NA - *4321",
  institution_name: "JPMORGAN CHASE BANK, NA",
  source: "bank_account",
  bank_data: {
    routing_number: SEEDED_BANK.routing_number,
    account_number: "*****4321",
    account_type: "checking",
  },
  created_at: "2026-07-07T06:21:45.0000000Z",
  updated_at: "2026-07-07T06:21:45.0000000Z",
};

const charge: ChargeResult = {
  id: "0197e5b3-0000-7000-8000-fakechrg0001",
  status: "failed",
  status_details: {
    message: "returned by the bank",
    reason: "insufficient_funds",
    source: "bank_decline",
    code: "R01",
    changed_at: "2026-07-07T06:27:35.0000000Z",
  },
  status_history: [
    {
      status: "created",
      reason: "ok",
      source: "system",
      changed_at: "2026-07-07T06:21:46.0000000Z",
    },
    {
      status: "failed",
      reason: "insufficient_funds",
      source: "bank_decline",
      code: "R01",
      changed_at: "2026-07-07T06:27:35.0000000Z",
    },
  ],
  amount: 10000,
  currency: "USD",
  external_id: "run-20260707T062143Z-b-0001",
  payment_date: "2026-07-07",
  created_at: "2026-07-07T06:21:46.0000000Z",
  updated_at: "2026-07-07T06:27:35.0000000Z",
};

/** The interface must be implementable without SDK types. */
const fakeClient: StraddleClient = {
  async health(): Promise<HealthResult> {
    return { ok: true, status: 200 };
  },
  async createCustomer(_input: CustomerInput): Promise<CustomerResult> {
    return customer;
  },
  async getCustomerReview(customerId: string): Promise<CustomerReviewResult> {
    return {
      customer_id: customerId,
      status: "verified",
      decision: "accept", // canned — never authoritative (api-notes §6)
      summary: {
        verification_status: "verified",
        risk_score: 0.01,
        correlation_score: 0.99,
        reason_codes: ["I121"],
      },
    };
  },
  async createPaykey(_input: PaykeyInput): Promise<PaykeyResult> {
    return paykey;
  },
  async createCharge(_input: ChargeInput): Promise<ChargeResult> {
    return charge;
  },
  async getCharge(_chargeId: string): Promise<ChargeResult> {
    return charge;
  },
};

describe("StraddleClient boundary types", () => {
  it("a synthetic implementation satisfies the interface end to end", async () => {
    const health = await fakeClient.health();
    expect(health.ok).toBe(true);

    const input: CustomerInput = {
      name: "Test Person",
      type: "individual",
      email: "test@example.com",
      phone: "+15555550100",
      device: { ip_address: "0.0.0.0" },
      config: { sandbox_outcome: "verified" },
      external_id: "run-20260707T062143Z-a-0001",
      idempotencyKey: "run-20260707T062143Z-a-0001-create_customer",
    };
    const created = await fakeClient.createCustomer(input);
    const review = await fakeClient.getCustomerReview(created.id);
    expect(review.status).toBe("verified");
    expect(review.summary.verification_status).toBe("verified");
  });

  it("charge input requires the paykey TOKEN, cents amount, and balance_check", async () => {
    const input: ChargeInput = {
      paykey: paykey.paykey, // token, not paykey.id
      amount: 10000,
      currency: "USD",
      description: "Scenario B charge",
      consent_type: "internet",
      device: { ip_address: "0.0.0.0" },
      external_id: "run-20260707T062143Z-b-0001",
      payment_date: "2026-07-07",
      config: {
        balance_check: "disabled", // pinned (api-notes §8 trap)
        sandbox_outcome: "failed_insufficient_funds",
      },
    };
    const result = await fakeClient.createCharge(input);
    // Scenario B's evaluator recipe: source + code, never reason alone.
    expect(result.status_details?.source).toBe("bank_decline");
    expect(result.status_details?.code).toBe("R01");
  });

  it("status strings tolerate unknown enum values (extensible by rule)", () => {
    const weird: ChargeResult = {
      ...charge,
      status: "some_future_status",
      status_details: {
        reason: "brand_new_reason",
        source: "watchtower",
        changed_at: "2026-07-07T06:27:35.0000000Z",
        // no code: watchtower failures carry none
      },
    };
    expect(weird.status).toBe("some_future_status");
    expect(weird.status_details?.code).toBeUndefined();
  });

  it("Clock is implementable with a trivial fake", async () => {
    let t = 1_000;
    const slept: number[] = [];
    const clock: Clock = {
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
    };
    await clock.sleep(250);
    expect(clock.now()).toBe(1_250);
    expect(slept).toEqual([250]);
  });
});
