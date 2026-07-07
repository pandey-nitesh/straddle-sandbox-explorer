import { describe, expect, it } from "vitest";
import { evaluateScenario } from "./evaluator.js";
import { requireScenario } from "./scenarios.js";

describe("evaluator", () => {
  it("passes B only when terminal failed carries R01", () => {
    const result = evaluateScenario(requireScenario("b"), {
      transitions: [
        { from: null, to: "created", at: "2026-07-07T00:00:00Z" },
        {
          from: "pending",
          to: "failed",
          at: "2026-07-07T00:02:00Z",
          return_code: "R01",
          reason: "insufficient_funds",
        },
      ],
    });

    expect(result.passed).toBe(true);
  });

  it("fails C loudly when reversed appears without paid", () => {
    const result = evaluateScenario(requireScenario("c"), {
      transitions: [
        { from: null, to: "created", at: "2026-07-07T00:00:00Z" },
        { from: "pending", to: "reversed", at: "2026-07-07T00:05:00Z" },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.diagnostics.join("\n")).toMatch(/reversed without a prior paid/i);
  });

  it("requires both rejected review and API refusal for E", () => {
    const result = evaluateScenario(requireScenario("e"), {
      transitions: [],
      identityReview: {
        verification_status: "rejected",
        reason_codes: [],
      },
      refusal: {
        attempted_action: "create_paykey",
        http_status: 422,
        error_body: { error: { detail: "Cannot create paykey as customer is rejected." } },
      },
    });

    expect(result.passed).toBe(true);
  });

  it("rejects generic validation 422s as E refusal evidence", () => {
    const result = evaluateScenario(requireScenario("e"), {
      transitions: [],
      identityReview: {
        verification_status: "rejected",
        reason_codes: [],
      },
      refusal: {
        attempted_action: "create_paykey",
        http_status: 422,
        error_body: {
          error: {
            detail: "Missing account number.",
            items: [{ reference: "account_number", detail: "Required." }],
          },
        },
      },
    });

    expect(result.passed).toBe(false);
    expect(result.diagnostics.join("\n")).toMatch(/rejected-customer 422/);
  });
});
