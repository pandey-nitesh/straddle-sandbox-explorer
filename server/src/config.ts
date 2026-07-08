/**
 * Server configuration (spec §4).
 *
 * Facts pinned here, never guessed:
 * - Sandbox base URL is a HARD-CODED constant (spec §7; api-notes §1/§12.16 —
 *   always passed explicitly to the SDK, never `environment: 'sandbox'`, never
 *   an env var, so the SDK's `STRADDLE_BASE_URL` env fallback can never apply).
 * - `STRADDLE_API_KEY` is OPTIONAL at load: the app must boot far enough to
 *   render the missing-key startup state (spec §10 / design §6.4). Consumers
 *   branch on `keyPresent`; the key itself is an opaque, non-enumerable field
 *   that never appears in `JSON.stringify`, `util.inspect`, or `Object.keys`
 *   output — never log it.
 * - Poll-policy env overrides exist for TESTS ONLY (spec §4). Production runs
 *   use the poller's own defaults (api-notes §9 recommended numbers).
 *
 * `.env` loading is done here with a tiny dependency-free parser (recorded
 * decision: no dotenv dependency). Loading is PURE — `process.env` is never
 * mutated; file values are merged UNDER real environment variables (real env
 * always wins), and the merged view exists only inside the returned Config.
 *
 * NOTE: `NODE_USE_ENV_PROXY` / `NODE_EXTRA_CA_CERTS` (api-notes §1 dev-container
 * note) are runtime-environment concerns for whoever launches the process —
 * deliberately NOT read or handled here.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

/** Spec §7: hard-coded sandbox host. Not configurable, by design. */
export const SANDBOX_BASE_URL = "https://sandbox.straddle.io";

export const DEFAULT_PORT = 8787;

/** Env var names read by loadConfig (single place they are spelled). */
export const ENV_VARS = {
  apiKey: "STRADDLE_API_KEY",
  port: "PORT",
  /** Optional Svix/Standard-Webhooks signing secret (`whsec_…`; api-notes §P12). */
  webhookSecret: "STRADDLE_WEBHOOK_SECRET",
  /**
   * Fixture/local-only flag (P2-3.2): when truthy AND no secret is configured,
   * the receiver accepts unsigned payloads marked unverified. Default off.
   */
  allowUnsignedWebhooks: "WEBHOOK_ALLOW_UNSIGNED",
} as const;

/**
 * Poll-policy override env vars — tests only (spec §4). Keys mirror the
 * PollPolicy field names the Wave 2 poller will consume (spec §6).
 */
export const POLL_POLICY_ENV_VARS = {
  baseMinMs: "POLL_BASE_MIN_MS",
  baseMaxMs: "POLL_BASE_MAX_MS",
  fastMs: "POLL_FAST_MS",
  hardTimeoutMs: "POLL_HARD_TIMEOUT_MS",
} as const;

export type PollPolicyOverrides = {
  readonly [K in keyof typeof POLL_POLICY_ENV_VARS]?: number;
};

export interface Config {
  /**
   * The raw `STRADDLE_API_KEY` value, or undefined when absent/blank.
   * Non-enumerable: invisible to JSON.stringify, util.inspect (and therefore
   * console.log), spread, and Object.keys. Read it explicitly, hand it only
   * to the Straddle client constructor, and never log it.
   */
  readonly straddleApiKey: string | undefined;
  /** True iff a non-blank STRADDLE_API_KEY was found (env or .env file). */
  readonly keyPresent: boolean;
  readonly port: number;
  /** Always {@link SANDBOX_BASE_URL}; carried on the object for convenience. */
  readonly sandboxBaseUrl: typeof SANDBOX_BASE_URL;
  /** Tests-only poll-policy overrides; keys absent when the env var is unset. */
  readonly pollPolicyOverrides: PollPolicyOverrides;
  /**
   * The raw `STRADDLE_WEBHOOK_SECRET` (`whsec_…`), or undefined when absent.
   * Non-enumerable and handled exactly like {@link straddleApiKey}: invisible
   * to JSON.stringify, util.inspect, spread, and Object.keys. Read it
   * explicitly, hand it only to the webhook verifier, and never log it
   * (api-notes §P12 redaction impact).
   */
  readonly straddleWebhookSecret: string | undefined;
  /** True iff a non-blank STRADDLE_WEBHOOK_SECRET was found (env or .env). */
  readonly webhookSecretPresent: boolean;
  /**
   * Fixture/local-only escape hatch (WEBHOOK_ALLOW_UNSIGNED). When true AND no
   * secret is configured, the receiver accepts unsigned payloads marked
   * unverified. It NEVER weakens signed mode; default false — never accept an
   * unsigned LIVE webhook (spec P2-3 risk, api-notes §P12).
   */
  readonly allowUnsignedWebhooks: boolean;
}

/** Thrown for malformed configuration values. Never echoes the API key. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** A read-only view of environment variables (subset of process.env). */
export type EnvView = Readonly<Record<string, string | undefined>>;

/**
 * Tiny .env parser. Supports: blank lines, full-line `#` comments, optional
 * `export ` prefix, `KEY=value`, and values wrapped in single or double
 * quotes (quotes stripped, no escape processing). No multi-line values, no
 * inline comments — .env.example only needs `STRADDLE_API_KEY=...`.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Strip a UTF-8 BOM if present, then split on LF (tolerating CRLF).
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue; // tolerate junk lines; this is a demo-tool parser
    const key = match[1];
    let value = match[2];
    if (key === undefined || value === undefined) continue;
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.trim();
    }
    out[key] = value;
  }
  return out;
}

/** Repo root, resolved relative to this module (server/src -> repo root). */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function resolveEnvFile(envFilePath: string | false | undefined): string | undefined {
  if (envFilePath === false) return undefined;
  if (typeof envFilePath === "string") {
    return existsSync(envFilePath) ? envFilePath : undefined;
  }
  // Default candidates: cwd first (npm scripts run from repo root), then the
  // module-relative repo root (covers tests/tools running from server/).
  for (const candidate of [
    path.resolve(process.cwd(), ".env"),
    path.join(REPO_ROOT, ".env"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function parsePositiveInt(
  name: string,
  raw: string,
  opts: { min: number; max: number },
): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new ConfigError(`${name} must be a non-negative integer, got "${raw}"`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < opts.min || value > opts.max) {
    throw new ConfigError(
      `${name} must be between ${opts.min} and ${opts.max}, got ${value}`,
    );
  }
  return value;
}

/** Truthy flag parser for boolean env vars: 1/true/yes/on (case-insensitive). */
function parseBoolFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export interface LoadConfigOptions {
  /** Environment view to read (default: process.env). Tests inject this. */
  env?: EnvView;
  /**
   * Path to a .env file, or `false` to skip file loading entirely.
   * Default: first existing of `<cwd>/.env`, `<repo root>/.env`.
   */
  envFilePath?: string | false;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;

  const file = resolveEnvFile(options.envFilePath);
  const fileVars = file ? parseEnvFile(readFileSync(file, "utf8")) : {};

  // Real environment variables win over .env file values (dotenv semantics).
  const get = (name: string): string | undefined => {
    const fromEnv = env[name];
    if (fromEnv !== undefined) return fromEnv;
    return fileVars[name];
  };

  const rawKey = get(ENV_VARS.apiKey);
  const apiKey = rawKey !== undefined && rawKey.trim() !== "" ? rawKey : undefined;

  const rawPort = get(ENV_VARS.port);
  const port =
    rawPort === undefined || rawPort.trim() === ""
      ? DEFAULT_PORT
      : parsePositiveInt(ENV_VARS.port, rawPort, { min: 1, max: 65535 });

  const pollPolicyOverrides: { -readonly [K in keyof PollPolicyOverrides]: number } = {};
  for (const field of Object.keys(POLL_POLICY_ENV_VARS) as Array<
    keyof typeof POLL_POLICY_ENV_VARS
  >) {
    const varName = POLL_POLICY_ENV_VARS[field];
    const raw = get(varName);
    if (raw === undefined || raw.trim() === "") continue;
    pollPolicyOverrides[field] = parsePositiveInt(varName, raw, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    });
  }

  const rawWebhookSecret = get(ENV_VARS.webhookSecret);
  const webhookSecret =
    rawWebhookSecret !== undefined && rawWebhookSecret.trim() !== ""
      ? rawWebhookSecret.trim()
      : undefined;
  const allowUnsignedWebhooks = parseBoolFlag(get(ENV_VARS.allowUnsignedWebhooks));

  const config = {
    keyPresent: apiKey !== undefined,
    port,
    sandboxBaseUrl: SANDBOX_BASE_URL,
    pollPolicyOverrides,
    webhookSecretPresent: webhookSecret !== undefined,
    allowUnsignedWebhooks,
  };

  // The key is attached as a NON-ENUMERABLE property so it cannot leak via
  // JSON.stringify, util.inspect/console.log, spread, or Object.keys. A
  // custom toJSON / inspect are added as belt-and-braces (also non-enumerable).
  Object.defineProperty(config, "straddleApiKey", {
    value: apiKey,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  // The webhook signing secret gets identical non-enumerable treatment — it is
  // key material (api-notes §P12) and must never leak via inspect/stringify.
  Object.defineProperty(config, "straddleWebhookSecret", {
    value: webhookSecret,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  const safeView = (): Record<string, unknown> => ({
    ...config,
    straddleApiKey: apiKey === undefined ? undefined : "[REDACTED]",
    straddleWebhookSecret: webhookSecret === undefined ? undefined : "[REDACTED]",
  });
  Object.defineProperty(config, "toJSON", {
    value: safeView,
    enumerable: false,
  });
  Object.defineProperty(config, inspect.custom, {
    value: safeView,
    enumerable: false,
  });

  return config as Config;
}
