/**
 * Layer-1 structural redaction (spec §8, api-notes.md §11).
 *
 * This module lives in server/ deliberately — nothing in web/ may ever need
 * it (spec §8). It is PURE: no logging, no I/O, no Node-specific APIs, no
 * mutation of inputs. Every masking transform is deterministic and
 * non-reversible.
 *
 * Masking formats (recorded decision):
 * - Account-like values (`account_number`, `routing_number`) keep the last 4
 *   characters when the value is long enough to stay non-reversible:
 *   `"987654321"` → `"•••4321"`. Values shorter than 8 characters are fully
 *   masked to `"[redacted]"` (last-4 of a short value would leak most of it).
 * - Everything else credential-like (key material, the paykey token, TAN,
 *   SSN/EIN/DOB, IP address, sensitive headers) masks to the fixed string
 *   `"[redacted]"`.
 * - Non-credential sandbox evidence (customer names, email/phone, addresses,
 *   metadata, review/status details, and error diagnostics) is preserved for
 *   the UI unless it contains one of the string-level secret/canary patterns.
 * - The seeded bank constants (public docs examples, but canary values per
 *   spec §8) are additionally masked WHEREVER they appear inside strings,
 *   not only under their field names — defense in depth for error echoes.
 *
 * Usage: construct once from config — `createRedactor({ apiKey })` — and
 * route every outbound event/result through `redactValue` (the single
 * deep-walk entry point). `redactBody` is an alias of `redactValue` so the
 * Straddle client's instrumented fetch reads naturally; `redactHeaders` and
 * `redactString` cover the two non-JSON shapes (header records, URLs/paths).
 */
import { SEEDED_BANK_CANARY_VALUES } from "@sse/shared";

// ---------------------------------------------------------------------------
// Field inventories (api-notes §11 — authoritative; never guessed)
// ---------------------------------------------------------------------------

/**
 * Fields masked keep-last-4 by NAME, case-insensitively, at any nesting depth
 * including arrays, in requests AND responses. Field-name matching catches
 * sandbox-generated values without knowing them in advance (spec §8).
 */
const LAST4_FIELD_NAMES = new Set(["account_number", "routing_number"]);

/**
 * Credential-sensitive fields fully masked by NAME (case-insensitive, any
 * depth, arrays included).
 * - `paykey`: the credential-like token — unmasked in the bridge create
 *   response, masked by Straddle in charge responses; we mask it everywhere.
 * - `tan`: POST /v1/bridge/tan (unused by us; masked anyway per api-notes).
 * - `ssn`, `ein`, `dob`: compliance_profile.* (if ever sent).
 * - `ip_address`: device.ip_address (raw in our requests).
 * Explicitly SAFE and kept as sandbox evidence: customer name/email/phone,
 * address fields, review/status details, metadata, `label`,
 * `institution_name`, and `external_id` (= run_id).
 */
const FULL_REDACT_FIELD_NAMES = new Set([
  "paykey",
  "tan",
  "ssn",
  "ein",
  "dob",
  "ip_address",
  // Key material should never appear in a JSON body, but error echoes exist
  // in principle — mask these field names too as defense in depth.
  "authorization",
  "api_key",
  "apikey",
]);

/**
 * Header names masked outright (case-insensitive). Beyond this exact list, a
 * key-like heuristic (/auth|key|token|secret|cookie|session/i) also masks —
 * except for the known-safe carriers below.
 */
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "authentication",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "cookie",
  "set-cookie",
]);

const KEY_LIKE_HEADER_PATTERN = /auth|key|token|secret|cookie|session/i;

/**
 * Headers that trip the key-like heuristic but carry no secret and stay
 * useful evidence: Idempotency-Key holds `<run_id>-<step>` (api-notes §3).
 */
const SAFE_HEADER_NAMES = new Set(["idempotency-key"]);

// ---------------------------------------------------------------------------
// String-level patterns (defense in depth for URLs, query strings, echoes)
// ---------------------------------------------------------------------------

/** Straddle sandbox/live secret-key shape (sk_sandbox_… per .env.example). */
const SK_TOKEN_PATTERN = /\bsk_[A-Za-z0-9_-]{4,}/g;

/** Any bearer credential, regardless of which key it carries. */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

/** The paykey token format `<8hex>.<2digit>.<64hex>` (api-notes §7). */
const PAYKEY_TOKEN_PATTERN = /\b[0-9a-f]{8}\.\d{2}\.[0-9a-f]{64}\b/gi;

/** Values of key-like query params in URLs/query strings. */
const QUERY_PARAM_PATTERN =
  /([?&](?:api[_-]?key|key|token|secret|auth(?:orization)?)=)[^&#\s]+/gi;

const MASK = "[redacted]";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Keep-last-4 mask; fully masks values too short to survive truncation.
 * Idempotent: already-masked values pass through unchanged so layered
 * defensive redaction (e.g. re-redacting a whole event) is stable.
 */
function maskLast4(value: string): string {
  if (value === MASK || /^•••.{0,4}$/.test(value)) return value;
  return value.length >= 8 ? `•••${value.slice(-4)}` : MASK;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface CreateRedactorOptions {
  /**
   * The live API key VALUE, from config — never hard-coded. Optional so the
   * missing-key startup path can still construct a redactor; when present it
   * is masked wherever it appears in any string, URL, or body.
   */
  apiKey?: string;
  /**
   * Extra known-sensitive literal values to mask inside strings (appended to
   * the built-in seeded-bank canary values). Tests use this; the app usually
   * does not need it.
   */
  extraSensitiveValues?: readonly string[];
}

export type HeaderValue = string | number | readonly string[] | undefined;

export interface Redactor {
  /** THE entry point: deep-walks any JSON-ish value; returns a new value. */
  redactValue(value: unknown): unknown;
  /** Alias of redactValue, named for the instrumented-fetch call site. */
  redactBody(body: unknown): unknown;
  /** Masks sensitive header names and scrubs remaining string values. */
  redactHeaders(
    headers: Readonly<Record<string, HeaderValue>>,
  ): Record<string, HeaderValue>;
  /** Scrubs key material / known values / token shapes from one string. */
  redactString(s: string): string;
}

export function createRedactor(options: CreateRedactorOptions = {}): Redactor {
  // Literal values masked inside ANY string. Longer values replace first so
  // an overlapping shorter value cannot split a longer match.
  const valueReplacements: Array<{ pattern: RegExp; replacement: string }> = [];

  const addSensitiveValue = (raw: string, replacement: string): void => {
    if (raw.length === 0) return;
    valueReplacements.push({
      pattern: new RegExp(escapeRegExp(raw), "g"),
      replacement,
    });
    const encoded = encodeURIComponent(raw);
    if (encoded !== raw) {
      valueReplacements.push({
        pattern: new RegExp(escapeRegExp(encoded), "g"),
        replacement,
      });
    }
  };

  const literals: Array<{ raw: string; replacement: string }> = [];
  if (options.apiKey !== undefined && options.apiKey.length > 0) {
    literals.push({ raw: options.apiKey, replacement: MASK });
  }
  for (const v of SEEDED_BANK_CANARY_VALUES) {
    literals.push({ raw: v, replacement: maskLast4(v) });
  }
  for (const v of options.extraSensitiveValues ?? []) {
    literals.push({ raw: v, replacement: MASK });
  }
  literals.sort((a, b) => b.raw.length - a.raw.length);
  for (const { raw, replacement } of literals) {
    addSensitiveValue(raw, replacement);
  }

  function redactString(s: string): string {
    let out = s;
    for (const { pattern, replacement } of valueReplacements) {
      out = out.replace(pattern, replacement);
    }
    out = out.replace(SK_TOKEN_PATTERN, MASK);
    out = out.replace(BEARER_PATTERN, `Bearer ${MASK}`);
    out = out.replace(PAYKEY_TOKEN_PATTERN, MASK);
    out = out.replace(QUERY_PARAM_PATTERN, `$1${MASK}`);
    return out;
  }

  function walk(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return redactString(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      result = value.map((item) => walk(item, seen));
    } else {
      const out: Record<string, unknown> = {};
      // Own enumerable string keys only — covers plain JSON objects and
      // class-instance error bodies alike.
      for (const [key, v] of Object.entries(value)) {
        const lower = key.toLowerCase();
        if (FULL_REDACT_FIELD_NAMES.has(lower)) {
          out[key] = MASK;
        } else if (LAST4_FIELD_NAMES.has(lower)) {
          out[key] = typeof v === "string" ? maskLast4(v) : MASK;
        } else {
          out[key] = walk(v, seen);
        }
      }
      result = out;
    }
    seen.delete(value);
    return result;
  }

  function redactValue(value: unknown): unknown {
    return walk(value, new WeakSet());
  }

  function isSensitiveHeaderName(name: string): boolean {
    const lower = name.toLowerCase();
    if (SAFE_HEADER_NAMES.has(lower)) return false;
    return (
      SENSITIVE_HEADER_NAMES.has(lower) || KEY_LIKE_HEADER_PATTERN.test(lower)
    );
  }

  function redactHeaders(
    headers: Readonly<Record<string, HeaderValue>>,
  ): Record<string, HeaderValue> {
    const out: Record<string, HeaderValue> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) {
        out[name] = undefined;
      } else if (isSensitiveHeaderName(name)) {
        out[name] = Array.isArray(value) ? value.map(() => MASK) : MASK;
      } else if (typeof value === "string") {
        out[name] = redactString(value);
      } else if (Array.isArray(value)) {
        out[name] = value.map((v: string) => redactString(v));
      } else {
        out[name] = value;
      }
    }
    return out;
  }

  return { redactValue, redactBody: redactValue, redactHeaders, redactString };
}
