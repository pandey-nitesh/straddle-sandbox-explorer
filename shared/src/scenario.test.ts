import { describe, expect, it } from "vitest";
import {
  RequiredObservationKindSchema,
  RequiredObservationSchema,
  ScenarioDefSchema,
  ScenarioIdSchema,
  expectsReversal,
  type ScenarioDef,
} from "./scenario.js";

describe("ScenarioIdSchema", () => {
  it("accepts the full planned set a–i", () => {
    for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) {
      expect(ScenarioIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it("rejects unknown ids and wrong case", () => {
    for (const id of ["j", "A", "", "aa", 1]) {
      expect(ScenarioIdSchema.safeParse(id).success, String(id)).toBe(false);
    }
  });
});

describe("RequiredObservationSchema — every kind, valid and malformed", () => {
  it("terminal_status: accepts minimal and fully-optioned forms", () => {
    expect(
      RequiredObservationSchema.safeParse({
        kind: "terminal_status",
        status: "paid",
      }).success,
    ).toBe(true);
    expect(
      RequiredObservationSchema.safeParse({
        kind: "terminal_status",
        status: "failed",
        returnCode: "R01",
        requireReasonDetail: true,
      }).success,
    ).toBe(true);
  });

  it("terminal_status: rejects missing status and wrongly-typed options", () => {
    expect(
      RequiredObservationSchema.safeParse({ kind: "terminal_status" }).success,
    ).toBe(false);
    expect(
      RequiredObservationSchema.safeParse({
        kind: "terminal_status",
        status: "failed",
        returnCode: 1,
      }).success,
    ).toBe(false);
    expect(
      RequiredObservationSchema.safeParse({
        kind: "terminal_status",
        status: "cancelled",
        requireReasonDetail: "yes",
      }).success,
    ).toBe(false);
  });

  it("ordered_statuses: accepts >= 2 statuses, rejects fewer", () => {
    expect(
      RequiredObservationSchema.safeParse({
        kind: "ordered_statuses",
        statuses: ["paid", "reversed"],
      }).success,
    ).toBe(true);
    expect(
      RequiredObservationSchema.safeParse({
        kind: "ordered_statuses",
        statuses: ["paid"],
      }).success,
    ).toBe(false);
    expect(
      RequiredObservationSchema.safeParse({
        kind: "ordered_statuses",
        statuses: [],
      }).success,
    ).toBe(false);
  });

  it("customer_review: accepts a status string, rejects its absence", () => {
    expect(
      RequiredObservationSchema.safeParse({
        kind: "customer_review",
        status: "rejected",
      }).success,
    ).toBe(true);
    expect(
      RequiredObservationSchema.safeParse({ kind: "customer_review" }).success,
    ).toBe(false);
  });

  it("api_refusal: accepts both enum actions, rejects others", () => {
    expect(
      RequiredObservationSchema.safeParse({
        kind: "api_refusal",
        afterAction: "create_paykey", // M0's pick (api-notes §10)
      }).success,
    ).toBe(true);
    expect(
      RequiredObservationSchema.safeParse({
        kind: "api_refusal",
        afterAction: "create_charge",
      }).success,
    ).toBe(true);
    expect(
      RequiredObservationSchema.safeParse({
        kind: "api_refusal",
        afterAction: "create_customer",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown kinds and missing discriminator", () => {
    expect(
      RequiredObservationSchema.safeParse({ kind: "nonsense" }).success,
    ).toBe(false);
    expect(RequiredObservationSchema.safeParse({}).success).toBe(false);
  });

  it("kind enum stays in lockstep with the union's discriminator literals", () => {
    const unionKinds = RequiredObservationSchema.options
      .map((o) => o.shape.kind.value)
      .sort();
    expect([...RequiredObservationKindSchema.options].sort()).toEqual(
      unionKinds,
    );
  });
});

const scenarioC: ScenarioDef = {
  id: "c",
  label: "Reversal",
  purpose: "Watch a payment settle and then un-settle.",
  outcomes: {
    customer: "verified",
    paykey: "active",
    charge: "reversed_insufficient_funds",
  },
  requiredObservations: [
    { kind: "ordered_statuses", statuses: ["paid", "reversed"] },
  ],
};

describe("ScenarioDefSchema", () => {
  it("accepts a full scenario definition", () => {
    expect(ScenarioDefSchema.safeParse(scenarioC).success).toBe(true);
  });

  it("accepts partial outcomes (Scenario E has no charge outcome)", () => {
    expect(
      ScenarioDefSchema.safeParse({
        id: "e",
        label: "Rejected identity",
        purpose: "Rejected review blocks downstream actions.",
        outcomes: { customer: "rejected" },
        requiredObservations: [
          { kind: "customer_review", status: "rejected" },
          { kind: "api_refusal", afterAction: "create_paykey" },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects an empty requiredObservations array", () => {
    expect(
      ScenarioDefSchema.safeParse({ ...scenarioC, requiredObservations: [] })
        .success,
    ).toBe(false);
  });

  it("rejects missing outcomes object and bad id", () => {
    const { outcomes: _outcomes, ...noOutcomes } = scenarioC;
    expect(ScenarioDefSchema.safeParse(noOutcomes).success).toBe(false);
    expect(
      ScenarioDefSchema.safeParse({ ...scenarioC, id: "z" }).success,
    ).toBe(false);
  });
});

describe("expectsReversal (derived, not stored)", () => {
  it("true when an ordered_statuses observation includes reversed", () => {
    expect(expectsReversal(scenarioC)).toBe(true);
  });

  it("false for terminal-status-only scenarios", () => {
    expect(
      expectsReversal({
        ...scenarioC,
        id: "a",
        requiredObservations: [{ kind: "terminal_status", status: "paid" }],
      }),
    ).toBe(false);
  });

  it('false when "reversed" appears only as a terminal_status, not ordered', () => {
    expect(
      expectsReversal({
        ...scenarioC,
        requiredObservations: [
          { kind: "terminal_status", status: "reversed" },
          { kind: "ordered_statuses", statuses: ["created", "paid"] },
        ],
      }),
    ).toBe(false);
  });
});
