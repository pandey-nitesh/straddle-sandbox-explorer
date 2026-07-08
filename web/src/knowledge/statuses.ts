import type { KnowledgeEntry } from "./types";

/**
 * Status explanations, curated from api-notes.md §6 (customer), §7 (paykey),
 * and §8–§9 (charge lifecycle + measured timings). `term` is the verbatim
 * wire status; prose is ours.
 */

export const CHARGE_STATUSES: readonly KnowledgeEntry[] = [
  {
    id: "charge-status-created",
    term: "created",
    category: "charge-status",
    short:
      "Straddle accepted the charge; nothing has been sent to the bank network yet.",
    detail:
      "The first lifecycle state after POST /v1/charges. In the sandbox, scheduled follows within a few seconds.",
    source: "api-notes §8",
  },
  {
    id: "charge-status-scheduled",
    term: "scheduled",
    category: "charge-status",
    short:
      "Queued for the payment processor; the charge is waiting for its payment_date window.",
    detail:
      "Observed ~2.6–9.2 s after created. The sandbox processor picks scheduled charges up on a roughly once-a-minute tick.",
    source: "api-notes §8",
  },
  {
    id: "charge-status-pending",
    term: "pending",
    category: "charge-status",
    short:
      "Originated to the ACH network — the money is in flight between banks.",
    detail:
      "The sandbox processor runs about once a minute; the terminal status lands at effective_at = processed_at + 60 s exactly. status_history is event-level, so several consecutive pending entries with different progress messages are normal (originated, posted, received).",
    source: "api-notes §8",
  },
  {
    id: "charge-status-paid",
    term: "paid",
    category: "charge-status",
    short: "Terminal success — the debit settled and funds moved.",
    detail:
      "In ACH, settlement is not final: a return can still un-settle a paid charge days later. That is why reversal-expecting scenarios render paid as provisional until the return window passes. Plain paid outcomes take ~117 s in the sandbox.",
    source: "api-notes §8–§9",
  },
  {
    id: "charge-status-failed",
    term: "failed",
    category: "charge-status",
    short:
      "Terminal failure — the debit did not settle, or a simulated return landed.",
    detail:
      "When the bank declined, status_details.source is bank_decline and the ACH return code sits at status_details.code (e.g. R01). Watchtower blocks also terminate as failed but carry no code — distinguish by source, never by reason alone.",
    source: "api-notes §8",
  },
  {
    id: "charge-status-reversed",
    term: "reversed",
    category: "charge-status",
    short:
      "Settled money returned — the charge was paid, then the bank pulled it back.",
    detail:
      "This is the documented lifecycle for reversed_* sandbox outcomes (paid first, reversed minutes later). The live sandbox never actually surfaces it: reversed_* outcomes terminate as failed with the return code ~4 minutes after settlement would have happened. The mock client and replay demonstrate the documented shape.",
    source: "api-notes §9",
  },
  {
    id: "charge-status-cancelled",
    term: "cancelled",
    category: "charge-status",
    short:
      "Deliberately stopped before settlement — not a failure, a decision.",
    detail:
      "Carries structured reason detail in status_details. No observed sandbox path yields it live: cancelled_for_fraud_risk terminates as failed with a watchtower reason instead. The mock client keeps the documented cancelled shape.",
    source: "api-notes §8, §12",
  },
  {
    id: "charge-status-on_hold",
    term: "on_hold",
    category: "charge-status",
    short:
      "Paused pending action — in the enum for outcomes like on_hold_daily_limit.",
    detail: "Never observed live during M0 probing; treat as unverified.",
    source: "api-notes §8",
  },
];

export const CUSTOMER_STATUSES: readonly KnowledgeEntry[] = [
  {
    id: "customer-status-verified",
    term: "verified",
    category: "customer-status",
    short:
      "Identity checks passed — the customer can hold paykeys and be charged.",
    detail:
      "With the sandbox's inline processing, the forced status is already terminal in the 201 create response — no polling.",
    source: "api-notes §6",
  },
  {
    id: "customer-status-review",
    term: "review",
    category: "customer-status",
    short:
      "Identity needs a manual decision before the customer can transact.",
    source: "api-notes §6",
  },
  {
    id: "customer-status-rejected",
    term: "rejected",
    category: "customer-status",
    short:
      "Identity verification failed — downstream paykey creation is refused with a 422.",
    detail:
      "The customer's status field is the authoritative verification result. The review payload's identity_details.decision reads accept even for rejected customers — it is canned synthetic data; never key on it.",
    source: "api-notes §6, §10",
  },
  {
    id: "customer-status-pending",
    term: "pending",
    category: "customer-status",
    short:
      "Identity checks still running — not seen with the sandbox's inline processing.",
    source: "api-notes §6",
  },
  {
    id: "customer-status-inactive",
    term: "inactive",
    category: "customer-status",
    short: "Deactivated customer — in the enum, never observed live.",
    source: "api-notes §6",
  },
];

export const PAYKEY_STATUSES: readonly KnowledgeEntry[] = [
  {
    id: "paykey-status-active",
    term: "active",
    category: "paykey-status",
    short: "The bank link is usable — charges can be created against its token.",
    detail:
      "Settles synchronously in the bridge create response (~750 ms in the sandbox).",
    source: "api-notes §7",
  },
  {
    id: "paykey-status-pending",
    term: "pending",
    category: "paykey-status",
    short: "Bank link still settling — in the enum, never observed live.",
    source: "api-notes §7",
  },
  {
    id: "paykey-status-inactive",
    term: "inactive",
    category: "paykey-status",
    short: "Deactivated paykey — in the enum, never observed live.",
    source: "api-notes §7",
  },
  {
    id: "paykey-status-rejected",
    term: "rejected",
    category: "paykey-status",
    short: "The bank link was refused — in the enum, never observed live.",
    source: "api-notes §7",
  },
  {
    id: "paykey-status-review",
    term: "review",
    category: "paykey-status",
    short: "The bank link needs review — in the enum, never observed live.",
    source: "api-notes §7",
  },
];
