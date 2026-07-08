import type { KnowledgeEntry } from "./types";

/**
 * Webhook concept notes (spec §19; curated from api-notes §12.22 / P12). These
 * teach the one thing a newcomer most needs about Straddle webhooks in this
 * tool: they CORROBORATE the lifecycle, they never drive it — the polled
 * charge is authoritative here. Web-only prose, api-notes-cited like every
 * other knowledge entry (CLAUDE.md: API facts are never guessed).
 */
export const WEBHOOK_NOTES: readonly KnowledgeEntry[] = [
  {
    id: "webhook-received",
    term: "webhook.received",
    category: "webhook",
    short:
      "An inbound Straddle webhook that has been correlated to this run. Webhooks corroborate the lifecycle — polling the charge stays authoritative, so a webhook is shown as evidence, never as a lifecycle node.",
    detail:
      "Deliveries are signed with the Standard Webhooks (Svix) scheme: a webhook-id, webhook-timestamp, and webhook-signature on every request. The signing secret and those signature headers are stripped server-side and never enter this evidence; a verified badge means the signature checked out before capture. Live delivery needs a dashboard-configured endpoint and a public tunnel, so this surface is exercised from fixtures.",
    source: "api-notes §12.22",
  },
  {
    id: "webhook-charge-event",
    term: "charge.event.v1",
    category: "webhook",
    short:
      "The generic charge event: successful processing, failures, fraud detections, and settlement changes all arrive under this one type — there is no dedicated reversal event, so a reversal rides charge.event.v1 too.",
    source: "api-notes §12.22",
  },
];

/** The general webhook concept note (webhooks corroborate; polling authoritative). */
export function webhookNote(): KnowledgeEntry | undefined {
  return WEBHOOK_NOTES[0];
}

/** Per-type note for a specific `webhook_type`, when one is curated. */
export function webhookTypeNote(type: string): KnowledgeEntry | undefined {
  return WEBHOOK_NOTES.find((entry) => entry.term === type);
}
