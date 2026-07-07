/**
 * Redactor unit tests (spec §12): known-value SYNTHETIC fixtures only.
 * The key is fake, the paykey token is invented, PII is invented; the only
 * "real" values are the documented seeded-bank constants from @sse/shared,
 * which are public docs examples AND canary values that must never survive.
 */
import { describe, expect, it } from "vitest";
import { SEEDED_BANK, SEEDED_BANK_CANARY_VALUES } from "@sse/shared";
import { createRedactor } from "./redaction.js";

const FAKE_KEY = "sk_sandbox_FAKE_test_1234";
// Invented token in the documented `<8hex>.<2digit>.<64hex>` shape.
const FAKE_PAYKEY_TOKEN = `0123abcd.02.${"a1b2c3d4".repeat(8)}`;
const FAKE_ACCOUNT = "555000111222"; // invented, not a seeded constant
const FAKE_ROUTING = "999888777"; // invented

const redactor = createRedactor({ apiKey: FAKE_KEY });

/** Every string that must never survive redaction, anywhere. */
const MUST_NOT_SURVIVE = [
  FAKE_KEY,
  FAKE_PAYKEY_TOKEN,
  ...SEEDED_BANK_CANARY_VALUES,
];

function expectZeroSurvivals(value: unknown, extra: string[] = []): void {
  const serialized = JSON.stringify(value);
  for (const secret of [...MUST_NOT_SURVIVE, ...extra]) {
    expect(serialized).not.toContain(secret);
  }
}

describe("redactHeaders", () => {
  it("masks authorization across casings and never leaks the key", () => {
    const out = redactor.redactHeaders({
      Authorization: `Bearer ${FAKE_KEY}`,
      AUTHORIZATION: `Bearer ${FAKE_KEY}`,
      authorization: FAKE_KEY,
      "Proxy-Authorization": `Basic ${FAKE_KEY}`,
    });
    expectZeroSurvivals(out);
    expect(out["Authorization"]).toBe("[redacted]");
    expect(out["authorization"]).toBe("[redacted]");
  });

  it("masks key-like header name variants, including array values", () => {
    const out = redactor.redactHeaders({
      "X-Api-Key": FAKE_KEY,
      "x-api-key": FAKE_KEY,
      APIKEY: FAKE_KEY,
      "X-Auth-Token": FAKE_KEY,
      Cookie: `session=${FAKE_KEY}`,
      "Set-Cookie": [`a=${FAKE_KEY}`, "b=2"],
      "x-custom-secret": FAKE_KEY,
    });
    expectZeroSurvivals(out);
    expect(out["Set-Cookie"]).toEqual(["[redacted]", "[redacted]"]);
  });

  it("keeps safe headers and scrubs the key from non-sensitive values", () => {
    const out = redactor.redactHeaders({
      "Content-Type": "application/json",
      "Idempotency-Key": "run-20260707T120000Z-a-ab12-1",
      "X-Debug-Echo": `oops ${FAKE_KEY} leaked`,
      "Content-Length": 42,
    });
    expect(out["Content-Type"]).toBe("application/json");
    expect(out["Idempotency-Key"]).toBe("run-20260707T120000Z-a-ab12-1");
    expect(out["X-Debug-Echo"]).toBe("oops [redacted] leaked");
    expect(out["Content-Length"]).toBe(42);
    expectZeroSurvivals(out);
  });
});

describe("redactString", () => {
  it("masks the constructed key in plain strings, URLs, and query params", () => {
    expect(redactor.redactString(`key is ${FAKE_KEY}!`)).toBe(
      "key is [redacted]!",
    );
    expect(
      redactor.redactString(
        `https://sandbox.straddle.io/v1/customers?api_key=${FAKE_KEY}&page=1`,
      ),
    ).toBe("https://sandbox.straddle.io/v1/customers?api_key=[redacted]&page=1");
    expect(redactor.redactString(`?token=${FAKE_KEY}#frag`)).toBe(
      "?token=[redacted]#frag",
    );
  });

  it("masks sk_ tokens even when they differ from the constructed key", () => {
    expect(redactor.redactString("echo sk_sandbox_OTHER_key_9999 end")).toBe(
      "echo [redacted] end",
    );
  });

  it("masks any bearer credential", () => {
    expect(redactor.redactString("Bearer some.other-token=")).toBe(
      "Bearer [redacted]",
    );
  });

  it("masks paykey-token-shaped values in free text", () => {
    const out = redactor.redactString(`token ${FAKE_PAYKEY_TOKEN} echoed`);
    expect(out).toBe("token [redacted] echoed");
  });

  it("masks seeded bank constants inside strings (error-echo defense)", () => {
    const out = redactor.redactString(
      `Account ${SEEDED_BANK.blocked_account_number} at routing ` +
        `${SEEDED_BANK.routing_number} has been blocked due to return code R05`,
    );
    expect(out).toBe(
      "Account •••6789 at routing •••0021 has been blocked due to return code R05",
    );
    expectZeroSurvivals(out);
  });

  it("masks the URL-encoded form of the key", () => {
    const weird = createRedactor({ apiKey: "sk sandbox/FAKE+key" });
    expect(weird.redactString(encodeURIComponent("sk sandbox/FAKE+key"))).toBe(
      "[redacted]",
    );
  });

  it("handles a missing apiKey without throwing", () => {
    const keyless = createRedactor({});
    expect(keyless.redactString("hello")).toBe("hello");
    // Generic patterns still apply without a constructed key.
    expect(keyless.redactString(FAKE_KEY)).toBe("[redacted]");
  });
});

describe("redactValue / redactBody — field-name masking at any depth", () => {
  it("masks account/routing fields keep-last-4 in a bridge create request", () => {
    const body = {
      customer_id: "0197a1b2-fake",
      routing_number: FAKE_ROUTING,
      account_number: FAKE_ACCOUNT,
      account_type: "checking",
      config: { sandbox_outcome: "active" },
      external_id: "run-20260707T120000Z-a-ab12",
    };
    const out = redactor.redactValue(body) as typeof body;
    expect(out.routing_number).toBe("•••8777");
    expect(out.account_number).toBe("•••1222");
    expect(out.account_type).toBe("checking");
    expect(out.external_id).toBe("run-20260707T120000Z-a-ab12");
    expect(JSON.stringify(out)).not.toContain(FAKE_ACCOUNT);
    expect(JSON.stringify(out)).not.toContain(FAKE_ROUTING);
  });

  it("fully masks account-like values too short for last-4", () => {
    const out = redactor.redactValue({ account_number: "6789" }) as {
      account_number: string;
    };
    expect(out.account_number).toBe("[redacted]");
  });

  it("masks non-string values under account-like field names", () => {
    const out = redactor.redactValue({ account_number: 987654321 }) as {
      account_number: unknown;
    };
    expect(out.account_number).toBe("[redacted]");
  });

  it("masks the paykey token and unmasked routing in a bridge create response", () => {
    const response = {
      data: {
        id: "0197a1b2-fake",
        paykey: FAKE_PAYKEY_TOKEN,
        customer_id: "0197a1b2-cust",
        label: "JPMORGAN CHASE BANK, NA - *6789",
        institution_name: "JPMORGAN CHASE BANK, NA",
        status: "active",
        bank_data: {
          routing_number: SEEDED_BANK.routing_number, // returned UNMASKED live
          account_number: "*****6789", // server-masked already
          account_type: "checking",
        },
      },
      meta: { api_request_id: "req-fake-1" },
      response_type: "object",
    };
    const out = redactor.redactValue(response) as typeof response;
    expect(out.data.paykey).toBe("[redacted]");
    expect(out.data.bank_data.routing_number).toBe("•••0021");
    expect(out.data.bank_data.account_number).toBe("•••6789");
    // Explicitly safe fields survive (api-notes §11).
    expect(out.data.label).toBe("JPMORGAN CHASE BANK, NA - *6789");
    expect(out.data.institution_name).toBe("JPMORGAN CHASE BANK, NA");
    expectZeroSurvivals(out);
  });

  it("masks PII fields and metadata leaves in a customer create body", () => {
    const body = {
      name: "Test Person",
      type: "individual",
      email: "test.person@example.com",
      phone: "+15550001234",
      device: { ip_address: "203.0.113.7" },
      address: {
        address1: "1 Fake St",
        address2: "Apt 2",
        city: "Faketown",
        state: "CA",
        zip: "90000",
      },
      compliance_profile: {
        ssn: "000-00-0000",
        ein: "00-0000000",
        dob: "1990-01-01",
        legal_business_name: "Fake LLC",
        website: "https://fake.example.com",
        representatives: [
          { name: "Rep One", email: "rep@example.com", phone: "+15550009999" },
        ],
      },
      config: { sandbox_outcome: "verified" },
      external_id: "run-20260707T120000Z-a-ab12",
      metadata: { note: "user supplied secret-ish", nested: { deep: "value" } },
    };
    const out = redactor.redactValue(body) as Record<string, unknown>;
    expect(out["name"]).toBe("[redacted]");
    expect(out["email"]).toBe("[redacted]");
    expect(out["phone"]).toBe("[redacted]");
    expect((out["device"] as Record<string, unknown>)["ip_address"]).toBe(
      "[redacted]",
    );
    const address = out["address"] as Record<string, unknown>;
    for (const k of ["address1", "address2", "city", "state", "zip"]) {
      expect(address[k]).toBe("[redacted]");
    }
    const profile = out["compliance_profile"] as Record<string, unknown>;
    for (const k of ["ssn", "ein", "dob", "legal_business_name", "website"]) {
      expect(profile[k]).toBe("[redacted]");
    }
    const rep = (profile["representatives"] as Record<string, unknown>[])[0]!;
    expect(rep["name"]).toBe("[redacted]");
    expect(rep["email"]).toBe("[redacted]");
    expect(rep["phone"]).toBe("[redacted]");
    // metadata: keys/structure preserved, every leaf masked.
    expect(out["metadata"]).toEqual({
      note: "[redacted]",
      nested: { deep: "[redacted]" },
    });
    // Non-sensitive fields survive untouched.
    expect(out["type"]).toBe("individual");
    expect(out["external_id"]).toBe("run-20260707T120000Z-a-ab12");
    const serialized = JSON.stringify(out);
    for (const pii of [
      "Test Person",
      "test.person@example.com",
      "+15550001234",
      "203.0.113.7",
      "000-00-0000",
      "user supplied secret-ish",
    ]) {
      expect(serialized).not.toContain(pii);
    }
  });

  it("masks fields by name inside arrays (charge GET customer_details, tan)", () => {
    const out = redactor.redactValue([
      { customer_details: { name: "A B", email: "a@b.co", phone: "+1555" } },
      { tan: "123456" },
      { items: [{ account_number: FAKE_ACCOUNT }] },
    ]) as Array<Record<string, unknown>>;
    expect((out[0]!["customer_details"] as Record<string, unknown>)["name"]).toBe(
      "[redacted]",
    );
    expect(out[1]!["tan"]).toBe("[redacted]");
    expect(
      (out[2]!["items"] as Array<Record<string, unknown>>)[0]!["account_number"],
    ).toBe("•••1222");
  });

  it("masks seeded bank constants in bodies even under unlisted field names", () => {
    const out = redactor.redactValue({
      error: {
        status: 422,
        type: "/validation_error",
        title: "Validation Failed",
        detail:
          `This bank account (${SEEDED_BANK.blocked_account_number} / ` +
          `${SEEDED_BANK.routing_number}) has been blocked due to return code R05`,
      },
      free_text: `preferred is ${SEEDED_BANK.preferred_account_number}`,
    });
    expectZeroSurvivals(out);
  });

  it("masks the key inside error echoes and nested strings", () => {
    const out = redactor.redactValue({
      error: {
        detail: `invalid key: ${FAKE_KEY}`,
        request: { url: `https://sandbox.straddle.io/v1/charges?key=${FAKE_KEY}` },
      },
    });
    expectZeroSurvivals(out);
  });

  it("passes through primitives and preserves nulls/booleans/numbers", () => {
    expect(redactor.redactValue(null)).toBeNull();
    expect(redactor.redactValue(42)).toBe(42);
    expect(redactor.redactValue(true)).toBe(true);
    expect(redactor.redactValue(undefined)).toBeUndefined();
    expect(redactor.redactValue({ amount: 10000, ok: false, x: null })).toEqual({
      amount: 10000,
      ok: false,
      x: null,
    });
  });

  it("does not mutate its input (pure)", () => {
    const body = { account_number: FAKE_ACCOUNT, nested: { paykey: "tok" } };
    const snapshot = JSON.parse(JSON.stringify(body)) as unknown;
    redactor.redactValue(body);
    expect(body).toEqual(snapshot);
  });

  it("is deterministic", () => {
    const body = { account_number: FAKE_ACCOUNT, detail: FAKE_KEY };
    expect(redactor.redactValue(body)).toEqual(redactor.redactValue(body));
  });

  it("survives circular structures without throwing", () => {
    type Circ = { a: string; self?: unknown };
    const circ: Circ = { a: FAKE_KEY };
    circ.self = circ;
    const out = redactor.redactValue(circ) as Record<string, unknown>;
    expect(out["a"]).toBe("[redacted]");
    expect(out["self"]).toBe("[circular]");
    // Sibling references (non-circular DAG) are still walked, not dropped.
    const shared = { paykey: "t" };
    const dag = redactor.redactValue({ x: shared, y: shared }) as Record<
      string,
      { paykey: string }
    >;
    expect(dag["x"]!.paykey).toBe("[redacted]");
    expect(dag["y"]!.paykey).toBe("[redacted]");
  });

  it("redactBody is the same deep-walk entry point", () => {
    expect(redactor.redactBody({ paykey: FAKE_PAYKEY_TOKEN })).toEqual({
      paykey: "[redacted]",
    });
  });
});

describe("serialized-event round trip (spec §12)", () => {
  it("a recorded api.exchange-shaped event serializes with zero survivals", () => {
    // Synthetic event mirroring what the Wave-2 client will emit: bodies are
    // passed through redactValue BEFORE the event is constructed.
    const event = {
      type: "api.exchange",
      run_id: "run-20260707T120000Z-c-ab12",
      scenario_id: "c",
      timestamp: "2026-07-07T12:00:00.0000000Z",
      method: "POST",
      path: "/v1/bridge/bank_account",
      status: 201,
      latency_ms: 750,
      attempt: 1,
      request_body: redactor.redactValue({
        customer_id: "0197-fake",
        routing_number: SEEDED_BANK.routing_number,
        account_number: SEEDED_BANK.preferred_account_number,
        account_type: "checking",
        config: { sandbox_outcome: "active" },
      }),
      response_body: redactor.redactValue({
        data: {
          id: "0197-fake-pk",
          paykey: FAKE_PAYKEY_TOKEN,
          label: "JPMORGAN CHASE BANK, NA - *4321",
          bank_data: {
            routing_number: SEEDED_BANK.routing_number,
            account_number: "*****4321",
            account_type: "checking",
          },
        },
        meta: { api_request_id: "req-fake" },
        response_type: "object",
      }),
    };
    // The JSONL recorder writes JSON.stringify(event) — assert on exactly
    // that serialization path.
    const line = JSON.stringify(event);
    for (const secret of MUST_NOT_SURVIVE) {
      expect(line).not.toContain(secret);
    }
    // And a whole-event defensive pass is idempotent: nothing left to find.
    expect(JSON.stringify(redactor.redactValue(event))).toBe(line);
  });
});
