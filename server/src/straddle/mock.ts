/**
 * Scripted mock Straddle client — a FIRST-CLASS deliverable (spec §7), not a
 * test detail. It implements the full StraddleClient boundary with
 * per-scenario transition schedules driven by an injectable Clock, so the
 * runner, evaluator, CLI, HTTP layer, and UI can all be built and tested
 * before (and independently of) the real adapter. It also generates the
 * synthetic recordings used for replay development (spec §11).
 *
 * Fidelity rules — every API fact herein comes from api-notes.md, never
 * guessed:
 * - Customer create settles SYNCHRONOUSLY with the forced status in the 201
 *   (api-notes §6 / spec §18.3): `config.sandbox_outcome` verified/review/
 *   rejected forces exactly that `status`; standard/absent settles verified.
 * - The review payload mirrors the §6 sandbox quirk: `identity_details.
 *   decision` is the canned "accept" EVEN FOR REJECTED customers; the
 *   authoritative status is the customer `status`. Breakdown carries
 *   per-module 0–1 scores and I-prefixed codes so the IdentityReviewSummary
 *   mapping (fraud risk_score, email correlation_score, union of codes) is
 *   exercised for real.
 * - createPaykey for a REJECTED customer throws MockApiError with status 422
 *   and the VERBATIM api-notes §10 error envelope (top-level `error` key,
 *   `items` absent — that absence is Scenario E's distinguisher).
 * - Charges advance along scripted schedules (exported SCHEDULES) against
 *   clock time; status_history is EVENT-level (consecutive identical statuses
 *   appear, per api-notes §8) and return codes live at status_details.code,
 *   absent-not-null when inapplicable.
 * - One `api.exchange` event per simulated HTTP exchange, attempt=1, small
 *   fake latencies, bodies passed through the real redactor before emit —
 *   the same telemetry shape and redaction discipline the real client will
 *   have, so mock-generated recordings are canary-clean by construction.
 */
import type { ScenarioId } from "@sse/shared";
import type { EventBus } from "../engine/bus.js";
import { createRedactor } from "../redaction.js";
import type { Redactor } from "../redaction.js";
import type {
  ChargeActionOptions,
  ChargeInput,
  ChargeResult,
  ChargeSandboxOutcome,
  ChargeStatus,
  ChargeStatusHistoryEntry,
  ChargeStatusReason,
  ChargeStatusSource,
  Clock,
  CustomerInput,
  CustomerResult,
  CustomerReviewResult,
  CustomerStatus,
  HealthResult,
  PaykeyInput,
  PaykeyResult,
  PayoutInput,
  PayoutResult,
  StatusDetails,
  StraddleClient,
} from "./types.js";

// ---------------------------------------------------------------------------
// Error shape — Wave 2's StraddleApiError must carry these same fields
// ---------------------------------------------------------------------------

/**
 * Error thrown by the mock for refused/invalid calls. Field-compatible with
 * the spec §6 StraddleApiError so Wave 2 can substitute its class without
 * changing consumers: `status` (HTTP), `errorBody` (the full envelope —
 * top-level `error` key per api-notes §12 item 13 — already redaction-safe),
 * `path`, `retryable` (429/5xx true, other 4xx false), `requestId`
 * (meta.api_request_id analog).
 */
export class MockApiError extends Error {
  readonly status: number;
  readonly errorBody: unknown;
  readonly path: string;
  readonly retryable: boolean;
  readonly requestId?: string;

  constructor(args: {
    status: number;
    errorBody: unknown;
    path: string;
    message: string;
    requestId?: string;
  }) {
    super(args.message);
    this.name = "MockApiError";
    this.status = args.status;
    this.errorBody = args.errorBody;
    this.path = args.path;
    this.retryable = args.status === 429 || args.status >= 500;
    if (args.requestId !== undefined) this.requestId = args.requestId;
  }
}

// ---------------------------------------------------------------------------
// Schedules — DATA, exported so tests and scenario wiring pick by id
// ---------------------------------------------------------------------------

/**
 * One scripted status_history event. `at_ms` is the offset from charge
 * creation on the injected clock. `reason`/`source` default to "ok"/"system";
 * `code` is present only where the sandbox puts an ACH return code
 * (status_details.code, absent-not-null — api-notes §8).
 */
export interface ChargeScheduleStep {
  at_ms: number;
  status: ChargeStatus;
  message: string;
  reason?: ChargeStatusReason;
  source?: ChargeStatusSource;
  code?: string;
}

export interface ChargeSchedule {
  id: string;
  description: string;
  /** Ordered by at_ms; first step is always created@0. */
  steps: readonly ChargeScheduleStep[];
}

/**
 * Named schedules. Offsets mirror api-notes §8/§9 measured timings (rounded):
 * created → scheduled +~3 s → pending at the minute-tick (~49 s) → terminal
 * ~117–119 s for paid/failed; the reversal-analog terminal lands ~241 s after
 * the "received" pending event.
 *
 * - `c` is the SPEC-CONTRACT shape (created → pending → paid → reversed with
 *   the R-code on the reversal) — the paid→reversed story the live sandbox
 *   never surfaces (api-notes §9); the mock exists so Scenario C's ordered
 *   observation is demonstrable and testable anyway (api-notes §12 item 1).
 * - `c_live` is the OBSERVED live shape (run 1 of §9, verbatim messages and
 *   timings): created → scheduled → pending ×3 event-level entries → failed
 *   +R01 at +351 s.
 * - `d`'s 10 s watchtower-style cancel is SYNTHETIC — D's live timing is
 *   unmeasured (api-notes §13); bounded by the "early cancel ≈ 10 s" estimate.
 */
export const SCHEDULES = {
  a: {
    id: "a",
    description: "happy path: created -> scheduled -> pending -> paid (~117 s)",
    steps: [
      { at_ms: 0, status: "created", message: "Charge created." },
      { at_ms: 3_000, status: "scheduled", message: "Charge scheduled." },
      {
        at_ms: 49_000,
        status: "pending",
        message: "Payment originated to network.",
      },
      { at_ms: 117_000, status: "paid", message: "Payment settled." },
    ],
  },
  b: {
    id: "b",
    description:
      "failed + R01: created -> scheduled -> pending -> failed (~119 s)",
    steps: [
      { at_ms: 0, status: "created", message: "Charge created." },
      { at_ms: 3_000, status: "scheduled", message: "Charge scheduled." },
      {
        at_ms: 49_000,
        status: "pending",
        message: "Payment originated to network.",
      },
      {
        at_ms: 119_000,
        status: "failed",
        message: "Payment failed due to insufficient funds.",
        reason: "insufficient_funds",
        source: "bank_decline",
        code: "R01",
      },
    ],
  },
  c: {
    id: "c",
    description:
      "spec-contract reversal: created -> pending -> paid -> reversed (+R01)",
    steps: [
      { at_ms: 0, status: "created", message: "Charge created." },
      {
        at_ms: 45_000,
        status: "pending",
        message: "Payment originated to network.",
      },
      { at_ms: 117_000, status: "paid", message: "Payment settled." },
      {
        at_ms: 358_000, // paid + the measured ~241 s reversal-window analog
        status: "reversed",
        message: "Payment was reversed due to insufficient funds.",
        reason: "insufficient_funds",
        source: "bank_decline",
        code: "R01",
      },
    ],
  },
  c_live: {
    id: "c_live",
    description:
      "observed live reversed_* shape: pending x3 -> failed +R01 at +351 s",
    steps: [
      { at_ms: 0, status: "created", message: "Charge created." },
      { at_ms: 2_600, status: "scheduled", message: "Charge scheduled." },
      {
        at_ms: 49_300,
        status: "pending",
        message: "Payment originated to network.",
      },
      {
        at_ms: 109_200,
        status: "pending",
        message: "Payment posted to the customer's bank.",
      },
      {
        at_ms: 110_000,
        // Verbatim live message, including Straddle's missing apostrophe.
        status: "pending",
        message: "Payment received from the customers bank.",
      },
      {
        at_ms: 351_000,
        status: "failed",
        message: "Payment failed due to insufficient funds.",
        reason: "insufficient_funds",
        source: "bank_decline",
        code: "R01",
      },
    ],
  },
  d: {
    id: "d",
    description:
      "cancelled + reason detail: created -> cancelled (watchtower, ~10 s SYNTHETIC)",
    steps: [
      { at_ms: 0, status: "created", message: "Charge created." },
      {
        at_ms: 10_000,
        status: "cancelled",
        message: "Charge was cancelled due to fraud risk.",
        reason: "fraudulent",
        source: "watchtower",
      },
    ],
  },
  // ---- P2-2 (F/G/I) additions — api-notes §P14; §12.18 R02 poisoning ----
  // F: a SECOND ACH decline beyond B's R01 — closed bank account, R02, ~117 s
  // (api-notes §P14). Mirrors B's timing; only the reason/code differ.
  f: {
    id: "f",
    description:
      "failed + R02 (closed bank account): created -> scheduled -> pending -> failed (~117 s)",
    steps: [
      { at_ms: 0, status: "created", message: "Charge created." },
      { at_ms: 3_000, status: "scheduled", message: "Charge scheduled." },
      {
        at_ms: 49_000,
        status: "pending",
        message: "Payment originated to network.",
      },
      {
        at_ms: 117_000,
        status: "failed",
        message: "Payment failed due to a closed bank account.",
        reason: "closed_bank_account",
        source: "bank_decline",
        code: "R02",
      },
    ],
  },
  // G: the SPEC-CONTRACT reversal shape for the closed-bank-account outcome —
  // created -> pending -> paid -> reversed (+R02). Like `c`, this is the
  // paid->reversed story the live sandbox never surfaces (api-notes §P14 / §18.1);
  // the mock exists so G's ordered observation is demonstrable and testable.
  g: {
    id: "g",
    description:
      "spec-contract reversal (closed bank account): created -> pending -> paid -> reversed (+R02)",
    steps: [
      { at_ms: 0, status: "created", message: "Charge created." },
      {
        at_ms: 45_000,
        status: "pending",
        message: "Payment originated to network.",
      },
      { at_ms: 117_000, status: "paid", message: "Payment settled." },
      {
        at_ms: 358_000, // paid + the measured ~241 s reversal-window analog
        status: "reversed",
        message: "Payment was reversed due to a closed bank account.",
        reason: "closed_bank_account",
        source: "bank_decline",
        code: "R02",
      },
    ],
  },
  // G_live: the OBSERVED live reversed_closed_bank_account shape (api-notes §P14):
  // created -> scheduled -> pending x3 -> failed +R02 at +332 s; never paid/reversed
  // (same §18.1 deviation as c_live). Selected via explicit chargeSchedule override.
  g_live: {
    id: "g_live",
    description:
      "observed live reversed_closed_bank_account shape: pending x3 -> failed +R02 at +332 s",
    steps: [
      { at_ms: 0, status: "created", message: "Charge created." },
      { at_ms: 2_600, status: "scheduled", message: "Charge scheduled." },
      {
        at_ms: 49_300,
        status: "pending",
        message: "Payment originated to network.",
      },
      {
        at_ms: 109_200,
        status: "pending",
        message: "Payment posted to the customer's bank.",
      },
      {
        at_ms: 110_000,
        // Verbatim live message, including Straddle's missing apostrophe.
        status: "pending",
        message: "Payment received from the customers bank.",
      },
      {
        at_ms: 332_000,
        status: "failed",
        message: "Payment failed due to a closed bank account.",
        reason: "closed_bank_account",
        source: "bank_decline",
        code: "R02",
      },
    ],
  },
  // I: manual-cancellation base (api-notes §P14). No `sandbox_outcome` reaches a
  // real terminal `cancelled` (spec §18.8) — only the cancel ACTION does. This
  // schedule advances to `scheduled` and STALLS there (mirrors the observed
  // `standard` charge stuck at `scheduled`), staying pre-terminal so the cancel
  // action is the sole terminator. Selected via explicit chargeSchedule override.
  i: {
    id: "i",
    description:
      "manual-cancellation base: created -> scheduled, then stalls (awaits ACH); cancel drives the terminal",
    steps: [
      { at_ms: 0, status: "created", message: "Charge created." },
      { at_ms: 3_000, status: "scheduled", message: "Charge scheduled." },
    ],
  },
  // H (hold/release) needs NO dedicated schedule: it is created with
  // `sandbox_outcome: "paid"` → SCHEDULES.a (created -> scheduled -> pending ->
  // paid, api-notes §P11), then the hold/release ACTIONS drive the on_hold →
  // (resume) → paid trajectory. The action methods operate on charge STATE, not
  // on a scenario id, so no `h` schedule is required.
} as const satisfies Record<string, ChargeSchedule>;

export type ScheduleId = keyof typeof SCHEDULES;

/**
 * Default schedule per charge `config.sandbox_outcome` (api-notes §5 scenario
 * mapping). `reversed_insufficient_funds` maps to the SPEC-CONTRACT `c`
 * schedule — the mock's reason for existing is showing paid→reversed; tests
 * that want the live shape pass `chargeSchedule: SCHEDULES.c_live` explicitly.
 */
export const DEFAULT_SCHEDULE_BY_OUTCOME: Partial<
  Record<ChargeSandboxOutcome, ChargeSchedule>
> = {
  standard: SCHEDULES.a,
  paid: SCHEDULES.a,
  failed_insufficient_funds: SCHEDULES.b,
  // F/G map to the R02 closed-bank-account schedules (api-notes §P14), NOT the
  // R01 `b`/`c` schedules — the decline code is the teaching point.
  failed_closed_bank_account: SCHEDULES.f,
  reversed_insufficient_funds: SCHEDULES.c,
  reversed_closed_bank_account: SCHEDULES.g,
  cancelled_for_fraud_risk: SCHEDULES.d,
  cancelled_for_balance_check: SCHEDULES.d,
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Events carry run identity (shared RunEvent base), but the StraddleClient
 * interface deliberately does not: like the real adapter, the mock is
 * constructed PER RUN with the run's context. The Wave 2 runner constructs
 * one client per run (or a per-run facade over one transport).
 */
export interface MockRunContext {
  run_id: string;
  scenario_id: ScenarioId;
}

export interface MockStraddleClientOptions {
  bus: EventBus;
  clock: Clock;
  context: MockRunContext;
  /**
   * Forces every charge this client creates onto one schedule, overriding
   * DEFAULT_SCHEDULE_BY_OUTCOME (e.g. SCHEDULES.c_live for live-shape tests).
   */
  chargeSchedule?: ChargeSchedule;
  /**
   * Redactor for emitted bodies. Defaults to `createRedactor({})` — no live
   * key exists in mock mode, and the seeded-bank canary masking is built in.
   */
  redactor?: Redactor;
}

const INSTITUTION_NAME = "JPMORGAN CHASE BANK, NA";

interface StoredCustomer {
  result: CustomerResult;
}

/**
 * A charge's lifecycle phase under the injectable clock:
 * - "running": following its scripted schedule from `scheduleBaseMs`.
 * - "held": frozen at `on_hold` by the hold action until released.
 * - "cancelled": terminated by the cancel action.
 * Actions mutate this state; getCharge projects the schedule only in "running".
 */
type ChargeMode = "running" | "held" | "cancelled";

/**
 * A payout's stored state (P2-4 / api-notes §P13). Payouts are money OUT and
 * charge-shaped, but this lane only creates + observes (no hold/release/cancel
 * actions), so the state is simpler than StoredCharge: a schedule projected from
 * `createdAtMs`, no action-mutable trajectory.
 */
interface StoredPayout {
  input: PayoutInput;
  createdAtMs: number;
  schedule: ChargeSchedule;
  result_id: string;
}

interface StoredCharge {
  input: ChargeInput;
  createdAtMs: number;
  schedule: ChargeSchedule;
  result_id: string;
  // -- action-mutable trajectory state (P2-2.1) --
  mode: ChargeMode;
  /** Clock time mapped to the schedule's `at_ms=0`; reset to now() on release. */
  scheduleBaseMs: number;
  /** History frozen from completed phases (before the active schedule segment
   *  or a terminal); carries absolute changed_at, immune to base changes. */
  committedHistory: ChargeStatusHistoryEntry[];
  /** The on_hold entry while mode === "held". */
  heldEntry?: ChargeStatusHistoryEntry;
  /** The terminal cancelled entry while mode === "cancelled". */
  terminalEntry?: ChargeStatusHistoryEntry;
}

export function createMockStraddleClient(
  options: MockStraddleClientOptions,
): StraddleClient {
  return new MockStraddleClient(options);
}

export class MockStraddleClient implements StraddleClient {
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly context: MockRunContext;
  private readonly chargeScheduleOverride: ChargeSchedule | undefined;
  private readonly redactor: Redactor;

  private requestCounter = 0;
  private customerCounter = 0;
  private paykeyCounter = 0;
  private chargeCounter = 0;
  private payoutCounter = 0;

  private readonly customers = new Map<string, StoredCustomer>();
  private readonly paykeysByToken = new Map<string, PaykeyResult>();
  private readonly charges = new Map<string, StoredCharge>();
  private readonly usedChargeExternalIds = new Set<string>();
  private readonly payouts = new Map<string, StoredPayout>();
  private readonly usedPayoutExternalIds = new Set<string>();

  constructor(options: MockStraddleClientOptions) {
    this.bus = options.bus;
    this.clock = options.clock;
    this.context = options.context;
    this.chargeScheduleOverride = options.chargeSchedule;
    this.redactor = options.redactor ?? createRedactor({});
  }

  // -- StraddleClient ------------------------------------------------------

  async health(): Promise<HealthResult> {
    // Auth ping is GET /v1/customers — no dedicated health endpoint exists
    // (api-notes §2). The mock always holds a "valid key".
    this.emitExchange({
      method: "GET",
      path: "/v1/customers",
      status: 200,
      responseBody: {
        data: [],
        meta: this.meta(),
        response_type: "array",
      },
    });
    return { ok: true, status: 200 };
  }

  async createCustomer(input: CustomerInput): Promise<CustomerResult> {
    const path = "/v1/customers";
    const outcome = input.config?.sandbox_outcome ?? "standard";
    // Forced status arrives synchronously in the 201 (api-notes §6 / spec
    // §18.3); "standard" settles verified in the mock.
    const status: CustomerStatus =
      outcome === "review" || outcome === "rejected" ? outcome : "verified";
    this.customerCounter += 1;
    const nowIso = this.nowIso();
    const result: CustomerResult = {
      id: `mock-customer-${this.customerCounter}-${this.context.run_id}`,
      status,
      name: input.name,
      email: input.email,
      phone: input.phone,
      type: input.type,
      external_id: input.external_id ?? null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    this.customers.set(result.id, { result });
    this.emitExchange({
      method: "POST",
      path,
      status: 201,
      requestBody: input,
      responseBody: { data: result, meta: this.meta(), response_type: "object" },
    });
    return result;
  }

  async getCustomerReview(customerId: string): Promise<CustomerReviewResult> {
    const path = `/v1/customers/${customerId}/review`;
    const stored = this.customers.get(customerId);
    if (stored === undefined) {
      throw this.refuse({
        method: "GET",
        path,
        status: 404,
        type: "/not_found",
        title: "Not Found",
        detail: `Customer ${customerId} was not found.`,
      });
    }
    const customer = stored.result;
    // Canned identity payload mirroring api-notes §6, INCLUDING the quirk:
    // decision is "accept" even when the customer is rejected. The
    // authoritative status is customer.status, and the summary maps
    // fraud.risk_score / email.correlation_score / union of codes.
    const identityDetails = {
      review_id: `mock-review-${customerId}`,
      decision: "accept",
      messages: {
        I121: "Email address is deliverable.",
        I553: "Phone number is associated with the customer.",
      },
      breakdown: {
        email: {
          decision: "accept",
          codes: ["I121"],
          risk_score: 0.01,
          correlation_score: 0.99,
        },
        phone: {
          decision: "accept",
          codes: ["I553"],
          risk_score: 0.02,
          correlation_score: 0.97,
        },
        fraud: { decision: "accept", codes: [], risk_score: 0.184 },
      },
      created_at: customer.created_at,
      updated_at: customer.updated_at,
    };
    this.emitExchange({
      method: "GET",
      path,
      status: 200,
      responseBody: {
        data: { customer_details: customer, identity_details: identityDetails },
        meta: this.meta(),
        response_type: "object",
      },
    });
    return {
      customer_id: customerId,
      status: customer.status,
      decision: "accept",
      summary: {
        verification_status: customer.status,
        risk_score: 0.184, // breakdown.fraud.risk_score
        correlation_score: 0.99, // breakdown.email.correlation_score
        reason_codes: ["I121", "I553"], // union of breakdown.<module>.codes[]
      },
    };
  }

  async createPaykey(input: PaykeyInput): Promise<PaykeyResult> {
    const path = "/v1/bridge/bank_account"; // NO POST /v1/paykeys (api-notes §7)
    const stored = this.customers.get(input.customer_id);
    if (stored === undefined) {
      throw this.refuse({
        method: "POST",
        path,
        status: 404,
        type: "/not_found",
        title: "Not Found",
        detail: `Customer ${input.customer_id} was not found.`,
        requestBody: input,
      });
    }
    if (stored.result.status === "rejected") {
      // Scenario E's refusal — VERBATIM api-notes §10 envelope. `items` is
      // deliberately ABSENT: its absence (plus the detail sentence) is how
      // the evaluator distinguishes this business-rule 422 from generic
      // field-validation 422s. Sandbox forcing does not bypass the check.
      throw this.refuse({
        method: "POST",
        path,
        status: 422,
        type: "/validation_error",
        title: "Validation Failed",
        detail: "Cannot create paykey as customer is rejected.",
        requestBody: input,
      });
    }
    const outcome = input.config?.sandbox_outcome ?? "standard";
    const status =
      outcome === "review" || outcome === "rejected" ? outcome : "active";
    this.paykeyCounter += 1;
    const token = fakePaykeyToken(this.paykeyCounter);
    const nowIso = this.nowIso();
    const last4 = input.account_number.slice(-4);
    const result: PaykeyResult = {
      id: `mock-paykey-${this.paykeyCounter}-${this.context.run_id}`,
      paykey: token,
      customer_id: input.customer_id,
      status,
      status_details: {
        message: "Paykey is active.",
        reason: "ok",
        source: "system",
        changed_at: nowIso,
      },
      label: `${INSTITUTION_NAME} - *${last4}`,
      institution_name: INSTITUTION_NAME,
      source: "bank_account",
      bank_data: {
        routing_number: input.routing_number, // live returns this UNMASKED
        account_number: `*****${last4}`, // live masks to last-4
        account_type: input.account_type,
      },
      external_id: input.external_id ?? null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    this.paykeysByToken.set(token, result);
    this.emitExchange({
      method: "POST",
      path,
      status: 201,
      requestBody: input,
      responseBody: { data: result, meta: this.meta(), response_type: "object" },
    });
    return result;
  }

  async createCharge(input: ChargeInput): Promise<ChargeResult> {
    const path = "/v1/charges";
    if (!this.paykeysByToken.has(input.paykey)) {
      // Charges require the paykey TOKEN from the bridge create response,
      // never the paykey id (api-notes §8).
      throw this.refuse({
        method: "POST",
        path,
        status: 422,
        type: "/validation_error",
        title: "Validation Failed",
        detail: "Unknown paykey.",
        items: [{ reference: "paykey", detail: "Unknown paykey token." }],
        requestBody: input,
      });
    }
    if (this.usedChargeExternalIds.has(input.external_id)) {
      // external_id must be unique across all charges (api-notes §8).
      throw this.refuse({
        method: "POST",
        path,
        status: 422,
        type: "/validation_error",
        title: "Validation Failed",
        detail: "external_id must be unique across charges.",
        items: [
          { reference: "external_id", detail: "external_id already used." },
        ],
        requestBody: input,
      });
    }
    this.usedChargeExternalIds.add(input.external_id);

    const schedule =
      this.chargeScheduleOverride ??
      (input.config.sandbox_outcome !== undefined
        ? DEFAULT_SCHEDULE_BY_OUTCOME[input.config.sandbox_outcome]
        : undefined) ??
      SCHEDULES.a;
    this.chargeCounter += 1;
    const id = `mock-charge-${this.chargeCounter}-${this.context.run_id}`;
    const createdAtMs = this.clock.now();
    const storedCharge: StoredCharge = {
      input,
      createdAtMs,
      schedule,
      result_id: id,
      mode: "running",
      scheduleBaseMs: createdAtMs,
      committedHistory: [],
    };
    this.charges.set(id, storedCharge);
    const result = this.chargeSnapshot(storedCharge);
    this.emitExchange({
      method: "POST",
      path,
      status: 201,
      requestBody: input,
      responseBody: { data: result, meta: this.meta(), response_type: "object" },
    });
    return result;
  }

  async getCharge(chargeId: string): Promise<ChargeResult> {
    const path = `/v1/charges/${chargeId}`;
    const stored = this.charges.get(chargeId);
    if (stored === undefined) {
      throw this.refuse({
        method: "GET",
        path,
        status: 404,
        type: "/not_found",
        title: "Not Found",
        detail: `Charge ${chargeId} was not found.`,
      });
    }
    const result = this.chargeSnapshot(stored);
    this.emitExchange({
      method: "GET",
      path,
      status: 200,
      responseBody: { data: result, meta: this.meta(), response_type: "object" },
    });
    return result;
  }

  // -- payouts (P2-4 / api-notes §P13) -------------------------------------

  async createPayout(input: PayoutInput): Promise<PayoutResult> {
    const path = "/v1/payouts";
    if (!this.paykeysByToken.has(input.paykey)) {
      // Payouts require the paykey TOKEN, never the paykey id — same as charges.
      throw this.refuse({
        method: "POST",
        path,
        status: 422,
        type: "/validation_error",
        title: "Validation Failed",
        detail: "Unknown paykey.",
        items: [{ reference: "paykey", detail: "Unknown paykey token." }],
        requestBody: input,
      });
    }
    if (this.usedPayoutExternalIds.has(input.external_id)) {
      // external_id must be unique across all payouts (api-notes §P13).
      throw this.refuse({
        method: "POST",
        path,
        status: 422,
        type: "/validation_error",
        title: "Validation Failed",
        detail: "external_id must be unique across payouts.",
        items: [
          { reference: "external_id", detail: "external_id already used." },
        ],
        requestBody: input,
      });
    }
    this.usedPayoutExternalIds.add(input.external_id);

    // Payout sandbox_outcome enum is identical to charges, so the same
    // schedules apply (api-notes §P13). Default to SCHEDULES.a (paid ~117 s).
    const schedule =
      this.chargeScheduleOverride ??
      (input.config?.sandbox_outcome !== undefined
        ? DEFAULT_SCHEDULE_BY_OUTCOME[input.config.sandbox_outcome]
        : undefined) ??
      SCHEDULES.a;
    this.payoutCounter += 1;
    const id = `mock-payout-${this.payoutCounter}-${this.context.run_id}`;
    const stored: StoredPayout = {
      input,
      createdAtMs: this.clock.now(),
      schedule,
      result_id: id,
    };
    this.payouts.set(id, stored);
    const result = this.payoutSnapshot(stored);
    this.emitExchange({
      method: "POST",
      path,
      status: 201,
      requestBody: input,
      responseBody: { data: result, meta: this.meta(), response_type: "object" },
    });
    return result;
  }

  async getPayout(payoutId: string): Promise<PayoutResult> {
    const path = `/v1/payouts/${payoutId}`;
    const stored = this.payouts.get(payoutId);
    if (stored === undefined) {
      throw this.refuse({
        method: "GET",
        path,
        status: 404,
        type: "/not_found",
        title: "Not Found",
        detail: `Payout ${payoutId} was not found.`,
      });
    }
    const result = this.payoutSnapshot(stored);
    this.emitExchange({
      method: "GET",
      path,
      status: 200,
      responseBody: { data: result, meta: this.meta(), response_type: "object" },
    });
    return result;
  }

  /** Schedule-projected event-level history for a payout at the current clock. */
  private payoutHistory(stored: StoredPayout): ChargeStatusHistoryEntry[] {
    const elapsed = this.clock.now() - stored.createdAtMs;
    const due = stored.schedule.steps.filter((s) => s.at_ms <= elapsed);
    return due.map((step) => this.scheduleEntry(stored.createdAtMs, step));
  }

  /** Projects a stored payout onto its lifecycle at the CURRENT clock time. */
  private payoutSnapshot(stored: StoredPayout): PayoutResult {
    const history = this.payoutHistory(stored);
    const latest = history[history.length - 1];
    if (latest === undefined) {
      throw new Error(
        `mock payout schedule "${stored.schedule.id}" has no step at offset 0`,
      );
    }
    const { input } = stored;
    return {
      id: stored.result_id,
      status: latest.status,
      status_details: detailsOf(latest),
      status_history: history,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      external_id: input.external_id,
      payment_date: input.payment_date,
      // Live payout responses mask the token server-side; mirror that.
      paykey: maskPaykeyToken(input.paykey),
      // Payout-only keys (api-notes §P13) — non-sensitive; present so the DTO's
      // tolerate-extras path is exercised and the UI/report can inspect them.
      funding_ids: [],
      is_refund: false,
      is_resubmit: false,
      has_resubmit: false,
      trace_ids: [`mock-trace-${stored.result_id}`],
      created_at: isoAt(stored.createdAtMs),
      updated_at: latest.changed_at,
    };
  }

  // -- charge lifecycle actions (api-notes §P11) ---------------------------

  async holdCharge(
    chargeId: string,
    opts?: ChargeActionOptions,
  ): Promise<ChargeResult> {
    const path = `/v1/charges/${chargeId}/hold`;
    const stored = this.requireCharge("PUT", path, chargeId, opts);
    const status = this.currentStatus(stored);
    if (isTerminalStatus(status)) {
      throw this.refuseActionOnTerminal("PUT", path, status, opts);
    }
    // `on_hold` is not terminal but is not re-holdable — an already-held charge
    // is a 200 no-op (idempotent). A pre-terminal running charge is frozen at
    // its current projection, then transitioned to on_hold (reason user_request,
    // source user_action).
    if (stored.mode !== "held") {
      stored.committedHistory = this.buildHistory(stored);
      stored.mode = "held";
      stored.heldEntry = this.actionEntry(
        "on_hold",
        opts?.reason,
        "Charge held by user request.",
      );
    }
    return this.emitActionResult("PUT", path, stored, opts);
  }

  async releaseCharge(
    chargeId: string,
    opts?: ChargeActionOptions,
  ): Promise<ChargeResult> {
    const path = `/v1/charges/${chargeId}/release`;
    const stored = this.requireCharge("PUT", path, chargeId, opts);
    const status = this.currentStatus(stored);
    if (isTerminalStatus(status)) {
      throw this.refuseActionOnTerminal("PUT", path, status, opts);
    }
    if (stored.mode === "held") {
      // Resume to `created` and re-run the pipeline (NOT straight to paid,
      // api-notes §12.20): freeze the on_hold into committed history and replay
      // the schedule from now — so an H scenario ends `paid`.
      stored.committedHistory = this.buildHistory(stored);
      stored.mode = "running";
      stored.heldEntry = undefined;
      stored.scheduleBaseMs = this.clock.now();
    }
    // release on a NOT-held charge is a 200 no-op — status unchanged, not an
    // error (api-notes §12.20).
    return this.emitActionResult("PUT", path, stored, opts);
  }

  async cancelCharge(
    chargeId: string,
    opts?: ChargeActionOptions,
  ): Promise<ChargeResult> {
    const path = `/v1/charges/${chargeId}/cancel`;
    const stored = this.requireCharge("PUT", path, chargeId, opts);
    const status = this.currentStatus(stored);
    if (isTerminalStatus(status)) {
      throw this.refuseActionOnTerminal("PUT", path, status, opts);
    }
    // Pre-terminal (running OR held): freeze current history, go terminal
    // `cancelled` (reason user_request, source user_action). Cancelling a held
    // charge yields history created -> on_hold -> cancelled (api-notes §P11).
    stored.committedHistory = this.buildHistory(stored);
    stored.mode = "cancelled";
    stored.heldEntry = undefined;
    stored.terminalEntry = this.actionEntry(
      "cancelled",
      opts?.reason,
      "Charge cancelled by user request.",
    );
    return this.emitActionResult("PUT", path, stored, opts);
  }

  // -- internals -----------------------------------------------------------

  private requireCharge(
    method: string,
    path: string,
    chargeId: string,
    opts: ChargeActionOptions | undefined,
  ): StoredCharge {
    const stored = this.charges.get(chargeId);
    if (stored === undefined) {
      throw this.refuse({
        method,
        path,
        status: 404,
        type: "/not_found",
        title: "Not Found",
        detail: `Charge ${chargeId} was not found.`,
        ...(opts?.reason !== undefined
          ? { requestBody: { reason: opts.reason } }
          : {}),
      });
    }
    return stored;
  }

  /**
   * Any action on a terminal charge → 422 (api-notes §12.20). Modeled as a
   * business-rule validation error: top-level `error` envelope, message-only,
   * `items` ABSENT (mirrors the Scenario E refusal shape).
   */
  private refuseActionOnTerminal(
    method: string,
    path: string,
    status: ChargeStatus,
    opts: ChargeActionOptions | undefined,
  ): MockApiError {
    return this.refuse({
      method,
      path,
      status: 422,
      type: "/validation_error",
      title: "Validation Failed",
      detail: `Unable to change status of a ${status} payment.`,
      ...(opts?.reason !== undefined
        ? { requestBody: { reason: opts.reason } }
        : {}),
    });
  }

  /** Emits the 200 action exchange and returns the updated charge snapshot. */
  private emitActionResult(
    method: string,
    path: string,
    stored: StoredCharge,
    opts: ChargeActionOptions | undefined,
  ): ChargeResult {
    const result = this.chargeSnapshot(stored);
    this.emitExchange({
      method,
      path,
      status: 200,
      // Body is optional; the user-supplied reason is echoed into the
      // transition's status_details.message (api-notes §P11).
      ...(opts?.reason !== undefined
        ? { requestBody: { reason: opts.reason } }
        : {}),
      responseBody: { data: result, meta: this.meta(), response_type: "object" },
    });
    return result;
  }

  /** An action-authored transition (on_hold / cancelled). */
  private actionEntry(
    status: ChargeStatus,
    reason: string | undefined,
    defaultMessage: string,
  ): ChargeStatusHistoryEntry {
    return {
      status,
      message: reason ?? defaultMessage,
      reason: "user_request",
      source: "user_action",
      changed_at: this.nowIso(),
    };
  }

  private currentStatus(stored: StoredCharge): ChargeStatus {
    const history = this.buildHistory(stored);
    const last = history[history.length - 1];
    if (last === undefined) {
      throw new Error(`mock charge ${stored.result_id} has empty history`);
    }
    return last.status;
  }

  /**
   * The charge's full EVENT-level status history at the current clock time,
   * combining phases: committed history (frozen prior segments) + the active
   * phase (running schedule projection, a held on_hold, or a cancelled terminal).
   */
  private buildHistory(stored: StoredCharge): ChargeStatusHistoryEntry[] {
    if (stored.mode === "cancelled") {
      if (stored.terminalEntry === undefined) {
        throw new Error(
          `mock charge ${stored.result_id} is cancelled without a terminal entry`,
        );
      }
      return [...stored.committedHistory, stored.terminalEntry];
    }
    if (stored.mode === "held") {
      if (stored.heldEntry === undefined) {
        throw new Error(
          `mock charge ${stored.result_id} is held without an on_hold entry`,
        );
      }
      return [...stored.committedHistory, stored.heldEntry];
    }
    return [...stored.committedHistory, ...this.projectRunning(stored)];
  }

  /** Schedule-projected entries for the active running segment. */
  private projectRunning(stored: StoredCharge): ChargeStatusHistoryEntry[] {
    const elapsed = this.clock.now() - stored.scheduleBaseMs;
    const due = stored.schedule.steps.filter((s) => s.at_ms <= elapsed);
    return due.map((step) => this.scheduleEntry(stored.scheduleBaseMs, step));
  }

  private scheduleEntry(
    baseMs: number,
    step: ChargeScheduleStep,
  ): ChargeStatusHistoryEntry {
    return {
      status: step.status,
      message: step.message,
      reason: step.reason ?? "ok",
      source: step.source ?? "system",
      // `code` is ABSENT (not null) when inapplicable (api-notes §8).
      ...(step.code !== undefined ? { code: step.code } : {}),
      changed_at: isoAt(baseMs + step.at_ms),
    };
  }

  /** Projects a stored charge onto its lifecycle at the CURRENT clock time. */
  private chargeSnapshot(stored: StoredCharge): ChargeResult {
    const history = this.buildHistory(stored);
    // steps[0] is created@0, so history is never empty for a created charge.
    const latest = history[history.length - 1];
    if (latest === undefined) {
      throw new Error(
        `mock schedule "${stored.schedule.id}" has no step at offset 0`,
      );
    }
    const { input } = stored;
    return {
      id: stored.result_id,
      status: latest.status,
      status_details: detailsOf(latest),
      status_history: history,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      external_id: input.external_id,
      payment_date: input.payment_date,
      // Live charge responses mask the token server-side; mirror that.
      paykey: maskPaykeyToken(input.paykey),
      effective_at: null,
      processed_at: null,
      created_at: isoAt(stored.createdAtMs),
      updated_at: latest.changed_at,
    };
  }

  /**
   * Emits an error exchange, then builds the MockApiError carrying the full
   * envelope (top-level `error` key — api-notes §12 item 13). `items` is
   * included only when given; Scenario E's refusal must NOT have it.
   */
  private refuse(args: {
    method: string;
    path: string;
    status: number;
    type: string;
    title: string;
    detail: string;
    items?: Array<{ reference: string; detail: string }>;
    requestBody?: unknown;
  }): MockApiError {
    const meta = this.meta();
    const errorBody = {
      error: {
        status: args.status,
        type: args.type,
        title: args.title,
        detail: args.detail,
        ...(args.items !== undefined ? { items: args.items } : {}),
      },
      meta,
      response_type: "error",
    };
    this.emitExchange({
      method: args.method,
      path: args.path,
      status: args.status,
      requestBody: args.requestBody,
      responseBody: errorBody,
      apiRequestId: meta.api_request_id,
    });
    return new MockApiError({
      status: args.status,
      errorBody: this.redactor.redactBody(errorBody),
      path: args.path,
      message: `${args.status} ${args.title}: ${args.detail}`,
      requestId: meta.api_request_id,
    });
  }

  /**
   * One event per simulated HTTP exchange — same shape the real client's
   * instrumented fetch emits (attempt-numbered; the mock never retries, so
   * attempt is always 1). Bodies go through the redactor BEFORE the event is
   * constructed (spec §8), so recordings built from mock runs are clean.
   */
  private emitExchange(args: {
    method: string;
    path: string;
    status: number;
    requestBody?: unknown;
    responseBody?: unknown;
    apiRequestId?: string;
  }): void {
    this.requestCounter += 1;
    const latency =
      args.method === "GET"
        ? 95 + (this.requestCounter % 5) * 7
        : 220 + (this.requestCounter % 5) * 12;
    this.bus.emit({
      type: "api.exchange",
      run_id: this.context.run_id,
      scenario_id: this.context.scenario_id,
      timestamp: this.nowIso(),
      method: args.method,
      path: args.path,
      status: args.status,
      latency_ms: latency,
      attempt: 1,
      ...(args.requestBody !== undefined
        ? { request_body: this.redactor.redactBody(args.requestBody) }
        : {}),
      ...(args.responseBody !== undefined
        ? { response_body: this.redactor.redactBody(args.responseBody) }
        : {}),
      api_request_id: args.apiRequestId ?? `mock-req-${this.requestCounter}`,
    });
  }

  private meta(): { api_request_id: string; api_request_timestamp: string } {
    return {
      api_request_id: `mock-req-${this.requestCounter + 1}`,
      api_request_timestamp: this.nowIso(),
    };
  }

  private nowIso(): string {
    return isoAt(this.clock.now());
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Fake token in the REAL format `<8hex>.<2digit>.<64hex>` (api-notes §7) so
 * the redactor's paykey-token pattern matches mock tokens exactly as it would
 * live ones.
 */
function fakePaykeyToken(n: number): string {
  const head = n.toString(16).padStart(8, "0");
  const tail = n.toString(16).padStart(64, "0");
  return `${head}.01.${tail}`;
}

/** Mirrors the server-side masking seen in live charge responses. */
function maskPaykeyToken(token: string): string {
  const head = token.slice(0, 3);
  const tail = token.slice(-3);
  return `${head}***.01.******${tail}`;
}

/**
 * Terminal charge statuses — no lifecycle action can move a charge out of these
 * (api-notes §12.20). `on_hold` is deliberately NOT terminal (it is releasable).
 */
function isTerminalStatus(status: ChargeStatus): boolean {
  return (
    status === "paid" ||
    status === "failed" ||
    status === "reversed" ||
    status === "cancelled"
  );
}

/** The StatusDetails portion of a history entry (drops the `status` field). */
function detailsOf(entry: ChargeStatusHistoryEntry): StatusDetails {
  return {
    ...(entry.message !== undefined ? { message: entry.message } : {}),
    reason: entry.reason,
    source: entry.source,
    ...(entry.code !== undefined ? { code: entry.code } : {}),
    changed_at: entry.changed_at,
  };
}
