import type { OutcomeEntry } from "./types";

/**
 * config.sandbox_outcome explanations, curated from api-notes.md §5 (enums +
 * scenario mapping + destructive-state rules), §8 (measured lifecycle), and
 * §9 (reversed_* live behavior). The forcing field appears in the create body
 * of all three resources; forcing does not bypass business rules (a rejected
 * customer's paykey create is refused even with sandbox_outcome: "active").
 */

export const CUSTOMER_OUTCOMES: readonly OutcomeEntry[] = [
  {
    id: "outcome-customer-standard",
    term: "standard",
    category: "sandbox-outcome",
    resource: "customer",
    short:
      "No forcing — the sandbox runs its default identity evaluation (result not recorded in api-notes).",
    danger: "safe",
    source: "api-notes §5",
  },
  {
    id: "outcome-customer-verified",
    term: "verified",
    category: "sandbox-outcome",
    resource: "customer",
    short:
      "Forces the customer's identity to pass — status is verified in the 201 itself.",
    expectedTerminal: "verified",
    timing: "synchronous — terminal in the create response",
    danger: "safe",
    source: "api-notes §5, §6",
  },
  {
    id: "outcome-customer-review",
    term: "review",
    category: "sandbox-outcome",
    resource: "customer",
    short: "Forces the customer into manual identity review.",
    expectedTerminal: "review",
    timing: "synchronous — terminal in the create response",
    danger: "safe",
    source: "api-notes §5, §6",
  },
  {
    id: "outcome-customer-rejected",
    term: "rejected",
    category: "sandbox-outcome",
    resource: "customer",
    short:
      "Forces identity rejection — any later paykey create for this customer is refused with a 422.",
    expectedTerminal: "rejected",
    timing: "synchronous — terminal in the create response",
    danger: "safe",
    source: "api-notes §5, §10",
  },
];

export const PAYKEY_OUTCOMES: readonly OutcomeEntry[] = [
  {
    id: "outcome-paykey-standard",
    term: "standard",
    category: "sandbox-outcome",
    resource: "paykey",
    short:
      "No forcing — the sandbox runs its default bank-link path (result not recorded in api-notes).",
    danger: "safe",
    source: "api-notes §5",
  },
  {
    id: "outcome-paykey-active",
    term: "active",
    category: "sandbox-outcome",
    resource: "paykey",
    short: "Forces the bank link to settle as active, synchronously.",
    expectedTerminal: "active",
    timing: "synchronous — ~750 ms",
    danger: "safe",
    source: "api-notes §5, §7",
  },
  {
    id: "outcome-paykey-rejected",
    term: "rejected",
    category: "sandbox-outcome",
    resource: "paykey",
    short: "Forces the bank link to be refused.",
    expectedTerminal: "rejected",
    danger: "safe",
    source: "api-notes §5",
  },
  {
    id: "outcome-paykey-review",
    term: "review",
    category: "sandbox-outcome",
    resource: "paykey",
    short: "Forces the bank link into review.",
    expectedTerminal: "review",
    danger: "safe",
    source: "api-notes §5",
  },
];

export const CHARGE_OUTCOMES: readonly OutcomeEntry[] = [
  {
    id: "outcome-charge-standard",
    term: "standard",
    category: "sandbox-outcome",
    resource: "charge",
    short:
      "No forcing — the sandbox runs its default charge path (result not recorded in api-notes).",
    danger: "safe",
    source: "api-notes §5",
  },
  {
    id: "outcome-charge-paid",
    term: "paid",
    category: "sandbox-outcome",
    resource: "charge",
    short: "Forces a clean settlement.",
    expectedTerminal: "paid",
    timing: "~117 s from create to terminal",
    danger: "safe",
    source: "api-notes §5, §8",
  },
  {
    id: "outcome-charge-on_hold_daily_limit",
    term: "on_hold_daily_limit",
    category: "sandbox-outcome",
    resource: "charge",
    short: "Forces a daily-limit hold.",
    expectedTerminal: "on_hold",
    timing: "unmeasured — never probed live",
    danger: "safe",
    source: "api-notes §5",
  },
  {
    id: "outcome-charge-cancelled_for_fraud_risk",
    term: "cancelled_for_fraud_risk",
    category: "sandbox-outcome",
    resource: "charge",
    short:
      "Simulates a Watchtower fraud block — documented as cancelled, but the live sandbox terminates it as failed with a structured payment_blocked reason.",
    expectedTerminal: "failed",
    timing: "~7 s — Watchtower blocks before the bank lifecycle starts",
    danger: "safe",
    source: "api-notes §5, §12",
  },
  {
    id: "outcome-charge-cancelled_for_balance_check",
    term: "cancelled_for_balance_check",
    category: "sandbox-outcome",
    resource: "charge",
    short:
      "Simulates a balance-check cancellation — in live probing the charge ran the full bank lifecycle and never terminated.",
    timing: "unverified — still pending 8+ minutes after the last history event",
    danger: "safe",
    source: "api-notes §12",
  },
  {
    id: "outcome-charge-failed_insufficient_funds",
    term: "failed_insufficient_funds",
    category: "sandbox-outcome",
    resource: "charge",
    short: "Forces a bank decline for insufficient funds.",
    expectedTerminal: "failed",
    returnCode: "R01",
    timing: "~117 s from create to terminal",
    danger: "safe",
    source: "api-notes §5, §8",
  },
  {
    id: "outcome-charge-reversed_insufficient_funds",
    term: "reversed_insufficient_funds",
    category: "sandbox-outcome",
    resource: "charge",
    short:
      "Documented as paid then reversed minutes later — live, it terminates as failed with the R01 landing ~4 minutes after the money would have settled.",
    expectedTerminal: "failed",
    returnCode: "R01",
    timing: "~5 m 50 s total; the return lands ~241 s after the last pending event",
    danger: "safe",
    source: "api-notes §5, §9",
  },
  {
    id: "outcome-charge-failed_customer_dispute",
    term: "failed_customer_dispute",
    category: "sandbox-outcome",
    resource: "charge",
    short:
      "Forces an R05 dispute return — never use it: R05 permanently blocks the paykey and the seeded bank account.",
    expectedTerminal: "failed",
    returnCode: "R05",
    danger: "poisons",
    source: "api-notes §5, §9",
  },
  {
    id: "outcome-charge-reversed_customer_dispute",
    term: "reversed_customer_dispute",
    category: "sandbox-outcome",
    resource: "charge",
    short:
      "Forces a settled-then-disputed R05 return — never use it: R05 permanently blocks the paykey and the seeded bank account.",
    expectedTerminal: "failed",
    returnCode: "R05",
    danger: "poisons",
    source: "api-notes §5, §9",
  },
  {
    id: "outcome-charge-failed_closed_bank_account",
    term: "failed_closed_bank_account",
    category: "sandbox-outcome",
    resource: "charge",
    short: "Forces a closed-account bank decline.",
    expectedTerminal: "failed",
    returnCode: "R02",
    timing: "unmeasured — never probed live",
    danger: "safe",
    source: "api-notes §5",
  },
  {
    id: "outcome-charge-reversed_closed_bank_account",
    term: "reversed_closed_bank_account",
    category: "sandbox-outcome",
    resource: "charge",
    short: "Forces a settled-then-returned closed-account reversal.",
    expectedTerminal: "failed",
    returnCode: "R02",
    timing: "unmeasured — never probed live",
    danger: "safe",
    source: "api-notes §5",
  },
];

export const ALL_OUTCOMES: readonly OutcomeEntry[] = [
  ...CUSTOMER_OUTCOMES,
  ...PAYKEY_OUTCOMES,
  ...CHARGE_OUTCOMES,
];
