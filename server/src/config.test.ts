import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_PORT,
  ENV_VARS,
  loadConfig,
  parseEnvFile,
  POLL_POLICY_ENV_VARS,
  SANDBOX_BASE_URL,
} from "./config.js";

// SYNTHETIC fixture — never real key material (repo rule).
const FAKE_KEY = "sk_sandbox_FAKE_test_1234";

const tempDirs: string[] = [];
function tempEnvFile(contents: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sse-config-test-"));
  tempDirs.push(dir);
  const file = path.join(dir, ".env");
  writeFileSync(file, contents, "utf8");
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadConfig defaults", () => {
  it("boots with no key: keyPresent false, port 8787, pinned base URL", () => {
    const config = loadConfig({ env: {}, envFilePath: false });
    expect(config.keyPresent).toBe(false);
    expect(config.straddleApiKey).toBeUndefined();
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.port).toBe(8787);
    expect(config.sandboxBaseUrl).toBe("https://sandbox.straddle.io");
    expect(config.sandboxBaseUrl).toBe(SANDBOX_BASE_URL);
    expect(config.pollPolicyOverrides).toEqual({});
  });

  it("treats a blank STRADDLE_API_KEY as missing", () => {
    const config = loadConfig({
      env: { [ENV_VARS.apiKey]: "   " },
      envFilePath: false,
    });
    expect(config.keyPresent).toBe(false);
    expect(config.straddleApiKey).toBeUndefined();
  });
});

describe("loadConfig API key opacity", () => {
  const config = loadConfig({
    env: { [ENV_VARS.apiKey]: FAKE_KEY },
    envFilePath: false,
  });

  it("exposes the key only via explicit property access", () => {
    expect(config.keyPresent).toBe(true);
    expect(config.straddleApiKey).toBe(FAKE_KEY);
  });

  it("never leaks the key through JSON.stringify", () => {
    expect(JSON.stringify(config)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(config)).toContain("[REDACTED]");
  });

  it("never leaks the key through util.inspect / console.log", () => {
    expect(inspect(config)).not.toContain(FAKE_KEY);
  });

  it("never leaks the key through enumeration or spread", () => {
    expect(Object.keys(config)).not.toContain("straddleApiKey");
    expect(JSON.stringify({ ...config })).not.toContain(FAKE_KEY);
  });
});

describe("loadConfig webhook secret + unsigned flag", () => {
  // SYNTHETIC secret — never real key material (repo rule).
  const FAKE_SECRET = "whsec_ZmFrZS13ZWJob29rLXNlY3JldA==";

  it("defaults to no secret and unsigned disabled", () => {
    const config = loadConfig({ env: {}, envFilePath: false });
    expect(config.webhookSecretPresent).toBe(false);
    expect(config.straddleWebhookSecret).toBeUndefined();
    expect(config.allowUnsignedWebhooks).toBe(false);
  });

  it("parses the webhook secret and sets the present flag", () => {
    const config = loadConfig({
      env: { STRADDLE_WEBHOOK_SECRET: FAKE_SECRET },
      envFilePath: false,
    });
    expect(config.webhookSecretPresent).toBe(true);
    expect(config.straddleWebhookSecret).toBe(FAKE_SECRET);
  });

  it("treats a blank webhook secret as absent", () => {
    const config = loadConfig({
      env: { STRADDLE_WEBHOOK_SECRET: "   " },
      envFilePath: false,
    });
    expect(config.webhookSecretPresent).toBe(false);
    expect(config.straddleWebhookSecret).toBeUndefined();
  });

  it("never leaks the webhook secret through stringify / inspect / enumeration", () => {
    const config = loadConfig({
      env: { STRADDLE_WEBHOOK_SECRET: FAKE_SECRET },
      envFilePath: false,
    });
    expect(JSON.stringify(config)).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(config)).toContain("[REDACTED]");
    expect(inspect(config)).not.toContain(FAKE_SECRET);
    expect(Object.keys(config)).not.toContain("straddleWebhookSecret");
    expect(JSON.stringify({ ...config })).not.toContain(FAKE_SECRET);
  });

  it("parses WEBHOOK_ALLOW_UNSIGNED truthy values, defaults false otherwise", () => {
    for (const raw of ["1", "true", "YES", "on"]) {
      expect(
        loadConfig({ env: { WEBHOOK_ALLOW_UNSIGNED: raw }, envFilePath: false })
          .allowUnsignedWebhooks,
      ).toBe(true);
    }
    for (const raw of ["0", "false", "", "nope"]) {
      expect(
        loadConfig({ env: { WEBHOOK_ALLOW_UNSIGNED: raw }, envFilePath: false })
          .allowUnsignedWebhooks,
      ).toBe(false);
    }
  });
});

describe("loadConfig PORT", () => {
  it("parses a PORT override", () => {
    const config = loadConfig({ env: { PORT: "9090" }, envFilePath: false });
    expect(config.port).toBe(9090);
  });

  it("rejects a non-numeric PORT with ConfigError", () => {
    expect(() => loadConfig({ env: { PORT: "abc" }, envFilePath: false })).toThrow(
      ConfigError,
    );
  });

  it("rejects an out-of-range PORT", () => {
    expect(() => loadConfig({ env: { PORT: "70000" }, envFilePath: false })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ env: { PORT: "0" }, envFilePath: false })).toThrow(
      ConfigError,
    );
  });
});

describe("loadConfig poll-policy overrides (tests only)", () => {
  it("records the documented env var names", () => {
    expect(POLL_POLICY_ENV_VARS).toEqual({
      baseMinMs: "POLL_BASE_MIN_MS",
      baseMaxMs: "POLL_BASE_MAX_MS",
      fastMs: "POLL_FAST_MS",
      hardTimeoutMs: "POLL_HARD_TIMEOUT_MS",
    });
  });

  it("parses every override when set", () => {
    const config = loadConfig({
      env: {
        POLL_BASE_MIN_MS: "100",
        POLL_BASE_MAX_MS: "200",
        POLL_FAST_MS: "10",
        POLL_HARD_TIMEOUT_MS: "5000",
      },
      envFilePath: false,
    });
    expect(config.pollPolicyOverrides).toEqual({
      baseMinMs: 100,
      baseMaxMs: 200,
      fastMs: 10,
      hardTimeoutMs: 5000,
    });
  });

  it("omits keys whose env vars are unset", () => {
    const config = loadConfig({
      env: { POLL_FAST_MS: "10" },
      envFilePath: false,
    });
    expect(config.pollPolicyOverrides).toEqual({ fastMs: 10 });
    expect("baseMinMs" in config.pollPolicyOverrides).toBe(false);
  });

  it("rejects non-integer overrides with ConfigError", () => {
    expect(() =>
      loadConfig({ env: { POLL_FAST_MS: "fast" }, envFilePath: false }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ env: { POLL_FAST_MS: "-5" }, envFilePath: false }),
    ).toThrow(ConfigError);
  });
});

describe("parseEnvFile", () => {
  it("parses KEY=value with comments, export prefixes, and quotes", () => {
    const parsed = parseEnvFile(
      [
        "# a comment",
        "",
        `STRADDLE_API_KEY=${FAKE_KEY}`,
        "export PORT=9191",
        `QUOTED="hello world"`,
        `SINGLE='single quoted'`,
        "SPACED =  padded value  ",
        "not a valid line",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      STRADDLE_API_KEY: FAKE_KEY,
      PORT: "9191",
      QUOTED: "hello world",
      SINGLE: "single quoted",
      SPACED: "padded value",
    });
  });

  it("tolerates CRLF line endings", () => {
    expect(parseEnvFile("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });
});

describe("loadConfig .env file loading", () => {
  it("reads values from the .env file", () => {
    const file = tempEnvFile(`STRADDLE_API_KEY=${FAKE_KEY}\nPORT=9292\n`);
    const config = loadConfig({ env: {}, envFilePath: file });
    expect(config.keyPresent).toBe(true);
    expect(config.straddleApiKey).toBe(FAKE_KEY);
    expect(config.port).toBe(9292);
  });

  it("lets real environment variables win over the .env file", () => {
    const file = tempEnvFile(`PORT=9292\nSTRADDLE_API_KEY=sk_sandbox_FAKE_from_file\n`);
    const config = loadConfig({
      env: { PORT: "9393", STRADDLE_API_KEY: FAKE_KEY },
      envFilePath: file,
    });
    expect(config.port).toBe(9393);
    expect(config.straddleApiKey).toBe(FAKE_KEY);
  });

  it("never mutates process.env", () => {
    const sentinel = "SSE_CONFIG_TEST_SENTINEL_VAR";
    const file = tempEnvFile(`${sentinel}=leaked\nSTRADDLE_API_KEY=${FAKE_KEY}\n`);
    loadConfig({ env: {}, envFilePath: file });
    expect(process.env[sentinel]).toBeUndefined();
  });

  it("treats an explicitly-named missing file as no file", () => {
    const config = loadConfig({
      env: {},
      envFilePath: path.join(os.tmpdir(), "sse-definitely-missing", ".env"),
    });
    expect(config.keyPresent).toBe(false);
  });
});
