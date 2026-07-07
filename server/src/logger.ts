/**
 * Pino logger factory (spec §8, Layer 3 — defense in depth).
 *
 * Layer 1 (the server-side redactor at capture time) is the primary guarantee
 * that secrets never enter events; this factory is the mandatory backstop for
 * anything that reaches pino anyway:
 *
 * - `redact` paths cover the authorization header (every casing we can
 *   express) and a stricter accidental-log inventory
 *   (account/routing/paykey/tan/ssn/ein/dob/ip_address + customer evidence
 *   fields) at the nesting depths pino's fast-redact can express (top level,
 *   one wildcard parent, `*.headers.*`, `data.*.*`). UI/event payloads use
 *   Layer 1's narrower credential-redaction policy; logger defense-in-depth
 *   can be more conservative because raw HTTP bodies are never intentionally
 *   logged. fast-redact supports at most one wildcard per path, so arbitrary
 *   depth is Layer 1's job, not this one's.
 * - Serializers restrict `req`/`res`/`exchange` objects to method, URL,
 *   status, latency, attempt, and run/scenario IDs — raw HTTP bodies and
 *   headers are never logged anywhere (spec §8).
 * - Level comes from the LOG_LEVEL env var (default "info"). The §12 canary
 *   test runs at "trace" — the most verbose configured level.
 *
 * SDK/fetch debug logging is NOT controlled here: the Straddle client is
 * constructed with `logLevel: "off"` (api-notes §1), which overrides the
 * STRADDLE_LOG env var.
 */
import { pino } from "pino";
import type { DestinationStream, Logger, LoggerOptions } from "pino";

export const LOG_LEVEL_ENV_VAR = "LOG_LEVEL";
export const DEFAULT_LOG_LEVEL = "info";
export const REDACT_CENSOR = "[REDACTED]";

/** Authorization/key material — header casings + key-like field names. */
const AUTH_KEYS = [
  "authorization",
  "Authorization",
  "AUTHORIZATION",
  "proxy-authorization",
  "Proxy-Authorization",
  "apiKey",
  "api_key",
  "apikey",
  "straddleApiKey",
  "STRADDLE_API_KEY",
] as const;

/**
 * Accidental-log field names. `paykey` is the credential-like token;
 * `metadata` is censored wholesale when someone logs raw objects by mistake,
 * even though metadata is preserved in credential-redacted UI/event payloads.
 * NOTE: bare `name` is included; do not rely on pino's `name` option (we
 * never set it) and expect `err.name`-style fields to be censored — an
 * accepted cost of defense in depth.
 */
const SENSITIVE_FIELD_KEYS = [
  "account_number",
  "routing_number",
  "paykey",
  "tan",
  "ssn",
  "ein",
  "dob",
  "ip_address",
  "name",
  "email",
  "phone",
  "address1",
  "address2",
  "city",
  "state",
  "zip",
  "legal_business_name",
  "website",
  "metadata",
] as const;

/** fast-redact path segment for a key (bracket-quote non-identifier keys). */
function seg(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `["${key}"]`;
}

function pathsFor(key: string): string[] {
  const s = seg(key);
  const top = s.startsWith(".") ? s.slice(1) : s;
  return [
    top, //            e.g. account_number
    `*${s}`, //        e.g. bank_data.account_number, headers.authorization
    `*.headers${s}`, // e.g. req.headers.authorization
    `data.*${s}`, //   e.g. data.bank_data.account_number (envelope nesting)
  ];
}

/**
 * The mandatory redact path list (exported so tests and the §12 canary can
 * assert against it). One wildcard per path — a fast-redact constraint.
 */
export const REDACT_PATHS: readonly string[] = [
  ...AUTH_KEYS.flatMap(pathsFor),
  ...SENSITIVE_FIELD_KEYS.flatMap(pathsFor),
];

/**
 * Serializers restricted per spec §8: method, URL, status, latency,
 * run/scenario IDs. Anything else on a `req`/`res`/`exchange` object —
 * headers, bodies, params — is dropped before it can be serialized.
 */
type UnknownRecord = Record<string, unknown>;

function pick(source: UnknownRecord, keys: readonly string[]): UnknownRecord {
  const out: UnknownRecord = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

export const serializers: NonNullable<LoggerOptions["serializers"]> = {
  req(value: unknown) {
    if (typeof value !== "object" || value === null) return value;
    return pick(value as UnknownRecord, ["method", "url", "run_id", "scenario_id"]);
  },
  res(value: unknown) {
    if (typeof value !== "object" || value === null) return value;
    const res = value as UnknownRecord;
    return {
      statusCode: res["statusCode"] ?? res["status"],
    };
  },
  exchange(value: unknown) {
    if (typeof value !== "object" || value === null) return value;
    return pick(value as UnknownRecord, [
      "method",
      "path",
      "status",
      "latency_ms",
      "attempt",
      "run_id",
      "scenario_id",
    ]);
  },
};

export interface CreateLoggerOptions {
  /** Explicit level; wins over the LOG_LEVEL env var. */
  level?: string;
  /** Environment view for LOG_LEVEL lookup (default: process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Output stream — tests pass an in-memory sink. Default: stdout. */
  destination?: DestinationStream;
}

const VALID_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const env = options.env ?? process.env;
  const level = options.level ?? env[LOG_LEVEL_ENV_VAR] ?? DEFAULT_LOG_LEVEL;
  if (!VALID_LEVELS.has(level)) {
    throw new Error(
      `Unknown ${LOG_LEVEL_ENV_VAR} "${level}" — expected one of: ${[...VALID_LEVELS].join(", ")}`,
    );
  }

  const loggerOptions: LoggerOptions = {
    level,
    // No pid/hostname noise; log lines carry only what we put in them.
    base: undefined,
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACT_CENSOR,
    },
    serializers,
  };

  return options.destination ? pino(loggerOptions, options.destination) : pino(loggerOptions);
}
