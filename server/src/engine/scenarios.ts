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

/**
 * Spec §18.1/§18.8: the live sandbox never surfaces `reversed` (C) or
 * `cancelled` (D) — those PRD terminals exist only in the mock/replay
 * "contract" mode. "live" mode swaps C and D for defs asserting the
 * documented deviation evidence: C = terminal `failed` + the reversal's
 * R-code (the ~4-minute reversal window stays visible in transition
 * timestamps); D = terminal `failed` + watchtower's structured reason
 * detail (`payment_blocked`, ~7 s).
 */
export type ScenarioMode = "contract" | "live";

const SCENARIO_C_LIVE = ScenarioDefSchema.parse({
  id: "c",
  label: "C. Reversal",
  purpose:
    "Live deviation evidence: failed with the reversal R-code after the ~4-minute reversal window (spec §18.1).",
  outcomes: {
    customer: "verified",
    paykey: "active",
    charge: "reversed_insufficient_funds",
  },
  requiredObservations: [
    { kind: "terminal_status", status: "failed", returnCode: "R01" },
  ],
}) as RunnableScenarioDef;

const SCENARIO_D_LIVE = ScenarioDefSchema.parse({
  id: "d",
  label: "D. Risk cancellation",
  purpose:
    "Live deviation evidence: watchtower blocks the charge as failed with structured reason detail (spec §18.8).",
  outcomes: {
    customer: "verified",
    paykey: "active",
    charge: "cancelled_for_fraud_risk",
  },
  requiredObservations: [
    { kind: "terminal_status", status: "failed", requireReasonDetail: true },
  ],
}) as RunnableScenarioDef;

const scenarioMap = new Map<RunnableScenarioId, RunnableScenarioDef>(
  RUNNABLE_SCENARIOS.map((scenario) => [
    scenario.id,
    ScenarioDefSchema.parse(scenario) as RunnableScenarioDef,
  ]),
);

export function getScenario(
  id: ScenarioId,
  mode: ScenarioMode = "contract",
): RunnableScenarioDef | undefined {
  if (id === "c" && mode === "live") return SCENARIO_C_LIVE;
  if (id === "d" && mode === "live") return SCENARIO_D_LIVE;
  return scenarioMap.get(id as RunnableScenarioId);
}

export function requireScenario(
  id: ScenarioId,
  mode: ScenarioMode = "contract",
): RunnableScenarioDef {
  const scenario = getScenario(id, mode);
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
