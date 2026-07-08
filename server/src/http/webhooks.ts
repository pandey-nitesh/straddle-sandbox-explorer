/**
 * Inbound webhook receiver (P2-3.2) — the ingress edge only.
 *
 * `POST /api/webhooks/straddle` accepts Straddle/Svix deliveries, verifies the
 * Standard-Webhooks signature, dedups by webhook id, redacts the payload, and
 * files it in a bounded in-memory inbox. `GET /api/webhooks` returns the
 * recent (redacted) entries. This PR does NOT correlate webhooks to runs or
 * emit `webhook.received` RunEvents — that is P2-3.3. The inbox is deliberately
 * decoupled from the run bus.
 *
 * Signing scheme (api-notes §P12, VERIFIED from docs.straddle.com):
 * - Headers `webhook-id`, `webhook-timestamp`, `webhook-signature`.
 * - HMAC-SHA256 over the exact string `{id}.{timestamp}.{rawBody}` — the RAW
 *   body, un-reserialized, which is why this route reads the raw buffer via a
 *   scoped content-type parser instead of Fastify's JSON parse.
 * - The secret is `whsec_<base64>`; the HMAC key is the base64-decode of the
 *   part after `whsec_`.
 * - `webhook-signature` is a space-delimited list of `v1,<base64sig>` tokens;
 *   any matching `v1` token verifies. Compare in constant time.
 * - Reject deliveries whose timestamp is more than ~5 min from now (replay).
 *
 * Secret discipline (spec §8, api-notes §P12): the `whsec_` secret and the
 * three `webhook-*` headers (+ the raw signature) NEVER enter the inbox or the
 * logs. The raw body is retained ONLY long enough to verify, then the parsed
 * payload is redacted before it is stored — the one ordering subtlety here.
 *
 * Modes:
 * - signed (default): a secret is configured → verify; unsigned/invalid is
 *   rejected (recorded `verified:false` with a reason, never trusted).
 * - unsigned/local: no secret AND `WEBHOOK_ALLOW_UNSIGNED` on → accept but mark
 *   unverified. Fixture-only; never on by default; never weakens signed mode.
 * - not configured: no secret AND flag off → 400, nothing accepted.
 *
 * Malformed input never crashes: unparseable JSON, missing headers, bad
 * signature, and oversized bodies become bounded, structured 4xx responses
 * (and inbox entries where appropriate). The handler does only synchronous,
 * bounded CPU work (HMAC + JSON.parse + redact over a ≤64KB body), so there is
 * no external call that could hang.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { createRedactor } from "../redaction.js";

/** Reject bodies larger than this with a 413 (bounded body size). */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/** Bounded inbox capacity — oldest entries drop past this (cf. P2-R.5). */
export const DEFAULT_MAX_INBOX_ENTRIES = 200;

/** Replay-guard tolerance for `webhook-timestamp` skew (~5 min, api-notes §P12). */
export const DEFAULT_TIMESTAMP_TOLERANCE_SEC = 300;

const WEBHOOK_ID_HEADER = "webhook-id";
const WEBHOOK_TIMESTAMP_HEADER = "webhook-timestamp";
const WEBHOOK_SIGNATURE_HEADER = "webhook-signature";
const WHSEC_PREFIX = "whsec_";

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export type InboxStatus = "accepted" | "duplicate" | "rejected";

/**
 * One inbox record. Never carries the signing secret or the `webhook-*`
 * headers; `detail` is the payload AFTER server-side redaction. Duplicate
 * markers omit `detail` — the payload is stored exactly once (dedup).
 */
export interface WebhookInboxEntry {
  event_id: string;
  webhook_type?: string;
  verified: boolean;
  received_at: string;
  resource_id?: string;
  detail?: unknown;
  status: InboxStatus;
  reason?: string;
}

export interface WebhookInbox {
  /** True once an ACCEPTED entry with this event id is retained (dedup key). */
  isDuplicate(eventId: string): boolean;
  /** Append an entry, registering accepted ids for dedup and evicting oldest. */
  record(entry: WebhookInboxEntry): WebhookInboxEntry;
  /** Recent entries, oldest→newest, already redacted. */
  list(): WebhookInboxEntry[];
  size(): number;
}

export function createWebhookInbox(
  options: { maxEntries?: number } = {},
): WebhookInbox {
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_INBOX_ENTRIES);
  const entries: WebhookInboxEntry[] = [];
  // Dedup index: event id → the retained accepted record. Kept coherent with
  // eviction so a marathon session cannot grow it without bound.
  const acceptedById = new Map<string, WebhookInboxEntry>();

  function evict(): void {
    while (entries.length > maxEntries) {
      const removed = entries.shift();
      if (
        removed !== undefined &&
        removed.status === "accepted" &&
        acceptedById.get(removed.event_id) === removed
      ) {
        acceptedById.delete(removed.event_id);
      }
    }
  }

  return {
    isDuplicate(eventId: string): boolean {
      return acceptedById.has(eventId);
    },
    record(entry: WebhookInboxEntry): WebhookInboxEntry {
      entries.push(entry);
      if (entry.status === "accepted") acceptedById.set(entry.event_id, entry);
      evict();
      return entry;
    },
    list(): WebhookInboxEntry[] {
      return entries.map((entry) => ({ ...entry }));
    },
    size(): number {
      return entries.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Signature verification (Standard Webhooks / Svix)
// ---------------------------------------------------------------------------

export interface VerifyWebhookInput {
  /** The `whsec_…` secret (prefix optional). */
  secret: string;
  webhookId: string;
  webhookTimestamp: string;
  webhookSignature: string;
  /** The RAW request body as received, un-reserialized. */
  rawBody: string;
  toleranceSec?: number;
  /** Injectable clock (ms) for deterministic skew tests; default Date.now(). */
  nowMs?: number;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify a Standard-Webhooks signature. Pure and total — it never throws; a
 * malformed input becomes `{ ok: false, reason }`.
 */
export function verifyStandardWebhookSignature(
  input: VerifyWebhookInput,
): VerifyResult {
  const tolerance = input.toleranceSec ?? DEFAULT_TIMESTAMP_TOLERANCE_SEC;
  const nowMs = input.nowMs ?? Date.now();

  const tsRaw = input.webhookTimestamp.trim();
  if (!/^\d+$/.test(tsRaw)) {
    return { ok: false, reason: "invalid webhook-timestamp" };
  }
  const tsSec = Number.parseInt(tsRaw, 10);
  const skewSec = Math.abs(nowMs / 1000 - tsSec);
  if (skewSec > tolerance) {
    return {
      ok: false,
      reason: `timestamp skew ${Math.round(skewSec)}s exceeds ${tolerance}s tolerance`,
    };
  }

  const secretBody = input.secret.startsWith(WHSEC_PREFIX)
    ? input.secret.slice(WHSEC_PREFIX.length)
    : input.secret;
  const keyBytes = Buffer.from(secretBody, "base64");
  if (keyBytes.length === 0) {
    return { ok: false, reason: "invalid signing secret" };
  }

  const signedContent = `${input.webhookId}.${input.webhookTimestamp}.${input.rawBody}`;
  const expected = createHmac("sha256", keyBytes)
    .update(signedContent, "utf8")
    .digest("base64");

  const tokens = input.webhookSignature.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return { ok: false, reason: "no signature tokens" };
  }
  for (const token of tokens) {
    const comma = token.indexOf(",");
    if (comma === -1) continue;
    // Only the versioned `v1` scheme is defined; ignore unknown versions.
    if (token.slice(0, comma) !== "v1") continue;
    if (timingSafeEqualBase64(token.slice(comma + 1), expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "no matching v1 signature" };
}

/** Constant-time compare of two base64 signatures (decoded-byte comparison). */
function timingSafeEqualBase64(a: string, b: string): boolean {
  const ab = Buffer.from(a, "base64");
  const bb = Buffer.from(b, "base64");
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Payload helpers (tolerant — the envelope is UNVERIFIED, api-notes §P12)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Straddle/Svix event type, e.g. "charge.event.v1"; undefined if absent. */
function extractWebhookType(payload: unknown): string | undefined {
  if (isRecord(payload) && typeof payload["type"] === "string") {
    return payload["type"];
  }
  return undefined;
}

/** The charge/customer/paykey id the delivery references, best-effort. */
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

/** Normalize a possibly-array header to its first string value. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export interface RegisterWebhookRoutesOptions {
  config: Config;
  /** Reuse an inbox (tests); default a fresh bounded inbox. */
  inbox?: WebhookInbox;
  maxInboxEntries?: number;
  /** Injectable clock (ms); default Date.now(). */
  now?: () => number;
}

export async function registerWebhookRoutes(
  app: FastifyInstance,
  options: RegisterWebhookRoutesOptions,
): Promise<WebhookInbox> {
  const inbox =
    options.inbox ??
    createWebhookInbox(
      options.maxInboxEntries !== undefined
        ? { maxEntries: options.maxInboxEntries }
        : {},
    );
  const now = options.now ?? ((): number => Date.now());
  // Redactor scrubs credential material from the payload before it is stored.
  // The webhook secret is added as an extra literal for defense in depth even
  // though it must never appear in a body.
  const redactor = createRedactor({
    ...(options.config.straddleApiKey !== undefined
      ? { apiKey: options.config.straddleApiKey }
      : {}),
    ...(options.config.straddleWebhookSecret !== undefined
      ? { extraSensitiveValues: [options.config.straddleWebhookSecret] }
      : {}),
  });

  function recordRejected(
    eventId: string | undefined,
    reason: string,
    verified = false,
  ): void {
    inbox.record({
      event_id: eventId ?? "unknown",
      verified,
      received_at: new Date(now()).toISOString(),
      status: "rejected",
      reason,
    });
  }

  // Encapsulated plugin: the raw-buffer content-type parser and error handler
  // are scoped here so the rest of the app keeps its JSON parsing.
  await app.register(async (instance) => {
    instance.removeAllContentTypeParsers();
    instance.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: MAX_WEBHOOK_BODY_BYTES },
      (_request, body, done) => {
        done(null, body);
      },
    );

    // Turn oversized-body and any unexpected parser error into a bounded,
    // structured 4xx — never a stack trace, never a crash.
    instance.setErrorHandler((error, request, reply) => {
      const err = error as { code?: string; statusCode?: number };
      const code = err.code;
      const status = typeof err.statusCode === "number" ? err.statusCode : undefined;
      if (code === "FST_ERR_CTP_BODY_TOO_LARGE" || status === 413) {
        recordRejected(
          headerValue(request.headers[WEBHOOK_ID_HEADER]),
          "payload exceeds max size",
        );
        return reply.code(413).send({ status: "rejected", reason: "payload exceeds max size" });
      }
      request.log.warn({ err_code: code }, "webhook request error");
      return reply.code(400).send({ status: "rejected", reason: "invalid webhook request" });
    });

    instance.post(
      "/api/webhooks/straddle",
      { bodyLimit: MAX_WEBHOOK_BODY_BYTES },
      async (request, reply) => {
        const receivedAt = new Date(now()).toISOString();
        const bodyBuf = request.body;
        const rawBody = Buffer.isBuffer(bodyBuf)
          ? bodyBuf.toString("utf8")
          : typeof bodyBuf === "string"
            ? bodyBuf
            : "";

        const webhookId = headerValue(request.headers[WEBHOOK_ID_HEADER]);
        const webhookTimestamp = headerValue(request.headers[WEBHOOK_TIMESTAMP_HEADER]);
        const webhookSignature = headerValue(request.headers[WEBHOOK_SIGNATURE_HEADER]);

        const secretPresent = options.config.webhookSecretPresent;
        const allowUnsigned = options.config.allowUnsignedWebhooks;

        // Mode: not configured → refuse, trust nothing.
        if (!secretPresent && !allowUnsigned) {
          return reply
            .code(400)
            .send({ status: "rejected", reason: "webhook verification not configured" });
        }

        let verified = false;
        if (secretPresent) {
          // Signed mode: the three headers are mandatory and the signature must
          // verify. Unsigned or invalid is recorded but never trusted.
          if (
            webhookId === undefined ||
            webhookTimestamp === undefined ||
            webhookSignature === undefined
          ) {
            const reason = "missing webhook signature headers";
            recordRejected(webhookId, reason);
            return reply.code(400).send({ status: "rejected", reason });
          }
          const result = verifyStandardWebhookSignature({
            secret: options.config.straddleWebhookSecret ?? "",
            webhookId,
            webhookTimestamp,
            webhookSignature,
            rawBody,
            nowMs: now(),
          });
          if (!result.ok) {
            recordRejected(webhookId, result.reason);
            return reply.code(401).send({ status: "rejected", reason: result.reason });
          }
          verified = true;
        }
        // else: unsigned/local mode (no secret, flag on) → verified stays false.

        // Parse tolerantly: a valid signature over a non-JSON body is authentic
        // but unusable → rejected, never a throw.
        let payload: unknown;
        try {
          payload = rawBody.trim() === "" ? {} : JSON.parse(rawBody);
        } catch {
          const reason = "payload is not valid JSON";
          recordRejected(webhookId, reason, verified);
          return reply.code(400).send({ status: "rejected", reason });
        }

        // Redact BEFORE anything is stored (the §8 ordering rule).
        const detail = redactor.redactValue(payload);
        const webhookType = extractWebhookType(detail);
        const resourceId = extractResourceId(detail);
        // Signed deliveries always carry an id; unsigned local ones may not, so
        // synthesize a unique id to keep the inbox well-formed and unambiguous.
        const eventId = webhookId ?? `unsigned-${randomUUID()}`;

        // Dedup: a repeat of an accepted id is idempotent — recorded as a
        // duplicate marker (no payload re-stored), 200.
        if (inbox.isDuplicate(eventId)) {
          inbox.record({
            event_id: eventId,
            verified,
            received_at: receivedAt,
            status: "duplicate",
            reason: "duplicate delivery",
            ...(webhookType !== undefined ? { webhook_type: webhookType } : {}),
          });
          return reply.code(200).send({ status: "duplicate", event_id: eventId, verified });
        }

        inbox.record({
          event_id: eventId,
          verified,
          received_at: receivedAt,
          status: "accepted",
          detail,
          ...(webhookType !== undefined ? { webhook_type: webhookType } : {}),
          ...(resourceId !== undefined ? { resource_id: resourceId } : {}),
        });
        return reply.code(200).send({ status: "accepted", event_id: eventId, verified });
      },
    );

    instance.get("/api/webhooks", async () => ({ webhooks: inbox.list() }));
  });

  return inbox;
}
