/**
 * cURL generation for wire-exchange rows (P2-1.1, design §6.3/§9).
 *
 * A teaching aid: the command lets a developer replay a redacted exchange.
 * SECRET-SAFETY IS STRUCTURAL. This module's only variable inputs are the
 * already-redacted projection fields (method, path, request body) — the
 * redactor ran server-side before capture (spec §8), and the browser never
 * holds an API key. Auth is a hard-coded PLACEHOLDER string; the generator has
 * no key to insert and never invents one. A real secret cannot enter output it
 * did not receive, and the auth line is a constant, so no key can appear.
 */

/** Spec §7 / server config SANDBOX_BASE_URL — the public sandbox host. Web must
 *  not import from server/, so the literal is re-stated here (it is public). */
const SANDBOX_BASE_URL = "https://sandbox.straddle.io";

/** Placeholder auth — NEVER a real key. The sole auth string this module emits. */
const AUTH_HEADER = "Authorization: Bearer $STRADDLE_API_KEY";
const CONTENT_TYPE_HEADER = "Content-Type: application/json";
/** Synthesized because headers never enter captures; keyed on create (POST),
 *  mirroring the knowledge module's endpoint-keyed Idempotency-Key note. */
const IDEMPOTENCY_HEADER = "Idempotency-Key: $(uuidgen)";

/**
 * The redacted exchange fields cURL needs. Structural subset of ExchangeEntry,
 * so an entry passes directly; only these fields ever reach the output.
 */
export interface CurlExchange {
  method: string;
  path: string;
  /** Already-redacted request body; absent for bodyless calls (e.g. GET polls). */
  requestBody?: unknown;
}

/** POSIX single-quote a value: wrap in `'…'`, escaping embedded quotes as `'\''`. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a runnable cURL command for one redacted exchange. Emits placeholder
 * auth, the method + sandbox URL, an Idempotency-Key note on POSTs, and the
 * redacted body as `-d` when present. Contains no secret by construction.
 */
export function toCurl(exchange: CurlExchange): string {
  const method = exchange.method.toUpperCase();
  const url = `${SANDBOX_BASE_URL}${exchange.path}`;
  const hasBody = exchange.requestBody !== undefined;

  const lines = [
    `curl -X ${method} ${shellSingleQuote(url)}`,
    `-H ${shellSingleQuote(AUTH_HEADER)}`,
  ];
  if (method === "POST") {
    lines.push(`-H ${shellSingleQuote(IDEMPOTENCY_HEADER)}`);
  }
  if (hasBody) {
    lines.push(`-H ${shellSingleQuote(CONTENT_TYPE_HEADER)}`);
    lines.push(`-d ${shellSingleQuote(JSON.stringify(exchange.requestBody))}`);
  }
  return lines.join(" \\\n  ");
}
