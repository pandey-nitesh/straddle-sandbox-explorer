import { useState } from "react";
import { JsonBlock } from "./JsonBlock";
import { NotePanel, NoteTerm, type NoteContent } from "./Note";

/**
 * Inbound-webhook evidence view (spec P2-3.4; design §6.3/§6.6). Webhooks are a
 * THIRD provenance, distinct from the client-teal / server-purple wire
 * exchanges and from the payment lifecycle: each entry carries an indigo
 * `--wire-webhook` left edge and an "inbound" marker so it reads as pushed
 * evidence, not a request/response we made. Verified vs unverified use the
 * semantic status layer (verified = pass-ish green, unverified = caution
 * amber) — never a raw hex. The redacted `detail` renders verbatim as a JSON
 * block, testimony exactly like the wire log.
 */
export interface WebhookViewEntry {
  /** Stable key — the webhook.received event `seq`. */
  id: string;
  /** Verbatim `webhook_type`, rendered mono (e.g. `charge.event.v1`). */
  webhookType: string;
  verified: boolean;
  /** Correlated charge/customer/paykey id. */
  resourceId?: string;
  deliveredAt?: string;
  /** Already-redacted payload summary; absent means nothing to show. */
  detail?: unknown;
}

export interface WebhookPanelProps {
  entries: WebhookViewEntry[];
  /** Learning note (Explain on): webhooks corroborate; polling is authoritative. */
  note?: NoteContent;
}

function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified ? (
    <span
      data-tone="verified"
      className="wire-quote rounded-chip bg-status-pass/10 px-1.5 py-0.5 text-xs text-status-pass"
    >
      verified
    </span>
  ) : (
    <span
      data-tone="unverified"
      className="wire-quote rounded-chip bg-status-provisional/10 px-1.5 py-0.5 text-xs text-status-provisional"
    >
      unverified
    </span>
  );
}

function WebhookEntry({ entry }: { entry: WebhookViewEntry }) {
  return (
    <li className="rounded-inset border border-edge border-l-[3px] border-l-wire-webhook p-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Provenance marker: inbound, distinct from client/server wire. */}
        <span className="wire-quote shrink-0 text-xs text-wire-webhook">
          <span aria-hidden="true">↓ </span>webhook
        </span>
        <span className="wire-quote min-w-0 flex-1 break-all font-semibold text-fg">
          {entry.webhookType}
        </span>
        <VerifiedBadge verified={entry.verified} />
      </div>

      {(entry.resourceId !== undefined || entry.deliveredAt !== undefined) && (
        <dl className="mt-1.5 space-y-1">
          {entry.resourceId !== undefined && (
            <div className="flex items-baseline gap-2">
              <dt className="shrink-0 text-xs text-fg-muted">resource</dt>
              <dd className="wire-quote min-w-0 break-all text-xs text-fg-secondary">
                {entry.resourceId}
              </dd>
            </div>
          )}
          {entry.deliveredAt !== undefined && (
            <div className="flex items-baseline gap-2">
              <dt className="shrink-0 text-xs text-fg-muted">delivered</dt>
              <dd className="wire-quote min-w-0 break-all text-xs text-fg-muted">
                {entry.deliveredAt}
              </dd>
            </div>
          )}
        </dl>
      )}

      {entry.detail !== undefined && (
        <div className="mt-2">
          <div className="mb-1 text-xs text-fg-muted">detail</div>
          <JsonBlock
            value={entry.detail}
            label={`Webhook ${entry.webhookType} detail`}
          />
        </div>
      )}
    </li>
  );
}

export function WebhookPanel({ entries, note }: WebhookPanelProps) {
  const [noteOpen, setNoteOpen] = useState(false);

  // Empty reads cleanly (design §9 empty-state voice); in practice the wire
  // area hides the Webhooks tab entirely when a run has none, so this is the
  // defensive fallback rather than routine chrome.
  if (entries.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No webhooks for this run — the polled lifecycle is the source of truth.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="pane-header flex-1">Inbound webhooks</h3>
          <span className="wire-quote text-xs text-fg-muted">
            {entries.length}
          </span>
        </div>
        {note !== undefined && (
          <div className="mt-1">
            <NoteTerm
              open={noteOpen}
              onToggle={() => setNoteOpen((open) => !open)}
              subject="webhooks"
              className="text-xs"
            >
              How webhooks relate to polling
            </NoteTerm>
            {noteOpen && <NotePanel note={note} />}
          </div>
        )}
      </div>
      <ul className="space-y-2">
        {entries.map((entry) => (
          <WebhookEntry key={entry.id} entry={entry} />
        ))}
      </ul>
    </div>
  );
}
