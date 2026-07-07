import { describe, expect, it } from "vitest";
import {
  createLogger,
  DEFAULT_LOG_LEVEL,
  LOG_LEVEL_ENV_VAR,
  REDACT_CENSOR,
  REDACT_PATHS,
} from "./logger.js";

// ALL fixtures are SYNTHETIC (repo rule): fake key, invented account/routing
// numbers, invented paykey-token-shaped string. Never captured sandbox output.
const FAKE_KEY = "sk_sandbox_FAKE_test_1234";
const FAKE_ACCOUNT = "000999888777";
const FAKE_ROUTING = "011000015";
const FAKE_PAYKEY = `deadbeef.01.${"a1".repeat(32)}`;

/** In-memory pino destination capturing raw log lines. */
function captureSink() {
  const lines: string[] = [];
  return {
    lines,
    output: () => lines.join(""),
    stream: {
      write(msg: string) {
        lines.push(msg);
      },
    },
  };
}

describe("createLogger level selection", () => {
  it("defaults to info", () => {
    const sink = captureSink();
    const log = createLogger({ env: {}, destination: sink.stream });
    expect(log.level).toBe(DEFAULT_LOG_LEVEL);
    log.trace("invisible");
    log.info("visible");
    expect(sink.output()).not.toContain("invisible");
    expect(sink.output()).toContain("visible");
  });

  it("reads LOG_LEVEL from the environment", () => {
    const log = createLogger({
      env: { [LOG_LEVEL_ENV_VAR]: "debug" },
      destination: captureSink().stream,
    });
    expect(log.level).toBe("debug");
  });

  it("prefers an explicit level over the env var", () => {
    const log = createLogger({
      level: "warn",
      env: { [LOG_LEVEL_ENV_VAR]: "debug" },
      destination: captureSink().stream,
    });
    expect(log.level).toBe("warn");
  });

  it("rejects an unknown level with a clear error", () => {
    expect(() =>
      createLogger({ env: { [LOG_LEVEL_ENV_VAR]: "verbose" } }),
    ).toThrow(/Unknown LOG_LEVEL "verbose"/);
  });
});

describe("createLogger redaction at the most verbose level (canary-style)", () => {
  it("masks a fake key and fake bank values wherever the redact paths reach", () => {
    const sink = captureSink();
    // "trace" is the most verbose configured level (spec §12 canary condition).
    const log = createLogger({ level: "trace", destination: sink.stream });

    log.trace({
      authorization: `Bearer ${FAKE_KEY}`,
      headers: {
        authorization: `Bearer ${FAKE_KEY}`,
        Authorization: `Bearer ${FAKE_KEY}`,
        "proxy-authorization": `Bearer ${FAKE_KEY}`,
      },
      response: { headers: { authorization: `Bearer ${FAKE_KEY}` } },
      apiKey: FAKE_KEY,
      api_key: FAKE_KEY,
      STRADDLE_API_KEY: FAKE_KEY,
      paykey: FAKE_PAYKEY,
      account_number: FAKE_ACCOUNT,
      bank_data: {
        account_number: FAKE_ACCOUNT,
        routing_number: FAKE_ROUTING,
      },
      data: {
        paykey: FAKE_PAYKEY,
        bank_data: {
          account_number: FAKE_ACCOUNT,
          routing_number: FAKE_ROUTING,
        },
      },
      customer: {
        name: "Fake Person",
        email: "fake@example.com",
        phone: "+15550001111",
        ssn: "000-00-0000",
        dob: "1970-01-01",
        ip_address: "192.0.2.1",
      },
      metadata: { anything: "user supplied" },
    });

    const output = sink.output();
    expect(sink.lines.length).toBe(1);
    for (const secret of [
      FAKE_KEY,
      FAKE_PAYKEY,
      FAKE_ACCOUNT,
      FAKE_ROUTING,
      "fake@example.com",
      "+15550001111",
      "000-00-0000",
      "192.0.2.1",
      "user supplied",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain(REDACT_CENSOR);
  });

  it("exports redact paths covering the mandatory keys", () => {
    for (const expected of [
      "authorization",
      "*.authorization",
      "*.headers.authorization",
      '*.headers["proxy-authorization"]',
      "account_number",
      "*.account_number",
      "data.*.account_number",
      "*.routing_number",
      "paykey",
      "*.paykey",
    ]) {
      expect(REDACT_PATHS).toContain(expected);
    }
  });
});

describe("createLogger restricted serializers (spec §8)", () => {
  it("reduces req to method/url/run/scenario ids — headers and body dropped", () => {
    const sink = captureSink();
    const log = createLogger({ level: "trace", destination: sink.stream });
    log.info({
      req: {
        method: "POST",
        url: "/v1/customers",
        run_id: "run-20260707T000000Z-a-ab12",
        scenario_id: "a",
        headers: { authorization: `Bearer ${FAKE_KEY}` },
        body: { account_number: FAKE_ACCOUNT },
      },
    });
    const output = sink.output();
    expect(output).toContain("/v1/customers");
    expect(output).toContain("run-20260707T000000Z-a-ab12");
    expect(output).not.toContain(FAKE_KEY);
    expect(output).not.toContain(FAKE_ACCOUNT);
    expect(output).not.toContain("headers");
    expect(output).not.toContain("body");
  });

  it("reduces res to its status code", () => {
    const sink = captureSink();
    const log = createLogger({ level: "trace", destination: sink.stream });
    log.info({ res: { statusCode: 201, headers: { "set-cookie": "nope" } } });
    const parsed = JSON.parse(sink.output()) as { res: unknown };
    expect(parsed.res).toEqual({ statusCode: 201 });
  });

  it("reduces exchange to method/path/status/latency/attempt/run/scenario", () => {
    const sink = captureSink();
    const log = createLogger({ level: "trace", destination: sink.stream });
    log.info({
      exchange: {
        method: "POST",
        path: "/v1/charges",
        status: 201,
        latency_ms: 210,
        attempt: 1,
        run_id: "run-20260707T000000Z-c-cd34",
        scenario_id: "c",
        request_body: { paykey: FAKE_PAYKEY },
        response_body: { data: { paykey: FAKE_PAYKEY } },
      },
    });
    const parsed = JSON.parse(sink.output()) as { exchange: unknown };
    expect(parsed.exchange).toEqual({
      method: "POST",
      path: "/v1/charges",
      status: 201,
      latency_ms: 210,
      attempt: 1,
      run_id: "run-20260707T000000Z-c-cd34",
      scenario_id: "c",
    });
    expect(sink.output()).not.toContain(FAKE_PAYKEY);
  });
});
