import type { EndpointEntry } from "./types";

/**
 * "What this call does" notes for the wire log, curated from api-notes.md §2
 * (endpoint table) and the resource sections. Pattern segments in braces
 * match any value; matching is segment-exact, no regex from data.
 */
export const ENDPOINTS: readonly EndpointEntry[] = [
  {
    id: "endpoint-list-customers",
    term: "GET /v1/customers",
    category: "endpoint",
    method: "GET",
    pattern: "/v1/customers",
    short:
      "Lists customers — doubles as the auth ping, since Straddle has no dedicated health endpoint.",
    source: "api-notes §2",
  },
  {
    id: "endpoint-create-customer",
    term: "POST /v1/customers",
    category: "endpoint",
    method: "POST",
    pattern: "/v1/customers",
    short:
      "Creates the customer and runs identity verification — with inline processing the forced status is already terminal in this 201.",
    detail:
      "config.sandbox_outcome forces the identity result. Requires name, type, email, phone, and device.ip_address (0.0.0.0 means offline registration).",
    source: "api-notes §2, §6",
  },
  {
    id: "endpoint-get-customer",
    term: "GET /v1/customers/{id}",
    category: "endpoint",
    method: "GET",
    pattern: "/v1/customers/{id}",
    short: "Fetches one customer, including its current identity status.",
    source: "api-notes §2",
  },
  {
    id: "endpoint-customer-review",
    term: "GET /v1/customers/{id}/review",
    category: "endpoint",
    method: "GET",
    pattern: "/v1/customers/{id}/review",
    short:
      "Fetches the identity evidence behind the decision — per-module scores and reason codes. Works for customers in every status.",
    detail:
      "The authoritative verification result is the customer's status field; identity_details.decision in this payload is canned synthetic data and reads accept even for rejected customers.",
    source: "api-notes §2, §6",
  },
  {
    id: "endpoint-create-paykey",
    term: "POST /v1/bridge/bank_account",
    category: "endpoint",
    method: "POST",
    pattern: "/v1/bridge/bank_account",
    short:
      "Links a bank account and mints the paykey — note the path: paykeys are created through Bridge, there is no POST /v1/paykeys.",
    detail:
      "The response is the only place the paykey token appears unmasked; charges reference the token, not the paykey id. For a rejected customer this call is refused with a deterministic 422.",
    source: "api-notes §2, §7, §10",
  },
  {
    id: "endpoint-get-paykey",
    term: "GET /v1/paykeys/{id}",
    category: "endpoint",
    method: "GET",
    pattern: "/v1/paykeys/{id}",
    short: "Fetches one paykey (token masked here — it is only raw at create).",
    source: "api-notes §2, §7",
  },
  {
    id: "endpoint-create-charge",
    term: "POST /v1/charges",
    category: "endpoint",
    method: "POST",
    pattern: "/v1/charges",
    short:
      "Creates the ACH debit against a paykey token, with consent metadata and a payment date.",
    detail:
      "amount is integer cents; currency must be exactly USD; external_id must be unique across all charges (the run id works); config.balance_check is required and pinned to disabled — required fails every charge on a balance-less bank link.",
    source: "api-notes §2, §8",
  },
  {
    id: "endpoint-get-charge",
    term: "GET /v1/charges/{id}",
    category: "endpoint",
    method: "GET",
    pattern: "/v1/charges/{id}",
    short:
      "Polls the charge lifecycle — status, status_details, and the event-level status_history.",
    detail:
      "status_history[].changed_at is the authoritative transition time (polling lags it); consecutive identical statuses are normal because entries are events, not transitions.",
    source: "api-notes §2, §8",
  },
];

/** Segment-exact matcher: "{x}" pattern segments match any one path segment. */
export function matchEndpoint(
  method: string,
  path: string,
): EndpointEntry | undefined {
  const cleanPath = path.split("?")[0] ?? path;
  const segments = cleanPath.split("/").filter((s) => s.length > 0);
  return ENDPOINTS.find((entry) => {
    if (entry.method !== method.toUpperCase()) return false;
    const patternSegments = entry.pattern.split("/").filter((s) => s.length > 0);
    if (patternSegments.length !== segments.length) return false;
    return patternSegments.every(
      (p, i) => p.startsWith("{") || p === segments[i],
    );
  });
}
