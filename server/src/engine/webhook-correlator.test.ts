import { describe, expect, it } from "vitest";
import type { RunEvent, ScenarioDef } from "@sse/shared";
import { createBus, type EventBus } from "./bus.js";
import { createRunRegistry, type RunRegistry } from "./registry.js";
import {
  correlateWebhook,
  createWebhookCorrelator,
  type CorrelatableWebhook,
} from "./webhook-correlator.js";

// --- Fixtures --------------------------------------------------------------

function scenarioC(): ScenarioDef {
  return {
    id: "c",
    label: "C. Reversal",
    purpose: "Mock/replay reversal evidence.",
    outcomes: { customer: "verified", paykey: "active", charge: "reversed_insufficient_funds" },
    requiredObservations: [{ kind: "ordered_statuses", statuses: ["paid", "reversed"] }],
  };
}

const TS = "2026-07-08T12:00:00.000Z";

/** Build a webhook input; `detail` is treated as already-redacted. */
function webhook(over: Partial<CorrelatableWebhook> = {}): CorrelatableWebhook {
  return {
    event_id: over.event_id ?? "msg_1",
    verified: over.verified ?? true,
    received_at: over.received_at ?? TS,
    ...(over.webhook_type !== undefined ? { webhook_type: over.webhook_type } : { webhook_type: "charge.event.v1" }),
    ...(over.resource_id !== undefined ? { resource_id: over.resource_id } : {}),
    ...(over.detail !== undefined ? { detail: over.detail } : {}),
  };
}

/** A wired bus + registry with one started run for scenario C. */
function withRun(runId: string): { bus: EventBus; registry: RunRegistry; received: RunEvent[] } {
  const bus = createBus();
  const registry = createRunRegistry(bus);
  const received: RunEvent[] = [];
  bus.subscribe((e) => {
    if (e.type === "webhook.received") received.push(e);
  });
  bus.emit({ type: "run.started", run_id: runId, scenario_id: "c", scenario: scenarioC() });
  return { bus, registry, received };
}

function webhookEventsFor(registry: RunRegistry, runId: string): RunEvent[] {
  const run = registry.snapshot().runs.find((r) => r.run_id === runId);
  return (run?.events ?? []).filter((e) => e.type === "webhook.received");
}

// --- Pure match precedence -------------------------------------------------

describe("correlateWebhook (pure match)", () => {
  it("matches by external_id === run_id", () => {
    const { registry } = withRun("run-ext");
    const match = correlateWebhook({
      registry,
      webhook: webhook({ detail: { type: "charge.event.v1", data: { id: "chg_x", external_id: "run-ext" } } }),
    });
    expect(match).toEqual({ run_id: "run-ext", scenario_id: "c", resource_id: "chg_x" });
  });

  it("matches by resource id when external_id is absent", () => {
    const { bus, registry } = withRun("run-res");
    bus.emit({
      type: "payment.status_changed",
      run_id: "run-res",
      scenario_id: "c",
      resource_id: "chg_res",
      from: null,
      to: "pending",
    });
    const match = correlateWebhook({
      registry,
      webhook: webhook({ resource_id: "chg_res", detail: { type: "charge.event.v1", data: { id: "chg_res" } } }),
    });
    expect(match).toEqual({ run_id: "run-res", scenario_id: "c", resource_id: "chg_res" });
  });

  it("matches a customer id carried by customer.review_changed", () => {
    const { bus, registry } = withRun("run-cust");
    bus.emit({
      type: "customer.review_changed",
      run_id: "run-cust",
      scenario_id: "c",
      customer_id: "cus_42",
      status: "verified",
      review: { verification_status: "verified", reason_codes: [] },
    });
    const match = correlateWebhook({ registry, webhook: webhook({ resource_id: "cus_42" }) });
    expect(match?.run_id).toBe("run-cust");
  });

  it("matches a resource id found in an api.exchange create response (data.id)", () => {
    const { bus, registry } = withRun("run-api");
    bus.emit({
      type: "api.exchange",
      run_id: "run-api",
      scenario_id: "c",
      method: "POST",
      path: "/v1/bridge/bank_account",
      status: 201,
      latency_ms: 10,
      attempt: 1,
      response_body: { data: { id: "pk_abc" } },
    });
    const match = correlateWebhook({ registry, webhook: webhook({ resource_id: "pk_abc" }) });
    expect(match?.run_id).toBe("run-api");
    expect(match?.resource_id).toBe("pk_abc");
  });

  it("returns null when nothing matches", () => {
    const { registry } = withRun("run-none");
    const match = correlateWebhook({ registry, webhook: webhook({ resource_id: "chg_unknown" }) });
    expect(match).toBeNull();
  });

  it("prefers external_id over a resource-id match (precedence)", () => {
    const { bus, registry } = withRun("run-ext-win");
    bus.emit({ type: "run.started", run_id: "run-res-win", scenario_id: "c", scenario: scenarioC() });
    bus.emit({
      type: "payment.status_changed",
      run_id: "run-res-win",
      scenario_id: "c",
      resource_id: "chg_shared",
      from: null,
      to: "pending",
    });
    // external_id points at run-ext-win; resource id lives in run-res-win.
    const match = correlateWebhook({
      registry,
      webhook: webhook({
        resource_id: "chg_shared",
        detail: { data: { id: "chg_shared", external_id: "run-ext-win" } },
      }),
    });
    expect(match?.run_id).toBe("run-ext-win");
  });
});

// --- Emit path + idempotency ----------------------------------------------

describe("createWebhookCorrelator (emit + idempotency)", () => {
  it("emits one webhook.received on an external_id match, with the run's ids", () => {
    const { bus, registry, received } = withRun("run-emit");
    const correlator = createWebhookCorrelator({ bus, registry });
    const outcome = correlator.correlate(
      webhook({
        event_id: "msg_emit",
        verified: true,
        detail: { type: "charge.event.v1", data: { id: "chg_e", external_id: "run-emit" } },
      }),
    );
    expect(outcome).toMatchObject({ matched: true, emitted: true, run_id: "run-emit", scenario_id: "c" });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "webhook.received",
      run_id: "run-emit",
      scenario_id: "c",
      event_id: "msg_emit",
      webhook_type: "charge.event.v1",
      verified: true,
      resource_id: "chg_e",
      delivered_at: TS,
    });
    // Visible in the registry for that run.
    expect(webhookEventsFor(registry, "run-emit")).toHaveLength(1);
  });

  it("matches by resource id when external_id is absent/non-matching", () => {
    const { bus, registry, received } = withRun("run-emit-res");
    bus.emit({
      type: "payment.status_changed",
      run_id: "run-emit-res",
      scenario_id: "c",
      resource_id: "chg_only",
      from: null,
      to: "pending",
    });
    const correlator = createWebhookCorrelator({ bus, registry });
    const outcome = correlator.correlate(
      webhook({ event_id: "msg_res", resource_id: "chg_only", detail: { data: { id: "chg_only" } } }),
    );
    expect(outcome).toMatchObject({ matched: true, emitted: true, run_id: "run-emit-res" });
    expect(received).toHaveLength(1);
    expect(received[0]?.type === "webhook.received" && received[0].resource_id).toBe("chg_only");
  });

  it("emits nothing for an unmatched webhook (stays inbox-only)", () => {
    const { bus, registry, received } = withRun("run-x");
    const correlator = createWebhookCorrelator({ bus, registry });
    const outcome = correlator.correlate(webhook({ event_id: "msg_nomatch", resource_id: "chg_ghost" }));
    expect(outcome).toEqual({ matched: false });
    expect(received).toHaveLength(0);
    expect(correlator.hasEmitted("msg_nomatch")).toBe(false);
  });

  it("is idempotent: a duplicate event_id emits exactly once", () => {
    const { bus, registry, received } = withRun("run-dup");
    const correlator = createWebhookCorrelator({ bus, registry });
    const wh = webhook({ event_id: "msg_dup", detail: { data: { external_id: "run-dup" } } });
    const first = correlator.correlate(wh);
    const second = correlator.correlate(wh);
    expect(first).toMatchObject({ matched: true, emitted: true });
    expect(second).toMatchObject({ matched: true, emitted: false });
    expect(received).toHaveLength(1);
    expect(webhookEventsFor(registry, "run-dup")).toHaveLength(1);
  });

  it("still emits for a webhook arriving after run.completed, without altering the result", () => {
    const { bus, registry, received } = withRun("run-late");
    bus.emit({
      type: "run.completed",
      run_id: "run-late",
      scenario_id: "c",
      result: "failed",
      duration_ms: 1_000,
      recording_path: "runs/run-late.jsonl",
    });
    const before = registry.snapshot().runs.find((r) => r.run_id === "run-late");
    expect(before?.status).toBe("failed");

    const correlator = createWebhookCorrelator({ bus, registry });
    const outcome = correlator.correlate(
      webhook({ event_id: "msg_late", detail: { data: { external_id: "run-late" } } }),
    );
    expect(outcome).toMatchObject({ matched: true, emitted: true });
    expect(received).toHaveLength(1);

    const after = registry.snapshot().runs.find((r) => r.run_id === "run-late");
    // Evidence appended; derived status and completion unchanged (polling authority).
    expect(after?.status).toBe("failed");
    expect(after?.completed_at).toBe(before?.completed_at);
    expect(webhookEventsFor(registry, "run-late")).toHaveLength(1);
  });

  it("polling stays authoritative: a webhook reporting a different status adds NO payment.status_changed", () => {
    const { bus, registry, received } = withRun("run-auth");
    bus.emit({
      type: "payment.status_changed",
      run_id: "run-auth",
      scenario_id: "c",
      resource_id: "chg_auth",
      from: null,
      to: "pending",
    });
    const paymentsBefore = registry
      .snapshot()
      .runs.find((r) => r.run_id === "run-auth")!
      .events.filter((e) => e.type === "payment.status_changed").length;

    const correlator = createWebhookCorrelator({ bus, registry });
    // Webhook claims "paid" — a status the timeline never showed.
    correlator.correlate(
      webhook({
        event_id: "msg_auth",
        resource_id: "chg_auth",
        detail: { type: "charge.event.v1", data: { id: "chg_auth", status: "paid" } },
      }),
    );

    const run = registry.snapshot().runs.find((r) => r.run_id === "run-auth")!;
    const paymentsAfter = run.events.filter((e) => e.type === "payment.status_changed").length;
    expect(paymentsAfter).toBe(paymentsBefore); // no new lifecycle transition
    expect(received).toHaveLength(1); // only webhook.received evidence
    // The last derived transition is still the poller's "pending", not the webhook's "paid".
    const lastPayment = [...run.events].reverse().find((e) => e.type === "payment.status_changed");
    expect(lastPayment?.type === "payment.status_changed" && lastPayment.to).toBe("pending");
  });

  it("never throws on an empty/shapeless payload and defaults webhook_type", () => {
    const { bus, registry, received } = withRun("run-shapeless");
    const correlator = createWebhookCorrelator({ bus, registry });
    // No detail, no webhook_type, but resource_id matches nothing → unmatched, no throw.
    expect(() => correlator.correlate({ event_id: "msg_empty", verified: false, received_at: TS })).not.toThrow();
    expect(received).toHaveLength(0);
  });
});
