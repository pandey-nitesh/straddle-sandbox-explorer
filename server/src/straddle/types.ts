/**
 * StraddleClient boundary types (spec §6/§7).
 *
 * These DTOs are LOCAL types — no SDK type imports anywhere in this file (or
 * in any consumer). SDK outputs are wrapped into these shapes by the real
 * adapter (client.ts) so a later `fetch` fallback cannot leak SDK types
 * through the codebase. Field names follow api-notes.md (§6 customers/review,
 * §7 paykeys, §8 charges) — never guessed.
 *
 * Extensibility rule (api-notes §12 item 17): live responses carry fields and
 * enum values absent from SDK types. DTO mappers pick known fields and must
 * tolerate unknowns; status/reason/source strings use `Extensible<...>` so
 * known values autocomplete while unknown values never crash a parse.
 */
import type { IdentityReviewSummary } from "@sse/shared";

/** Keeps literal autocomplete while accepting unknown future enum values. */
type Extensible<Known extends string> = Known | (string & Record<never, never>);

// ---------------------------------------------------------------------------
// Clock (spec §6 RunOptions) — lives here by Contracts-agent decision so no
// engine-owned file is touched in Wave 1. Engine modules import it from
// "../straddle/types.js" (or re-export it wherever the runner owner prefers).
// ---------------------------------------------------------------------------

export interface Clock {
  /** Current time as milliseconds since the Unix epoch. */
  now(): number;
  /** Resolves after `ms` milliseconds. Fake clocks resolve on manual advance. */
  sleep(ms: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared wire fragments
// ---------------------------------------------------------------------------

/** `config.processing_method` — server default "inline" (api-notes §5). */
export type ProcessingMethod = Extensible<"inline" | "background" | "skip">;

/** Required on customer and charge creates; "0.0.0.0" = offline registration. */
export interface DeviceInfo {
  ip_address: string;
}

/**
 * `status_details` on paykeys and charges (api-notes §7/§8).
 * `code` is the ACH return-code slot ("R01"…): ABSENT (not null) when
 * inapplicable, and watchtower failures carry no code while sharing `reason`
 * with bank declines — evaluators key on `source` + `code`, never `reason`
 * alone.
 */
export interface StatusDetails {
  message?: string;
  reason: ChargeStatusReason;
  source: ChargeStatusSource;
  code?: string;
  changed_at: string;
}

export type ChargeStatusReason = Extensible<
  | "insufficient_funds"
  | "closed_bank_account"
  | "invalid_bank_account"
  | "invalid_routing"
  | "disputed"
  | "payment_stopped"
  | "owner_deceased"
  | "frozen_bank_account"
  | "risk_review"
  | "fraudulent"
  | "duplicate_entry"
  | "invalid_paykey"
  | "payment_blocked"
  | "amount_too_large"
  | "too_many_attempts"
  | "internal_system_error"
  | "user_request"
  | "ok"
  | "other_network_return"
  | "payout_refused"
>;

export type ChargeStatusSource = Extensible<
  "watchtower" | "bank_decline" | "customer_dispute" | "user_action" | "system"
>;

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * Result of the auth ping (GET /v1/customers — no dedicated health endpoint
 * exists, api-notes §2). The invalid-key 401 has a COMPLETELY EMPTY body
 * (api-notes §1), so there is no error body to carry — only the SDK's
 * status-line message (e.g. "401 status code (no body)").
 */
export interface HealthResult {
  ok: boolean;
  /** HTTP status of the ping (200 when ok, 401 for an invalid key, …). */
  status: number;
  /** Present when not ok; human-readable, already redaction-safe. */
  message?: string;
  /**
   * The Straddle error body (redacted), when the failing response HAD one.
   * Absent for the documented empty-body 401 (spec §18.5) — consumers render
   * a status line instead. Never a synthesized message: verbatim testimony
   * only.
   */
  error_body?: unknown;
}

// ---------------------------------------------------------------------------
// Customers & identity review
// ---------------------------------------------------------------------------

export type CustomerType = "individual" | "business";

/** Customer `config.sandbox_outcome` enum (api-notes §5). */
export type CustomerSandboxOutcome =
  | "standard"
  | "verified"
  | "rejected"
  | "review";

/** Customer `status` enum (api-notes §6) — extensible by rule. */
export type CustomerStatus = Extensible<
  "pending" | "review" | "verified" | "inactive" | "rejected"
>;

/**
 * Working create body per api-notes §6: {name, email, phone, type,
 * device:{ip_address}, config:{sandbox_outcome}, external_id, metadata}.
 * `idempotencyKey` is camelCase because it is NOT a body field — the adapter
 * sends it as the `Idempotency-Key` header (recommended `<run_id>-<step>`);
 * the SDK's per-request idempotencyKey option is inert in 0.3.0 (api-notes §3).
 */
export interface CustomerInput {
  name: string;
  type: CustomerType;
  email: string;
  phone: string; // E.164
  device: DeviceInfo;
  config?: {
    sandbox_outcome?: CustomerSandboxOutcome;
    processing_method?: ProcessingMethod;
  };
  external_id?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface CustomerResult {
  id: string; // bare UUID — no cus_ prefix (api-notes §4)
  status: CustomerStatus; // settled synchronously in the 201 with inline processing
  name: string;
  email: string;
  phone: string;
  type: CustomerType;
  external_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** `identity_details.decision` — canned "accept" even for rejected customers. */
export type ReviewDecision = Extensible<"accept" | "reject" | "review">;

/**
 * GET /v1/customers/{id}/review, distilled. The AUTHORITATIVE verification
 * status is `status` (← customer_details.status); `decision` is surfaced only
 * for evidence display and must never gate anything (api-notes §6 quirk).
 * `summary` is pre-mapped to the shared IdentityReviewSummary per the §6
 * consolidation mapping.
 */
export interface CustomerReviewResult {
  customer_id: string;
  status: CustomerStatus;
  decision?: ReviewDecision;
  summary: IdentityReviewSummary;
}

// ---------------------------------------------------------------------------
// Paykeys (created via POST /v1/bridge/bank_account — api-notes §7)
// ---------------------------------------------------------------------------

export type AccountType = "checking" | "savings";

/** Paykey `config.sandbox_outcome` enum (api-notes §5). */
export type PaykeySandboxOutcome =
  | "standard"
  | "active"
  | "rejected"
  | "review";

/** Paykey `status` enum (api-notes §7) — extensible by rule. */
export type PaykeyStatus = Extensible<
  "pending" | "active" | "inactive" | "rejected" | "review"
>;

export interface PaykeyInput {
  customer_id: string;
  routing_number: string; // SEEDED_BANK.routing_number
  account_number: string; // SEEDED_BANK.preferred_account_number
  account_type: AccountType;
  config?: {
    sandbox_outcome?: PaykeySandboxOutcome;
    processing_method?: ProcessingMethod;
  };
  external_id?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface PaykeyResult {
  id: string;
  /**
   * The paykey TOKEN (`<8hex>.<2digit>.<64hex>`), unmasked ONLY in this create
   * response — treat as a credential (api-notes §11): it is what charge
   * creates require (never the id), and it must be redacted from all events.
   */
  paykey: string;
  customer_id: string;
  status: PaykeyStatus;
  status_details?: StatusDetails;
  label?: string; // e.g. "JPMORGAN CHASE BANK, NA - *6789" — safe to display
  institution_name?: string;
  source?: Extensible<"bank_account">;
  bank_data?: {
    routing_number: string; // returned UNMASKED — redaction must catch it
    account_number: string; // server-masked to last-4 ("*****6789")
    account_type: Extensible<AccountType>;
  };
  external_id?: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

/** Charge `config.sandbox_outcome` enum (api-notes §5). NEVER use the
 * `*_customer_dispute` outcomes in repeatable scenarios — R05 poisons the
 * paykey and the seeded account for >= 6 h. */
export type ChargeSandboxOutcome =
  | "standard"
  | "paid"
  | "on_hold_daily_limit"
  | "cancelled_for_fraud_risk"
  | "cancelled_for_balance_check"
  | "failed_insufficient_funds"
  | "reversed_insufficient_funds"
  | "failed_customer_dispute"
  | "reversed_customer_dispute"
  | "failed_closed_bank_account"
  | "reversed_closed_bank_account";

/** Charge `status` enum (api-notes §8) — extensible by rule. */
export type ChargeStatus = Extensible<
  | "created"
  | "scheduled"
  | "failed"
  | "cancelled"
  | "on_hold"
  | "pending"
  | "paid"
  | "reversed"
>;

/**
 * `config.balance_check` is a REQUIRED create field; "required" fails every
 * charge on balance-less bank_account paykeys — scenarios pin "disabled"
 * (api-notes §8 trap, §12 item 9).
 */
export type BalanceCheck = "required" | "enabled" | "disabled";

export type ConsentType = "internet" | "signed";

export interface ChargeInput {
  paykey: string; // the TOKEN from the bridge create response, not the paykey id
  amount: number; // integer cents (10000 = $100.00)
  currency: "USD"; // exactly "USD" — lowercase rejected with 422
  description: string;
  consent_type: ConsentType;
  device: DeviceInfo;
  external_id: string; // must be unique across all charges — run_id works
  payment_date: string; // YYYY-MM-DD
  config: {
    balance_check: BalanceCheck;
    sandbox_outcome?: ChargeSandboxOutcome;
    processing_method?: ProcessingMethod;
  };
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

/**
 * `status_history` entries are EVENT-level, not status-change-level (observed:
 * three consecutive `pending` entries) — transition derivation must dedupe
 * consecutive identical statuses. `changed_at` is the authoritative transition
 * time (poll wall-clock lags propagation).
 */
export interface ChargeStatusHistoryEntry extends StatusDetails {
  status: ChargeStatus;
}

export interface ChargeResult {
  id: string;
  status: ChargeStatus;
  status_details?: StatusDetails;
  status_history: ChargeStatusHistoryEntry[];
  amount: number;
  currency: string;
  description?: string;
  external_id: string; // echoed verbatim — carries the run_id
  payment_date?: string;
  paykey?: string; // masked by the server in charge responses; redact anyway
  effective_at?: string | null;
  processed_at?: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// The client boundary (spec §6)
// ---------------------------------------------------------------------------

/**
 * The ONLY surface through which the app talks to Straddle. Implemented by
 * the real adapter (client.ts) and the scripted mock (mock.ts). The client
 * receives the event bus at construction and emits `api.exchange` /
 * `retry.scheduled` itself; consumers never re-wrap HTTP telemetry. All
 * methods reject with StraddleApiError (errors.ts) on failure — immediately
 * for non-retryable 4xx (Scenario E depends on the 422 surfacing at once),
 * after exhausted retries for 429/5xx.
 */
export interface StraddleClient {
  health(): Promise<HealthResult>;
  createCustomer(input: CustomerInput): Promise<CustomerResult>;
  getCustomerReview(customerId: string): Promise<CustomerReviewResult>;
  createPaykey(input: PaykeyInput): Promise<PaykeyResult>;
  createCharge(input: ChargeInput): Promise<ChargeResult>;
  getCharge(chargeId: string): Promise<ChargeResult>;
}
