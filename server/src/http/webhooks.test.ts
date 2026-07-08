import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { RunEvent, ScenarioDef } from "@sse/shared";
import { loadConfig } from "../config.js";
import { createRedactor } from "../redaction.js";
import { createBus } from "../engine/bus.js";
import { createRunRegistry } from "../engine/registry.js";
import { createHttpServer } from "./server.js";
import {
  createWebhookInbox,
  verifyStandardWebhookSignature,
  type InboxStatus,
  type WebhookInboxEntry,
} from "./webhooks.js";

// SYNTHETIC signing secret — never real key material (repo rule). `whsec_` +
// base64 of arbitrary bytes, matching the api-notes §P12 secret shape.
const TEST_SECRET = "whsec_" + Buffer.from("test-signing-secret-01234567").toString("base64");
const OTHER_SECRET = "whsec_" + Buffer.from("a-different-secret-9876543210").toString("base64");

/** Independent signer (does not call the verifier) for `webhook-signature`. */
function sign(secret: string, id: string, ts: string, body: string): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`, "utf8").digest("base64");
  return `v1,${sig}`;
}

function nowSec(): string {
  return String(Math.floor(Date.now() / 1000));
}

interface WebhookHeaders {
  id?: string;
  timestamp?: string;
  signature?: string;
}

async function makeApp(env: Record<string, string>): Promise<FastifyInstance> {
  return createHttpServer({
    config: loadConfig({ env, envFilePath: false }),
    epoch: "test-epoch",
    mockMode: true,
    attachRecorder: false,
    rehydrate: false,
    serveStatic: false,
    logger: false,
  });
}

async function post(
  app: FastifyInstance,
  body: string | Buffer,
  headers: WebhookHeaders,
): Promise<{ statusCode: number; json: () => { status: InboxStatus; reason?: string; verified?: boolean; event_id?: string } }> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (headers.id !== undefined) h["webhook-id"] = headers.id;
  if (headers.timestamp !== undefined) h["webhook-timestamp"] = headers.timestamp;
  if (headers.signature !== undefined) h["webhook-signature"] = headers.signature;
  const res = await app.inject({ method: "POST", url: "/api/webhooks/straddle", payload: body, headers: h });
  return { statusCode: res.statusCode, json: () => res.json() };
}

async function listInbox(app: FastifyInstance): Promise<WebhookInboxEntry[]> {
  const res = await app.inject({ method: "GET", url: "/api/webhooks" });
  expect(res.statusCode).toBe(200);
  return res.json<{ webhooks: WebhookInboxEntry[] }>().webhooks;
}

describe("verifyStandardWebhookSignature (unit)", () => {
  const id = "msg_123";
  const ts = nowSec();
  const body = JSON.stringify({ type: "charge.event.v1", data: { id: "chg_1" } });

  it("accepts a correctly signed payload", () => {
    const result = verifyStandardWebhookSignature({
      secret: TEST_SECRET,
      webhookId: id,
      webhookTimestamp: ts,
      webhookSignature: sign(TEST_SECRET, id, ts, body),
      rawBody: body,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const result = verifyStandardWebhookSignature({
      secret: TEST_SECRET,
      webhookId: id,
      webhookTimestamp: ts,
      webhookSignature: sign(TEST_SECRET, id, ts, body),
      rawBody: body + " ",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const result = verifyStandardWebhookSignature({
      secret: TEST_SECRET,
      webhookId: id,
      webhookTimestamp: ts,
      webhookSignature: sign(OTHER_SECRET, id, ts, body),
      rawBody: body,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a timestamp outside the skew tolerance", () => {
    const oldTs = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const result = verifyStandardWebhookSignature({
      secret: TEST_SECRET,
      webhookId: id,
      webhookTimestamp: oldTs,
      webhookSignature: sign(TEST_SECRET, id, oldTs, body),
      rawBody: body,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/skew/);
  });

  it("accepts when any v1 token in a multi-token header matches", () => {
    const good = sign(TEST_SECRET, id, ts, body);
    const bad = "v1,bm90LWEtcmVhbC1zaWc=";
    const result = verifyStandardWebhookSignature({
      secret: TEST_SECRET,
      webhookId: id,
      webhookTimestamp: ts,
      webhookSignature: `${bad} ${good}`,
      rawBody: body,
    });
    expect(result.ok).toBe(true);
  });
});

describe("createWebhookInbox (bounded + dedup)", () => {
  function entry(id: string, status: InboxStatus = "accepted"): WebhookInboxEntry {
    return { event_id: id, verified: true, received_at: new Date().toISOString(), status };
  }

  it("drops the oldest entries past the cap", () => {
    const inbox = createWebhookInbox({ maxEntries: 3 });
    for (const id of ["a", "b", "c", "d", "e"]) inbox.record(entry(id));
    const ids = inbox.list().map((e) => e.event_id);
    expect(inbox.size()).toBe(3);
    expect(ids).toEqual(["c", "d", "e"]);
  });

  it("tracks accepted ids for dedup", () => {
    const inbox = createWebhookInbox();
    inbox.record(entry("x"));
    expect(inbox.isDuplicate("x")).toBe(true);
    expect(inbox.isDuplicate("y")).toBe(false);
  });
});

describe("POST /api/webhooks/straddle (signed mode)", () => {
  const secretEnv = { STRADDLE_WEBHOOK_SECRET: TEST_SECRET };

  it("accepts and stores a correctly signed payload", async () => {
    const app = await makeApp(secretEnv);
    const id = "msg_ok";
    const ts = nowSec();
    const body = JSON.stringify({ type: "charge.event.v1", data: { id: "chg_ok" } });
    const res = await post(app, body, { id, timestamp: ts, signature: sign(TEST_SECRET, id, ts, body) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "accepted", verified: true, event_id: id });

    const inbox = await listInbox(app);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      event_id: id,
      status: "accepted",
      verified: true,
      webhook_type: "charge.event.v1",
      resource_id: "chg_ok",
    });
    await app.close();
  });

  it("rejects a tampered body with 401 and records verified:false", async () => {
    const app = await makeApp(secretEnv);
    const id = "msg_tamper";
    const ts = nowSec();
    const body = JSON.stringify({ type: "charge.event.v1", data: { id: "chg_1" } });
    const signature = sign(TEST_SECRET, id, ts, body);
    const res = await post(app, body + "X", { id, timestamp: ts, signature });
    expect(res.statusCode).toBe(401);
    expect(res.json().status).toBe("rejected");

    const inbox = await listInbox(app);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ event_id: id, status: "rejected", verified: false });
    expect(inbox[0]?.reason).toBeTruthy();
    expect(inbox[0]?.detail).toBeUndefined();
    await app.close();
  });

  it("rejects a signature made with the wrong secret", async () => {
    const app = await makeApp(secretEnv);
    const id = "msg_wrong";
    const ts = nowSec();
    const body = JSON.stringify({ type: "charge.event.v1" });
    const res = await post(app, body, { id, timestamp: ts, signature: sign(OTHER_SECRET, id, ts, body) });
    expect(res.statusCode).toBe(401);
    expect((await listInbox(app))[0]).toMatchObject({ status: "rejected", verified: false });
    await app.close();
  });

  it("rejects a skewed timestamp", async () => {
    const app = await makeApp(secretEnv);
    const id = "msg_skew";
    const ts = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const body = JSON.stringify({ type: "charge.event.v1" });
    const res = await post(app, body, { id, timestamp: ts, signature: sign(TEST_SECRET, id, ts, body) });
    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toMatch(/skew/);
    expect((await listInbox(app))[0]).toMatchObject({ status: "rejected", verified: false });
    await app.close();
  });

  it("rejects a missing signature header with 400", async () => {
    const app = await makeApp(secretEnv);
    const id = "msg_nohdr";
    const ts = nowSec();
    const body = JSON.stringify({ type: "charge.event.v1" });
    const res = await post(app, body, { id, timestamp: ts }); // no signature
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toMatch(/missing webhook signature headers/);
    expect((await listInbox(app))[0]).toMatchObject({ status: "rejected", verified: false });
    await app.close();
  });

  it("dedups a repeated webhook-id: one stored, second marked duplicate, both 2xx", async () => {
    const app = await makeApp(secretEnv);
    const id = "msg_dup";
    const ts = nowSec();
    const body = JSON.stringify({ type: "charge.event.v1", data: { id: "chg_dup" } });
    const signature = sign(TEST_SECRET, id, ts, body);

    const first = await post(app, body, { id, timestamp: ts, signature });
    const second = await post(app, body, { id, timestamp: ts, signature });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().status).toBe("accepted");
    expect(second.json().status).toBe("duplicate");

    const inbox = await listInbox(app);
    const accepted = inbox.filter((e) => e.event_id === id && e.status === "accepted");
    const duplicate = inbox.filter((e) => e.event_id === id && e.status === "duplicate");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.detail).toBeDefined();
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]?.detail).toBeUndefined();
    await app.close();
  });

  it("does not crash on unparseable JSON with a valid signature", async () => {
    const app = await makeApp(secretEnv);
    const id = "msg_badjson";
    const ts = nowSec();
    const body = "{not json";
    const res = await post(app, body, { id, timestamp: ts, signature: sign(TEST_SECRET, id, ts, body) });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toMatch(/not valid JSON/);

    // Process stays up: a subsequent good delivery still works.
    const okId = "msg_after_bad";
    const okBody = JSON.stringify({ type: "charge.event.v1" });
    const ok = await post(app, okBody, { id: okId, timestamp: ts, signature: sign(TEST_SECRET, okId, ts, okBody) });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it("rejects an oversized body with 413 and stays alive", async () => {
    const app = await makeApp(secretEnv);
    const id = "msg_big";
    const ts = nowSec();
    const big = "x".repeat(64 * 1024 + 1024);
    const res = await post(app, big, { id, timestamp: ts, signature: sign(TEST_SECRET, id, ts, big) });
    expect(res.statusCode).toBe(413);

    const okBody = JSON.stringify({ type: "charge.event.v1" });
    const okId = "msg_after_big";
    const ok = await post(app, okBody, { id: okId, timestamp: ts, signature: sign(TEST_SECRET, okId, ts, okBody) });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it("redacts account/routing/paykey-shaped values before storing (via the redactor path)", async () => {
    const app = await makeApp(secretEnv);
    const id = "msg_redact";
    const ts = nowSec();
    const payload = {
      type: "charge.event.v1",
      data: {
        id: "chg_redact",
        account_number: "987654321",
        routing_number: "123456789",
        paykey: "deadbeef.01." + "a".repeat(64),
      },
    };
    const body = JSON.stringify(payload);
    const res = await post(app, body, { id, timestamp: ts, signature: sign(TEST_SECRET, id, ts, body) });
    expect(res.statusCode).toBe(200);

    const inbox = await listInbox(app);
    const stored = inbox.find((e) => e.event_id === id);
    expect(stored?.detail).toBeDefined();
    // Zero survival of the raw sensitive values anywhere in the stored entry.
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("987654321");
    expect(serialized).not.toContain("123456789");
    expect(serialized).not.toContain("deadbeef.01.");
    // Matches the redactor path exactly (apiKey undefined in this test env).
    const expected = createRedactor({}).redactValue(payload);
    expect(stored?.detail).toEqual(expected);
    await app.close();
  });
});

describe("POST /api/webhooks/straddle (modes)", () => {
  it("accepts unsigned payloads (marked unverified) when the flag is on and no secret", async () => {
    const app = await makeApp({ WEBHOOK_ALLOW_UNSIGNED: "1" });
    const id = "msg_unsigned";
    const body = JSON.stringify({ type: "charge.event.v1", data: { id: "chg_u" } });
    const res = await post(app, body, { id }); // no timestamp/signature
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "accepted", verified: false });

    const inbox = await listInbox(app);
    expect(inbox[0]).toMatchObject({ event_id: id, status: "accepted", verified: false });
    await app.close();
  });

  it("rejects everything when no secret and the unsigned flag is off", async () => {
    const app = await makeApp({});
    const body = JSON.stringify({ type: "charge.event.v1" });
    const res = await post(app, body, { id: "msg_x" });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toMatch(/not configured/);
    // Nothing trusted / stored as accepted.
    const inbox = await listInbox(app);
    expect(inbox.filter((e) => e.status === "accepted")).toHaveLength(0);
    await app.close();
  });
});

describe("POST /api/webhooks/straddle → correlation (P2-3.3)", () => {
  const RUN_ID = "run-20260708T120000Z-c-ab12";

  function scenarioC(): ScenarioDef {
    return {
      id: "c",
      label: "C. Reversal",
      purpose: "Mock/replay reversal evidence.",
      outcomes: { customer: "verified", paykey: "active", charge: "reversed_insufficient_funds" },
      requiredObservations: [{ kind: "ordered_statuses", statuses: ["paid", "reversed"] }],
    };
  }

  it("emits webhook.received for a known run so /api/events includes it", async () => {
    const bus = createBus();
    const registry = createRunRegistry(bus);
    const app = await createHttpServer({
      config: loadConfig({ env: { STRADDLE_WEBHOOK_SECRET: TEST_SECRET }, envFilePath: false }),
      epoch: "test-epoch",
      bus,
      registry,
      mockMode: true,
      attachRecorder: false,
      serveStatic: false,
      logger: false,
    });
    // A known live run the webhook can correlate to (external_id = run_id).
    bus.emit({ type: "run.started", run_id: RUN_ID, scenario_id: "c", scenario: scenarioC() });

    const id = "msg_corr";
    const ts = nowSec();
    const body = JSON.stringify({
      type: "charge.event.v1",
      data: { id: "chg_corr", external_id: RUN_ID },
    });
    const res = await post(app, body, { id, timestamp: ts, signature: sign(TEST_SECRET, id, ts, body) });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("accepted");

    const events = (await app.inject({ method: "GET", url: "/api/events?since=0" })).json<{
      events: RunEvent[];
    }>().events;
    const webhookEvents = events.filter((e) => e.type === "webhook.received");
    expect(webhookEvents).toHaveLength(1);
    expect(webhookEvents[0]).toMatchObject({
      run_id: RUN_ID,
      scenario_id: "c",
      event_id: id,
      webhook_type: "charge.event.v1",
      verified: true,
      resource_id: "chg_corr",
    });
    // Polling authority: no synthesized payment.status_changed from the webhook.
    expect(events.some((e) => e.type === "payment.status_changed")).toBe(false);
    await app.close();
  });

  it("does not emit for a webhook that matches no run", async () => {
    const bus = createBus();
    const registry = createRunRegistry(bus);
    const app = await createHttpServer({
      config: loadConfig({ env: { STRADDLE_WEBHOOK_SECRET: TEST_SECRET }, envFilePath: false }),
      epoch: "test-epoch",
      bus,
      registry,
      mockMode: true,
      attachRecorder: false,
      serveStatic: false,
      logger: false,
    });

    const id = "msg_unmatched";
    const ts = nowSec();
    const body = JSON.stringify({ type: "charge.event.v1", data: { id: "chg_ghost", external_id: "run-nope" } });
    const res = await post(app, body, { id, timestamp: ts, signature: sign(TEST_SECRET, id, ts, body) });
    expect(res.statusCode).toBe(200); // still accepted into the inbox

    const events = (await app.inject({ method: "GET", url: "/api/events?since=0" })).json<{
      events: RunEvent[];
    }>().events;
    expect(events.some((e) => e.type === "webhook.received")).toBe(false);
    // But the inbox retains it (unmatched, not dropped).
    expect((await listInbox(app)).some((e) => e.event_id === id && e.status === "accepted")).toBe(true);
    await app.close();
  });
});

describe("GET /api/webhooks", () => {
  it("returns the recent redacted entries", async () => {
    const app = await makeApp({ STRADDLE_WEBHOOK_SECRET: TEST_SECRET });
    const ts = nowSec();
    for (const n of [1, 2, 3]) {
      const id = `msg_${n}`;
      const body = JSON.stringify({ type: "charge.event.v1", data: { id: `chg_${n}` } });
      await post(app, body, { id, timestamp: ts, signature: sign(TEST_SECRET, id, ts, body) });
    }
    const inbox = await listInbox(app);
    expect(inbox.map((e) => e.event_id)).toEqual(["msg_1", "msg_2", "msg_3"]);
    expect(inbox.every((e) => e.status === "accepted" && e.verified)).toBe(true);
    await app.close();
  });
});
