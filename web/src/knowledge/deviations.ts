import type { ScenarioDef } from "@sse/shared";

/**
 * Documented sandbox deviations — the places the live sandbox contradicts
 * Straddle's docs or the original spec assumptions. dev-1…dev-22 mirror
 * api-notes.md §12's numbered list one-to-one (a coverage test enforces the
 * one-to-one mapping); the two dev-gate-* entries carry the Wave 4 live-gate
 * findings recorded in spec §18.8/§18.9. dev-18…dev-22 were added by the P2-0
 * API truth refresh.
 */
export interface DeviationNote {
  /** Stable id: dev-<n> for api-notes §12 item n. */
  id: string;
  headline: string;
  detail: string;
  source: string;
}

export const DEVIATIONS: readonly DeviationNote[] = [
  {
    id: "dev-1",
    headline: "The live sandbox never shows paid → reversed",
    detail:
      "reversed_* charge outcomes terminate as failed carrying the reversal R-code ~4 minutes after settlement would have happened, and never surface paid or reversed — contradicting Straddle's own sandbox guide. The documented paid → reversed sequence is demonstrated here via the mock client and replay; live Scenario C asserts the timing evidence instead.",
    source: "api-notes §9, §12.1",
  },
  {
    id: "dev-2",
    headline: "The reversal fast-poll window had to be justified differently",
    detail:
      "The poller's 5 s fast mode was meant to be tuned from the measured paid→reversed window, but that window is unobservable live. It stands anyway, justified by the deterministic ~241 s gap between the last pending event and the reversal-style terminal.",
    source: "api-notes §9, §12.2",
  },
  {
    id: "dev-3",
    headline: "Identity scores nest per module — no flat risk score exists",
    detail:
      "The review payload nests scores under identity_details.breakdown (fraud, email, phone, …). The summary shown here maps risk from breakdown.fraud.risk_score and correlation from breakdown.email.correlation_score, with documented fallbacks.",
    source: "api-notes §6, §12.3",
  },
  {
    id: "dev-4",
    headline: "identity_details.decision cannot be trusted",
    detail:
      'The sandbox returns decision: "accept" even for a customer forced to rejected — the review payload is canned synthetic data. The authoritative verification result is the customer\'s status field.',
    source: "api-notes §6, §12.4",
  },
  {
    id: "dev-5",
    headline: "The refusal point for rejected customers is paykey creation",
    detail:
      "POST /v1/bridge/bank_account for a rejected customer returns a deterministic 422. Refusal at charge creation is structurally unreachable — a charge needs a paykey token that can never exist.",
    source: "api-notes §10, §12.5",
  },
  {
    id: "dev-6",
    headline: "The invalid-key 401 has a completely empty body",
    detail:
      "There is no error body to render verbatim — zero bytes, no content type. The invalid-key screen shows the status line instead.",
    source: "api-notes §1, §12.6",
  },
  {
    id: "dev-7",
    headline: "No Retry-After header was ever observed",
    detail:
      "No rate-limit headers appeared on any response, so retry backoff is self-contained: exponential with jitter, honoring Retry-After only if it ever shows up.",
    source: "api-notes §3, §12.7",
  },
  {
    id: "dev-8",
    headline: "Customer identity settles synchronously",
    detail:
      "With inline processing the forced status is already terminal in the 201 create response — polling applies to charges only.",
    source: "api-notes §6, §12.8",
  },
  {
    id: "dev-9",
    headline: "config.balance_check is required, and 'required' breaks everything",
    detail:
      'The value "required" makes Watchtower fail every charge on a balance-less bank link — including forced paid outcomes. Scenario charges pin "disabled".',
    source: "api-notes §8, §12.9",
  },
  {
    id: "dev-10",
    headline: "Return-code evidence keys on source, never reason",
    detail:
      'Watchtower failures share reason: "insufficient_funds" with real bank declines but carry no R-code. The code lives at status_details.code and is absent — not null — when inapplicable.',
    source: "api-notes §8, §12.10",
  },
  {
    id: "dev-11",
    headline: "Seeded bank accounts carry mutable, poisonable state",
    detail:
      "An R05 dispute return permanently blocked the primary documented test account for new paykeys on this key. The engine prefers the spare documented account and never uses dispute outcomes in repeatable scenarios.",
    source: "api-notes §5, §9, §12.11",
  },
  {
    id: "dev-12",
    headline: "A fresh customer and paykey per run is mandatory",
    detail:
      "A dispute return permanently poisons a reused paykey — every later charge watchtower-fails. Each run creates its own customer and paykey.",
    source: "api-notes §9, §12.12",
  },
  {
    id: "dev-13",
    headline: "Error envelopes live under a top-level error key",
    detail:
      "Observed errors arrive as { error: { status, type, title, detail?, items? } } — not under data as the SDK docstring claims.",
    source: "api-notes §4, §12.13",
  },
  {
    id: "dev-14",
    headline: "Validation failures arrive in two shapes",
    detail:
      "400 /bad_request uses PascalCase dotted references (Device.IpAddress); 422 /validation_error uses lowercase ones (currency). Both are non-retryable; references match case-insensitively.",
    source: "api-notes §4, §12.14",
  },
  {
    id: "dev-15",
    headline: "Timestamp precision varies by endpoint",
    detail:
      "GET customer/review timestamps come back second-precision with no timezone suffix, while others carry 7-digit fractional seconds — strict datetime validators reject real responses.",
    source: "api-notes §4, §12.15",
  },
  {
    id: "dev-16",
    headline: "The SDK's default sandbox host differs from the pinned one",
    detail:
      "The SDK defaults to sandbox.straddle.com while this project pins sandbox.straddle.io (both work). The client always passes baseURL explicitly.",
    source: "api-notes §1, §12.16",
  },
  {
    id: "dev-17",
    headline: "Charge responses carry fields the SDK types don't know",
    detail:
      "GET /v1/charges/{id} returns trace_ids, has_refund, payment_rail, paykey_details, customer_details and more — consumers must tolerate unknown fields.",
    source: "api-notes §4, §12.17",
  },
  {
    id: "dev-18",
    headline: "R02 poisons a seeded account too — both are now blocked",
    detail:
      "A settled failed_closed_bank_account (R02) permanently blocks new paykey creation on that account, just like R05 — so both documented seeded accounts are now blocked on this key. The verified escape: arbitrary never-seeded account numbers create working paykeys, since the outcome is forced by sandbox_outcome rather than the account, so live runs should generate a random per-run account instead of reusing the shared seeded one.",
    source: "api-notes §5, §12.18",
  },
  {
    id: "dev-19",
    headline: "The cancel action verb yields a real cancelled status",
    detail:
      "No sandbox_outcome reaches cancelled, but the PUT /v1/charges/{id}/cancel action verb produces a genuine terminal cancelled (reason user_request, source user_action) — enabling a true-cancelled teaching scenario the forced outcomes cannot.",
    source: "api-notes §12.19, spec §18.8",
  },
  {
    id: "dev-20",
    headline: "Charge action endpoints behave with sharp edges",
    detail:
      "hold/release/cancel are live-verified: release resumes to created (not paid); release on a not-held charge is a 200 no-op; any action on a terminal charge is a 422; and two mutations in quick succession can return a transient, retryable 500 (\"Concurrency error for AggregateEventFields\").",
    source: "api-notes §12.20",
  },
  {
    id: "dev-21",
    headline: "Payouts are available on this sandbox key",
    detail:
      "POST /v1/payouts returns 201 — the spec had treated payouts as an unprobed lane. The create body omits config.balance_check and consent_type (charges-only), while the sandbox_outcome / status / source enums match charges. Lifecycle timing is unmeasured.",
    source: "api-notes §12.21",
  },
  {
    id: "dev-22",
    headline: "Webhooks are Svix-style and dashboard-configured",
    detail:
      "There is no webhook-management API on the sandbox host — endpoints and signing secrets are created in the dashboard. Signing uses webhook-id / webhook-timestamp / webhook-signature (HMAC-SHA256 over id.timestamp.body, a whsec_-prefixed secret). Charge reversals ride the generic charge.event.v1, not a dedicated event; live delivery is unverified without a public tunnel.",
    source: "api-notes §12.22, spec §18.1",
  },
  {
    id: "dev-gate-d",
    headline: "No sandbox path yields a cancelled charge",
    detail:
      "cancelled_for_fraud_risk terminates as failed in ~7 s with a structured watchtower reason (payment_blocked, no R-code); cancelled_for_balance_check never terminated in probing. The documented cancelled shape lives on in the mock; live Scenario D asserts the watchtower evidence.",
    source: "spec §18.8",
  },
  {
    id: "dev-gate-idem",
    headline: "Idempotency-Key values over ~40 chars are rejected",
    detail:
      "An undocumented length cap 400-rejects longer keys — 43-char run-id-derived values failed while 36-char UUIDs pass, so the engine sends UUIDs.",
    source: "api-notes §3, spec §18.9",
  },
];

export function deviationById(id: string): DeviationNote | undefined {
  return DEVIATIONS.find((d) => d.id === id);
}

/**
 * Timeline callouts, keyed STRUCTURALLY off the run.started def snapshot —
 * derived from the contract, never from string-matched labels (spec §19).
 * Live C/D defs assert deviation evidence (terminal callout); contract C's
 * provisional paid node gets the mirror note so mock/replay viewers learn
 * the live sandbox cannot show what they are watching.
 */
export interface TimelineDeviations {
  /** Callout under the terminal node. */
  terminal?: DeviationNote;
  /** Callout under the provisional-paid node. */
  provisional?: DeviationNote;
}

export function timelineDeviationsFor(scenario: ScenarioDef): TimelineDeviations {
  const observations = scenario.requiredObservations;
  if (scenario.id === "c") {
    const isLive = observations.some(
      (o) => o.kind === "terminal_status" && o.status === "failed",
    );
    if (isLive) {
      const dev = deviationById("dev-1");
      return dev === undefined ? {} : { terminal: dev };
    }
    const expectsOrdered = observations.some(
      (o) => o.kind === "ordered_statuses",
    );
    if (expectsOrdered) {
      const dev = deviationById("dev-1");
      return dev === undefined ? {} : { provisional: dev };
    }
  }
  if (scenario.id === "d") {
    const isLive = observations.some(
      (o) => o.kind === "terminal_status" && o.status === "failed",
    );
    if (isLive) {
      const dev = deviationById("dev-gate-d");
      return dev === undefined ? {} : { terminal: dev };
    }
  }
  return {};
}
