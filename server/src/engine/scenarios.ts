import type { ScenarioDef, ScenarioId } from "@sse/shared";
import { ScenarioDefSchema } from "@sse/shared";
import type {
  ChargeSandboxOutcome,
  CustomerSandboxOutcome,
  PaykeySandboxOutcome,
} from "../straddle/types.js";

export type RunnableScenarioId = Extract<ScenarioId, "a" | "b" | "c" | "d" | "e">;

export interface RunnableScenarioDef extends ScenarioDef {
  id: RunnableScenarioId;
  outcomes: {
    customer: CustomerSandboxOutcome;
    paykey?: PaykeySandboxOutcome;
    charge?: ChargeSandboxOutcome;
  };
}

export const RUNNABLE_SCENARIOS = [
  {
    id: "a",
    label: "A. Happy path",
    purpose: "Verified customer, active paykey, paid charge.",
    outcomes: { customer: "verified", paykey: "active", charge: "paid" },
    requiredObservations: [{ kind: "terminal_status", status: "paid" }],
  },
  {
    id: "b",
    label: "B. Insufficient funds",
    purpose: "Verified customer with an R01 bank-decline failure.",
    outcomes: {
      customer: "verified",
      paykey: "active",
      charge: "failed_insufficient_funds",
    },
    requiredObservations: [
      { kind: "terminal_status", status: "failed", returnCode: "R01" },
    ],
  },
  {
    id: "c",
    label: "C. Reversal",
    purpose: "Mock/replay reversal evidence: paid before reversed.",
    outcomes: {
      customer: "verified",
      paykey: "active",
      charge: "reversed_insufficient_funds",
    },
    requiredObservations: [
      { kind: "ordered_statuses", statuses: ["paid", "reversed"] },
    ],
  },
  {
    id: "d",
    label: "D. Risk cancellation",
    purpose: "Charge cancelled with structured reason detail.",
    outcomes: {
      customer: "verified",
      paykey: "active",
      charge: "cancelled_for_fraud_risk",
    },
    requiredObservations: [
      {
        kind: "terminal_status",
        status: "cancelled",
        requireReasonDetail: true,
      },
    ],
  },
  {
    id: "e",
    label: "E. Rejected identity",
    purpose: "Rejected customer blocks downstream paykey creation.",
    outcomes: { customer: "rejected", paykey: "active" },
    requiredObservations: [
      { kind: "customer_review", status: "rejected" },
      { kind: "api_refusal", afterAction: "create_paykey" },
    ],
  },
] as const satisfies readonly RunnableScenarioDef[];

export const RUNNABLE_SCENARIO_IDS = RUNNABLE_SCENARIOS.map((s) => s.id);

const scenarioMap = new Map<RunnableScenarioId, RunnableScenarioDef>(
  RUNNABLE_SCENARIOS.map((scenario) => [
    scenario.id,
    ScenarioDefSchema.parse(scenario) as RunnableScenarioDef,
  ]),
);

export function getScenario(id: ScenarioId): RunnableScenarioDef | undefined {
  return scenarioMap.get(id as RunnableScenarioId);
}

export function requireScenario(id: ScenarioId): RunnableScenarioDef {
  const scenario = getScenario(id);
  if (scenario === undefined) {
    throw new Error(`Scenario ${id} is not runnable in P0`);
  }
  return scenario;
}

export function parseScenarioSelection(args: {
  all?: boolean;
  scenarios?: readonly string[];
}): RunnableScenarioId[] {
  if (args.all || args.scenarios === undefined || args.scenarios.length === 0) {
    return [...RUNNABLE_SCENARIO_IDS];
  }
  const selected: RunnableScenarioId[] = [];
  for (const raw of args.scenarios) {
    const id = raw.toLowerCase() as ScenarioId;
    const scenario = getScenario(id);
    if (scenario === undefined) {
      throw new Error(`Unknown runnable scenario: ${raw}`);
    }
    if (!selected.includes(scenario.id)) selected.push(scenario.id);
  }
  return selected;
}
