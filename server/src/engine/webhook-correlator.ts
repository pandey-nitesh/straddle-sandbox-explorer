/**
 * Webhook correlation (P2-3.3).
 *
 * Webhooks are CORRELATED EVIDENCE, never a lifecycle driver — POLLING stays
 * authoritative (spec §2, plan P2-3 principles). When the receiver ACCEPTS a
 * webhook (verified, or unsigned-local mode), the correlator tries to attach it
 * to a known run and, on a match, emits ONE `webhook.received` RunEvent onto the
 * bus for that run. That event is recorded and surfaced like any other run event
 * — but the correlator NEVER emits `payment.status_changed` and never mutates a
 * run's derived lifecycle. A webhook that reports a status the timeline has not
 * shown is retained ONLY as `webhook.received` evidence; a disagreement with
 * polling is left visible, never a silent overwrite.
 *
 * Matching precedence (conservative — only ever exact id equality, never a
 * guess):
 *   1. `external_id === run_id` (charges are created with `external_id = run_id`,
 *      api-notes external_id convention),
 *   2. else a resource id (charge / customer / paykey) the run's own events
 *      already carry.
 *
 * Idempotency: an `event_id` that has already produced a `webhook.received` for
 * a run never emits a second one (redelivery / dedup across the inbox is a
 * no-op). Unmatched webhooks emit nothing (they stay inbox-only, handled by the
 * receiver). A webhook that arrives after `run.completed` still emits — a
 * completed run can gain corroborating evidence without changing its result.
 *
 * Redaction: `detail` handed in here is ALREADY server-side redacted by the
 * receiver (spec §8); the correlator only ever forwards that redacted value and
 * never re-introduces a raw payload.
 */
import type { RunEvent, ScenarioId } from "@sse/shared";
import type { EventBus } from "./bus.js";
import type { RegistrySnapshot, RunSnapshot } from "./registry.js";

/**
 * The minimal read-only view of an accepted inbox entry the correlator needs.
 * `WebhookInboxEntry` (server/src/http/webhooks.ts) is structurally assignable
 * to this, so the receiver hands its entries straight in — the engine keeps no
 * runtime dependency on the http layer.
 */
export interface CorrelatableWebhook {
  /** Svix/Straddle webhook id — the dedup / idempotency key. */
  event_id: string;
  /** e.g. "charge.event.v1"; optional on the wire, defaulted on emit. */
  webhook_type?: string;
  /** Signature verification result. */
  verified: boolean;
  /** The charge/customer/paykey id the delivery references, if the receiver found one. */
  resource_id?: string;
  /** The ALREADY-REDACTED payload (spec §8). Never raw. */
  detail?: unknown;
  /** When the delivery was received (ISO); surfaced as `delivered_at`. */
  received_at: string;
}

/** Read-only registry surface the correlator reads (snapshot only). */
export interface CorrelatorRegistry {
  snapshot(): RegistrySnapshot;
}

export interface WebhookMatch {
  run_id: string;
  scenario_id: ScenarioId;
  /** The resource id the webhook references, when known. */
  resource_id?: string;
}

export type CorrelateOutcome =
  | { matched: false }
  | {
      matched: true;
      /** True iff THIS call emitted a `webhook.received` (false on idempotent redelivery). */
      emitted: boolean;
      run_id: string;
      scenario_id: ScenarioId;
      resource_id?: string;
    };

export interface WebhookCorrelator {
  /**
   * Correlate one accepted webhook. On a match not already emitted, emits a
   * single `webhook.received` onto the bus. Total — never throws for unmatched,
   * duplicate, or out-of-order deliveries.
   */
  correlate(webhook: CorrelatableWebhook): CorrelateOutcome;
  /** True once a `webhook.received` has been emitted for this event id. */
  hasEmitted(eventId: string): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Best-effort `external_id` from a redacted payload. Mirrors the receiver's
 * tolerant envelope handling (the shape is UNVERIFIED, api-notes §P12): checks
 * `data.external_id`, `data.data.external_id`, then a top-level `external_id`.
 */
function extractExternalId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const data = payload["data"];
  if (isRecord(data)) {
    if (typeof data["external_id"] === "string") return data["external_id"];
    const inner = data["data"];
    if (isRecord(inner) && typeof inner["external_id"] === "string") {
      return inner["external_id"];
    }
  }
  if (typeof payload["external_id"] === "string") return payload["external_id"];
  return undefined;
}

/** Best-effort resource id from a redacted payload (same shape as the receiver). */
function extractResourceId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const data = payload["data"];
  if (isRecord(data)) {
    if (typeof data["id"] === "string") return data["id"];
    const inner = data["data"];
    if (isRecord(inner) && typeof inner["id"] === "string") return inner["id"];
  }
  if (typeof payload["id"] === "string") return payload["id"];
  return undefined;
}

/** Resource ids an `api.exchange` response body creates (`data.id`, `id`, `data.data.id`). */
function responseResourceIds(body: unknown): string[] {
  const ids: string[] = [];
  if (!isRecord(body)) return ids;
  if (typeof body["id"] === "string") ids.push(body["id"]);
  const data = body["data"];
  if (isRecord(data)) {
    if (typeof data["id"] === "string") ids.push(data["id"]);
    const inner = data["data"];
    if (isRecord(inner) && typeof inner["id"] === "string") ids.push(inner["id"]);
  }
  return ids;
}

/**
 * Does this run event carry the given resource id? Charge ids live on
 * `payment.status_changed.resource_id` and `api.exchange` create responses,
 * customer ids on `customer.review_changed`, paykey ids on `api.exchange`
 * responses; a prior `webhook.received` is honored too. Exact equality only.
 */
function eventReferencesResource(event: RunEvent, resourceId: string): boolean {
  switch (event.type) {
    case "payment.status_changed":
      return event.resource_id === resourceId;
    case "customer.review_changed":
      return event.customer_id === resourceId;
    case "webhook.received":
      return event.resource_id === resourceId;
    case "api.exchange":
      return responseResourceIds(event.response_body).includes(resourceId);
    default:
      return false;
  }
}

function runReferencesResource(run: RunSnapshot, resourceId: string): boolean {
  return run.events.some((event) => eventReferencesResource(event, resourceId));
}

/**
 * Pure match: find the run this webhook belongs to, or `null`. Never throws.
 * Precedence is external_id first, then a resource id in the run's events.
 */
export function correlateWebhook(args: {
  webhook: CorrelatableWebhook;
  registry: CorrelatorRegistry;
}): WebhookMatch | null {
  const { webhook, registry } = args;
  const snapshot = registry.snapshot();
  const externalId = extractExternalId(webhook.detail);
  const resourceId = webhook.resource_id ?? extractResourceId(webhook.detail);

  // Precedence 1: external_id === run_id (the strongest, direct link).
  if (externalId !== undefined) {
    const run = snapshot.runs.find((r) => r.run_id === externalId);
    if (run !== undefined) {
      return {
        run_id: run.run_id,
        scenario_id: run.scenario_id,
        ...(resourceId !== undefined ? { resource_id: resourceId } : {}),
      };
    }
  }

  // Precedence 2: a resource id the run's own events already carry.
  if (resourceId !== undefined) {
    for (const run of snapshot.runs) {
      if (runReferencesResource(run, resourceId)) {
        return {
          run_id: run.run_id,
          scenario_id: run.scenario_id,
          resource_id: resourceId,
        };
      }
    }
  }

  return null;
}

export function createWebhookCorrelator(args: {
  bus: EventBus;
  registry: CorrelatorRegistry;
}): WebhookCorrelator {
  const { bus, registry } = args;
  // Idempotency set: event ids that have already produced a webhook.received.
  const emitted = new Set<string>();

  return {
    correlate(webhook: CorrelatableWebhook): CorrelateOutcome {
      const match = correlateWebhook({ webhook, registry });
      if (match === null) return { matched: false };

      // Idempotent: a redelivered / duplicate id never emits twice.
      if (emitted.has(webhook.event_id)) {
        return { matched: true, emitted: false, ...match };
      }

      bus.emit({
        type: "webhook.received",
        run_id: match.run_id,
        scenario_id: match.scenario_id,
        event_id: webhook.event_id,
        // Schema requires a webhook_type; real deliveries always carry one, but
        // default rather than throw on a shapeless payload.
        webhook_type: webhook.webhook_type ?? "unknown",
        verified: webhook.verified,
        ...(match.resource_id !== undefined ? { resource_id: match.resource_id } : {}),
        delivered_at: webhook.received_at,
        // Already redacted by the receiver — forwarded verbatim, never re-raw.
        ...(webhook.detail !== undefined ? { detail: webhook.detail } : {}),
      });
      emitted.add(webhook.event_id);
      return { matched: true, emitted: true, ...match };
    },

    hasEmitted(eventId: string): boolean {
      return emitted.has(eventId);
    },
  };
}
