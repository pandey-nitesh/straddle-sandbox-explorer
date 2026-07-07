import type {
  ApiRefusal,
  IdentityReviewSummary,
  RequiredObservation,
  StatusTransition,
} from "@sse/shared";
import type { EventBus } from "./bus.js";
import type { RunnableScenarioDef } from "./scenarios.js";

export interface EvaluationEvidence {
  transitions: StatusTransition[];
  identityReview?: IdentityReviewSummary;
  refusal?: ApiRefusal;
  diagnostics?: readonly string[];
}

export interface AssertionResult {
  observation: RequiredObservation;
  pass: boolean;
  diagnostic?: string;
}

export interface EvaluationResult {
  passed: boolean;
  assertions: AssertionResult[];
  diagnostics: string[];
}

export function evaluateScenario(
  scenario: RunnableScenarioDef,
  evidence: EvaluationEvidence,
): EvaluationResult {
  const assertions = scenario.requiredObservations.map((observation) =>
    evaluateObservation(observation, evidence),
  );
  const diagnostics = [
    ...assertions.flatMap((a) => (a.diagnostic === undefined ? [] : [a.diagnostic])),
    ...(evidence.diagnostics ?? []),
  ];
  return {
    passed: assertions.every((a) => a.pass) && (evidence.diagnostics?.length ?? 0) === 0,
    assertions,
    diagnostics,
  };
}

export function emitAssertions(args: {
  bus: EventBus;
  run_id: string;
  scenario: RunnableScenarioDef;
  result: EvaluationResult;
}): void {
  for (const assertion of args.result.assertions) {
    args.bus.emit({
      type: "scenario.assertion",
      run_id: args.run_id,
      scenario_id: args.scenario.id,
      kind: assertion.observation.kind,
      pass: assertion.pass,
      ...(assertion.diagnostic !== undefined
        ? { diagnostic: assertion.diagnostic }
        : {}),
    });
  }
}

function evaluateObservation(
  observation: RequiredObservation,
  evidence: EvaluationEvidence,
): AssertionResult {
  switch (observation.kind) {
    case "terminal_status":
      return evaluateTerminalStatus(observation, evidence.transitions);
    case "ordered_statuses":
      return evaluateOrderedStatuses(observation, evidence.transitions);
    case "customer_review":
      return evaluateCustomerReview(observation, evidence.identityReview);
    case "api_refusal":
      return evaluateRefusal(observation, evidence.refusal);
  }
}

function evaluateTerminalStatus(
  observation: Extract<RequiredObservation, { kind: "terminal_status" }>,
  transitions: StatusTransition[],
): AssertionResult {
  const terminal = transitions.at(-1);
  if (terminal === undefined) {
    return {
      observation,
      pass: false,
      diagnostic: `expected terminal status ${observation.status}, observed no payment statuses`,
    };
  }
  if (terminal.to !== observation.status) {
    return {
      observation,
      pass: false,
      diagnostic: `expected terminal status ${observation.status}, observed ${terminal.to}`,
    };
  }
  if (
    observation.returnCode !== undefined &&
    terminal.return_code !== observation.returnCode
  ) {
    return {
      observation,
      pass: false,
      diagnostic: `expected return code ${observation.returnCode}, observed ${terminal.return_code ?? "none"}`,
    };
  }
  if (
    observation.requireReasonDetail === true &&
    (terminal.reason === undefined || terminal.reason.trim() === "")
  ) {
    return {
      observation,
      pass: false,
      diagnostic: `expected reason detail for terminal status ${observation.status}`,
    };
  }
  return { observation, pass: true };
}

function evaluateOrderedStatuses(
  observation: Extract<RequiredObservation, { kind: "ordered_statuses" }>,
  transitions: StatusTransition[],
): AssertionResult {
  const statuses = transitions.map((t) => t.to);
  let cursor = 0;
  for (const status of statuses) {
    if (status === observation.statuses[cursor]) cursor += 1;
    if (cursor === observation.statuses.length) return { observation, pass: true };
  }

  if (observation.statuses.includes("paid") && statuses.at(-1) === "reversed") {
    return {
      observation,
      pass: false,
      diagnostic:
        "observed reversed without a prior paid status; Scenario C requires paid before reversed",
    };
  }
  return {
    observation,
    pass: false,
    diagnostic: `expected statuses ${observation.statuses.join(" -> ")}, observed ${statuses.join(" -> ") || "none"}`,
  };
}

function evaluateCustomerReview(
  observation: Extract<RequiredObservation, { kind: "customer_review" }>,
  review: IdentityReviewSummary | undefined,
): AssertionResult {
  if (review?.verification_status === observation.status) {
    return { observation, pass: true };
  }
  return {
    observation,
    pass: false,
    diagnostic: `expected customer review ${observation.status}, observed ${review?.verification_status ?? "none"}`,
  };
}

function evaluateRefusal(
  observation: Extract<RequiredObservation, { kind: "api_refusal" }>,
  refusal: ApiRefusal | undefined,
): AssertionResult {
  if (refusal?.attempted_action !== observation.afterAction) {
    return {
      observation,
      pass: false,
      diagnostic: `expected API refusal after ${observation.afterAction}`,
    };
  }
  if (observation.afterAction === "create_paykey" && isRejectedCustomer422(refusal)) {
    return { observation, pass: true };
  }
  if (observation.afterAction === "create_charge" && refusal.http_status >= 400) {
    return { observation, pass: true };
  }
  return {
    observation,
    pass: false,
    diagnostic:
      "expected create_paykey refusal to be the rejected-customer 422 shape",
  };
}

function isRejectedCustomer422(refusal: ApiRefusal): boolean {
  if (refusal.http_status !== 422) return false;
  const body = asRecord(refusal.error_body);
  const error = asRecord(body.error);
  if ("items" in error) return false;
  return (
    typeof error.detail === "string" && /customer is rejected/i.test(error.detail)
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
