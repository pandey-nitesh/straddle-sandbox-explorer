import type { ScenarioDef, ScenarioId } from "@sse/shared";
import { ScenarioDefSchema } from "@sse/shared";
import type {
  ChargeSandboxOutcome,
  CustomerSandboxOutcome,
  PaykeySandboxOutcome,
} from "../straddle/types.js";

export type RunnableScenarioId = Extract<
  ScenarioId,
  "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i"
>;

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
    flow: [
      "Create a verified sandbox customer.",
      "Create an active bank-account paykey for that customer.",
      "Create a charge with the paid outcome and watch it settle successfully.",
    ],
    outcomes: { customer: "verified", paykey: "active", charge: "paid" },
    requiredObservations: [{ kind: "terminal_status", status: "paid" }],
  },
  {
    id: "b",
    label: "B. Insufficient funds",
    purpose: "Verified customer with an R01 bank-decline failure.",
    flow: [
      "Create a verified customer and active paykey.",
      "Create a charge using the insufficient-funds sandbox outcome.",
      "Poll the charge until the bank decline appears as failed with return code R01.",
    ],
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
    flow: [
      "Create a verified customer and active paykey.",
      "Create a charge using the reversal sandbox outcome.",
      "In mock and replay mode, observe paid first and then reversed so the reversal order is explicit.",
    ],
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
    flow: [
      "Create a verified customer and active paykey.",
      "Create a charge using the fraud-risk cancellation outcome.",
      "Observe the terminal cancellation and keep the structured reason detail as evidence.",
    ],
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
    flow: [
      "Create a customer with the rejected identity sandbox outcome.",
      "Capture the rejected review status and identity evidence.",
      "Attempt paykey creation anyway and preserve the API refusal body as proof of the block.",
    ],
    outcomes: { customer: "rejected", paykey: "active" },
    requiredObservations: [
      { kind: "customer_review", status: "rejected" },
      { kind: "api_refusal", afterAction: "create_paykey" },
    ],
  },
  {
    id: "f",
    label: "F. Closed-account decline",
    purpose: "Verified customer with an R02 closed-bank-account failure.",
    flow: [
      "Create a verified customer and active paykey.",
      "Create a charge using the closed-bank-account sandbox outcome.",
      "Poll the charge until the bank decline appears as failed with return code R02.",
    ],
    outcomes: {
      customer: "verified",
      paykey: "active",
      charge: "failed_closed_bank_account",
    },
    // Deterministic — identical evidence for contract and live (api-notes §P14).
    requiredObservations: [
      { kind: "terminal_status", status: "failed", returnCode: "R02" },
    ],
  },
  {
    id: "g",
    label: "G. Closed-account reversal",
    purpose: "Mock/replay reversal evidence with the R02 closed-account code.",
    flow: [
      "Create a verified customer and active paykey.",
      "Create a charge using the closed-account reversal sandbox outcome.",
      "In mock and replay mode, observe paid first and then reversed so the reversal order is explicit.",
    ],
    outcomes: {
      customer: "verified",
      paykey: "active",
      charge: "reversed_closed_bank_account",
    },
    requiredObservations: [
      { kind: "ordered_statuses", statuses: ["paid", "reversed"] },
    ],
  },
  {
    id: "h",
    label: "H. Hold and release",
    purpose: "Manually hold a charge, then release it to settle as paid.",
    flow: [
      "Create a verified customer and active paykey.",
      "Create a charge with the paid outcome, then hold it and observe on_hold.",
      "Release the hold and poll the resumed charge until it settles as paid.",
    ],
    outcomes: { customer: "verified", paykey: "active", charge: "paid" },
    // Both modes: hold/release verified live (api-notes §P11).
    requiredObservations: [
      { kind: "ordered_statuses", statuses: ["on_hold", "paid"] },
    ],
  },
  {
    id: "i",
    label: "I. Manual cancel",
    purpose: "Manually cancel a pre-terminal charge into a real cancelled status.",
    flow: [
      "Create a verified customer and active paykey.",
      "Create a charge that stays pre-terminal awaiting the ACH network.",
      "Cancel the charge and observe the terminal cancelled status the action produces.",
    ],
    // "standard" charges stall pre-terminal (api-notes §P14); the cancel ACTION
    // is the sole terminator — no sandbox_outcome reaches `cancelled` (§18.8).
    outcomes: { customer: "verified", paykey: "active", charge: "standard" },
    // Both modes: manual cancel is a real terminal `cancelled` (api-notes §12.19).
    requiredObservations: [{ kind: "terminal_status", status: "cancelled" }],
  },
] as const satisfies readonly RunnableScenarioDef[];

/** Every scenario the registry can run (a–i after P2-2). */
export const RUNNABLE_SCENARIO_IDS = RUNNABLE_SCENARIOS.map((s) => s.id);

/**
 * The REQUIRED acceptance suite (spec §5): `suite.status` is `passed` iff all of
 * A–E are covered and passed. Deliberately DISTINCT from the larger runnable set
 * — F/G/H/I are runnable and reportable but never gate the required suite, so a
 * report over only A–E still reads `passed` and a report missing F/G/H/I is not
 * `partial`. This is also the default selection (`--all` / an empty POST body).
 */
export const REQUIRED_SCENARIO_IDS = [
  "a",
  "b",
  "c",
  "d",
  "e",
] as const satisfies readonly RunnableScenarioId[];

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
  flow: [
    "Create a verified customer and active paykey.",
    "Create a charge using the reversal sandbox outcome.",
    "In live mode, the sandbox reports the documented deviation: terminal failed with R01 after the reversal window.",
  ],
  outcomes: {
    customer: "verified",
    paykey: "active",
    charge: "reversed_insufficient_funds",
  },
  requiredObservations: [
    { kind: "terminal_status", status: "failed", returnCode: "R01" },
  ],
}) as RunnableScenarioDef;

const SCENARIO_G_LIVE = ScenarioDefSchema.parse({
  id: "g",
  label: "G. Closed-account reversal",
  purpose:
    "Live deviation evidence: failed with the R02 closed-account code after the reversal window (spec §18.1 / api-notes §P14).",
  flow: [
    "Create a verified customer and active paykey.",
    "Create a charge using the closed-account reversal sandbox outcome.",
    "In live mode, the sandbox reports the documented deviation: terminal failed with R02 after the reversal window; paid/reversed never surface.",
  ],
  outcomes: {
    customer: "verified",
    paykey: "active",
    charge: "reversed_closed_bank_account",
  },
  requiredObservations: [
    { kind: "terminal_status", status: "failed", returnCode: "R02" },
  ],
}) as RunnableScenarioDef;

const SCENARIO_D_LIVE = ScenarioDefSchema.parse({
  id: "d",
  label: "D. Risk cancellation",
  purpose:
    "Live deviation evidence: watchtower blocks the charge as failed with structured reason detail (spec §18.8).",
  flow: [
    "Create a verified customer and active paykey.",
    "Create a charge using the fraud-risk cancellation outcome.",
    "In live mode, watchtower reports the documented deviation: failed with structured risk detail.",
  ],
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
  if (id === "g" && mode === "live") return SCENARIO_G_LIVE;
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
    // Default / `--all` stays the REQUIRED acceptance suite (A–E). F/G/H/I are
    // runnable only when named explicitly, so the ~15-min budget and the
    // browser Run All target are unchanged; the report suite gate is A–E too.
    return [...REQUIRED_SCENARIO_IDS];
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
