import { describe, expect, it } from "vitest";
import {
  ApiRefusalSchema,
  IdentityReviewSummarySchema,
  ReportSchema,
  StatusTransitionSchema,
  type Report,
} from "./report.js";

describe("StatusTransitionSchema", () => {
  it("accepts a first observation (from: null) with the lenient GET timestamp", () => {
    expect(
      StatusTransitionSchema.safeParse({
        from: null,
        to: "created",
        at: "2026-07-07T06:21:44", // second-precision, no offset — must pass
      }).success,
    ).toBe(true);
  });

  it("accepts terminal transitions with return/reason codes", () => {
    expect(
      StatusTransitionSchema.safeParse({
        from: "pending",
        to: "failed",
        at: "2026-07-07T06:27:31.0210043Z",
        return_code: "R01",
        reason: "insufficient_funds",
      }).success,
    ).toBe(true);
  });

  it("rejects missing from (nullable, not optional) and bad at", () => {
    expect(
      StatusTransitionSchema.safeParse({ to: "paid", at: "2026-07-07T06:21:44" })
        .success,
    ).toBe(false);
    expect(
      StatusTransitionSchema.safeParse({ from: null, to: "paid", at: "soon" })
        .success,
    ).toBe(false);
  });
});

describe("IdentityReviewSummarySchema", () => {
  it("accepts the full shape with per-module scores", () => {
    expect(
      IdentityReviewSummarySchema.safeParse({
        verification_status: "verified",
        risk_score: 0.452,
        correlation_score: 0.99,
        reason_codes: ["I121", "I553"],
      }).success,
    ).toBe(true);
  });

  it("defaults reason_codes to [] and allows scores to be omitted", () => {
    const parsed = IdentityReviewSummarySchema.parse({
      verification_status: "rejected",
    });
    expect(parsed.reason_codes).toEqual([]);
    expect(parsed.risk_score).toBeUndefined();
  });

  it("rejects missing verification_status and non-numeric scores", () => {
    expect(IdentityReviewSummarySchema.safeParse({}).success).toBe(false);
    expect(
      IdentityReviewSummarySchema.safeParse({
        verification_status: "verified",
        risk_score: "low",
      }).success,
    ).toBe(false);
  });
});

describe("ApiRefusalSchema", () => {
  it("accepts the Scenario E refusal shape (verbatim error envelope as body)", () => {
    expect(
      ApiRefusalSchema.safeParse({
        attempted_action: "create_paykey",
        http_status: 422,
        error_body: {
          error: {
            status: 422,
            type: "/validation_error",
            title: "Validation Failed",
            detail: "Cannot create paykey as customer is rejected.",
          },
          response_type: "error",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects actions outside the enum", () => {
    expect(
      ApiRefusalSchema.safeParse({
        attempted_action: "delete_customer",
        http_status: 422,
        error_body: {},
      }).success,
    ).toBe(false);
  });
});

const validReport: Report = {
  generated_at: "2026-07-07T06:30:00.1234567Z",
  suite: {
    status: "partial",
    duration_ms: 351_000,
    covered_scenarios: ["c"],
  },
  scenarios: [
    {
      id: "c",
      name: "Reversal",
      status: "failed",
      resource_ids: {
        customer: "0197e5b3-fake-cust",
        paykey: "0197e5b3-fake-pk",
        charge: "0197e5b3-fake-chg",
      },
      transitions: [
        { from: null, to: "created", at: "2026-07-07T06:21:44" },
        { from: "created", to: "scheduled", at: "2026-07-07T06:21:46.6000000Z" },
        {
          from: "pending",
          to: "failed",
          at: "2026-07-07T06:27:35.0000000Z",
          return_code: "R01",
          reason: "insufficient_funds",
        },
      ],
      final_status: "failed",
      return_code: "R01",
      reason_code: "insufficient_funds",
      identity_review: {
        verification_status: "verified",
        risk_score: 0.01,
        correlation_score: 0.99,
        reason_codes: ["I121"],
      },
      recording_path: "runs/run-20260707T062143Z-c-9f3a.jsonl",
      duration_ms: 351_000,
      diagnostics: ["terminal reversed-style failed observed without prior paid"],
    },
  ],
};

describe("ReportSchema", () => {
  it("accepts a full valid report", () => {
    expect(ReportSchema.safeParse(validReport).success).toBe(true);
  });

  it("accepts a scenario without optional evidence (refusal, review, codes)", () => {
    const scenario = validReport.scenarios[0]!;
    const minimal = {
      ...validReport,
      scenarios: [
        {
          id: scenario.id,
          name: scenario.name,
          status: "partial", // interrupted before run.completed
          resource_ids: {},
          transitions: [],
          recording_path: scenario.recording_path,
          duration_ms: 0,
          diagnostics: [],
        },
      ],
    };
    expect(ReportSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects unknown suite status, bad scenario id, missing recording_path", () => {
    expect(
      ReportSchema.safeParse({
        ...validReport,
        suite: { ...validReport.suite, status: "running" }, // removed in spec v2
      }).success,
    ).toBe(false);
    expect(
      ReportSchema.safeParse({
        ...validReport,
        suite: { ...validReport.suite, covered_scenarios: ["z"] },
      }).success,
    ).toBe(false);
    const scenario = validReport.scenarios[0]!;
    const { recording_path: _rp, ...noPath } = scenario;
    expect(
      ReportSchema.safeParse({ ...validReport, scenarios: [noPath] }).success,
    ).toBe(false);
  });

  it("rejects non-string values in resource_ids", () => {
    const scenario = validReport.scenarios[0]!;
    expect(
      ReportSchema.safeParse({
        ...validReport,
        scenarios: [{ ...scenario, resource_ids: { charge: 42 } }],
      }).success,
    ).toBe(false);
  });
});
