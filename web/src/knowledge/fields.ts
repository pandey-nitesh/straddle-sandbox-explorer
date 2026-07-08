/**
 * "Fields to notice" — curated field-level teaching notes for the wire log
 * (design §6.6). Sourced from api-notes.md; paths verified against real
 * redacted recordings (request/response shapes in api-notes §4–§8). A note
 * appears only when its field is actually present in the exchange being
 * inspected — except header notes, which describe request headers the event
 * stream deliberately never captures.
 */

export interface FieldNote {
  /** Display path, verbatim wire vocabulary — `config.sandbox_outcome`. */
  path: string;
  /** One-sentence prose fact, our voice. */
  short: string;
  /** api-notes.md / spec citation. */
  source: string;
}

interface FieldNoteDef extends FieldNote {
  /** Dot paths to probe for presence; array indices are probed as [0]. */
  checkPaths: { in: "request" | "response"; path: string }[];
}

const FIELD_NOTES: readonly FieldNoteDef[] = [
  {
    path: "config.sandbox_outcome",
    short:
      "Forces this resource's sandbox result — but never bypasses business rules (a rejected customer's paykey create is still refused).",
    source: "api-notes §5",
    checkPaths: [
      { in: "request", path: "config.sandbox_outcome" },
      { in: "response", path: "data.config.sandbox_outcome" },
    ],
  },
  {
    path: "config.balance_check",
    short:
      'Required on charge creation; pinned to "disabled" here because "required" makes Watchtower fail every charge on a balance-less bank link.',
    source: "api-notes §8",
    checkPaths: [
      { in: "request", path: "config.balance_check" },
      { in: "response", path: "data.config.balance_check" },
    ],
  },
  {
    path: "external_id",
    short:
      "Echoed back verbatim and must be unique across all charges — this app sends the run id, which ties every wire object to its run.",
    source: "api-notes §4, §8",
    checkPaths: [
      { in: "request", path: "external_id" },
      { in: "response", path: "data.external_id" },
    ],
  },
  {
    path: "meta.api_request_id",
    short:
      "The only request trace id Straddle returns — there is no request-id response header.",
    source: "api-notes §3",
    checkPaths: [{ in: "response", path: "meta.api_request_id" }],
  },
  {
    path: "paykey",
    short:
      "Charges reference the paykey token, not the paykey id; the token is credential-class — raw only in the bridge create response, masked everywhere after.",
    source: "api-notes §7",
    checkPaths: [
      { in: "request", path: "paykey" },
      { in: "response", path: "data.paykey" },
    ],
  },
  {
    path: "amount",
    short: "Integer cents — 10000 is $100.00.",
    source: "api-notes §8",
    checkPaths: [{ in: "request", path: "amount" }],
  },
  {
    path: "currency",
    short: 'Exactly "USD" — lowercase "usd" is rejected with a 422.',
    source: "api-notes §8",
    checkPaths: [{ in: "request", path: "currency" }],
  },
  {
    path: "device.ip_address",
    short:
      'Required on customers and charges; "0.0.0.0" means offline registration, and the server masks it in responses.',
    source: "api-notes §6",
    checkPaths: [
      { in: "request", path: "device.ip_address" },
      { in: "response", path: "data.device.ip_address" },
    ],
  },
  {
    path: "status_details.code",
    short:
      "The ACH return-code slot — absent (not null) when inapplicable, and watchtower failures never carry one: key on source, never on reason alone.",
    source: "api-notes §8",
    checkPaths: [{ in: "response", path: "data.status_details.code" }],
  },
  {
    path: "status_details.source",
    short:
      "Who decided the current status — watchtower, bank_decline, customer_dispute, user_action, or system. Bank-decline evidence keys on this.",
    source: "api-notes §8",
    checkPaths: [{ in: "response", path: "data.status_details.source" }],
  },
  {
    path: "status_history",
    short:
      "Event-level, not transition-level — consecutive identical statuses are normal, and changed_at (not poll time) is the authoritative transition time.",
    source: "api-notes §8",
    checkPaths: [{ in: "response", path: "data.status_history.[0]" }],
  },
  {
    path: "identity_details.decision",
    short:
      'Canned synthetic data — it reads "accept" even for a rejected customer. The customer\'s status field is the real verification result.',
    source: "api-notes §6",
    checkPaths: [{ in: "response", path: "data.identity_details.decision" }],
  },
  {
    path: "bank_data.account_number",
    short:
      "Masked to last-4 by the server itself; the raw value exists only in the create request (and is redacted before capture here).",
    source: "api-notes §7, §11",
    checkPaths: [{ in: "response", path: "data.bank_data.account_number" }],
  },
];

/** Header note — request headers never enter the event stream (they can carry
 *  auth material), so this is keyed by endpoint, not by body presence. */
const IDEMPOTENCY_NOTE: FieldNote = {
  path: "Idempotency-Key (header)",
  short:
    "Sent on every create (not shown — headers stay out of captures). The server replays identical requests instead of duplicating, and values over ~40 chars are rejected, so the engine sends UUIDs.",
  source: "api-notes §3, spec §18.9",
};

const IDEMPOTENT_CREATES = new Set([
  "/v1/customers",
  "/v1/bridge/bank_account",
  "/v1/charges",
]);

function valueAtPath(body: unknown, dotPath: string): unknown {
  let current: unknown = body;
  for (const segment of dotPath.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (segment === "[0]") {
      if (!Array.isArray(current)) return undefined;
      current = current[0];
      continue;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * The notes whose fields are actually present in this exchange, in curated
 * order. Read-only inspection of the already-redacted bodies.
 */
export function fieldNotesFor(
  method: string,
  path: string,
  requestBody: unknown,
  responseBody: unknown,
): FieldNote[] {
  const notes: FieldNote[] = [];
  const cleanPath = path.split("?")[0] ?? path;
  if (method.toUpperCase() === "POST" && IDEMPOTENT_CREATES.has(cleanPath)) {
    notes.push(IDEMPOTENCY_NOTE);
  }
  for (const def of FIELD_NOTES) {
    const present = def.checkPaths.some(({ in: where, path: checkPath }) => {
      const body = where === "request" ? requestBody : responseBody;
      return body !== undefined && valueAtPath(body, checkPath) !== undefined;
    });
    if (present) {
      notes.push({ path: def.path, short: def.short, source: def.source });
    }
  }
  return notes;
}
