import { useState } from "react";
import { CopyValueButton } from "./CopyValueButton";
import { JsonBlock } from "./JsonBlock";
import { formatBackoff, truncateMiddle } from "./format";

/**
 * Wire log (design §6.3): chronological redacted exchanges for the selected
 * scenario. The 3px left edges use the provenance accents from Straddle's own
 * Bridge logging palette — teal for our requests, purple for their responses.
 * Error bodies are never summarized or recolored: verbatim JSON as testimony.
 */
export interface ExchangeRetry {
  /** Upcoming attempt number, always >= 2. */
  attempt: number;
  /** Backoff delay before this attempt. */
  backoffMs: number;
}

export interface ExchangeEntry {
  /** Stable key — the api.exchange event `seq` works. */
  id: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  /** Redacted bodies; absent means nothing to expand (e.g. the 0-byte 401). */
  requestBody?: unknown;
  responseBody?: unknown;
  /** Retry attempts, rendered as indented sub-entries (`attempt 2 · backoff 1.4s`). */
  retries?: ExchangeRetry[];
}

export interface ExchangeLogProps {
  entries: ExchangeEntry[];
}

function StatusCodeChip({ status }: { status: number }) {
  const pass = status < 400;
  return (
    <span
      data-tone={pass ? "pass" : "fail"}
      className={`wire-quote rounded-chip px-1.5 py-0.5 text-xs ${
        pass
          ? "bg-status-pass/10 text-status-pass"
          : "bg-status-fail/10 text-status-fail"
      }`}
    >
      {status}
    </span>
  );
}

function Exchange({ entry }: { entry: ExchangeEntry }) {
  const [open, setOpen] = useState(false);
  const expandable =
    entry.requestBody !== undefined || entry.responseBody !== undefined;

  return (
    <li className="border-b border-edge pb-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          disabled={!expandable}
          title={entry.path}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-inset px-1 py-1 text-left hover:bg-surface-inset disabled:hover:bg-transparent"
        >
          <span className="wire-quote font-semibold text-fg">
            {entry.method}
          </span>
          <span
            className="wire-quote min-w-0 flex-1 truncate text-fg-secondary"
            title={entry.path}
          >
            {truncateMiddle(entry.path)}
          </span>
          <StatusCodeChip status={entry.status} />
          <span className="wire-quote shrink-0 text-xs text-fg-muted">
            {Math.round(entry.latencyMs)}ms
          </span>
        </button>
        <CopyValueButton label="path" value={entry.path} />
      </div>

      {/* Retry attempts as indented sub-entries — the client's 429/5xx
          behavior made visible (acceptance criterion 7). */}
      {entry.retries?.map((retry) => (
        <div
          key={retry.attempt}
          className="wire-quote mt-1 pl-6 text-xs text-fg-muted"
        >
          attempt {retry.attempt} · backoff {formatBackoff(retry.backoffMs)}
        </div>
      ))}

      {open && (
        <div className="mt-2 space-y-2">
          {entry.requestBody !== undefined && (
            <div className="border-l-[3px] border-l-wire-client pl-2">
              <div className="mb-1 text-xs text-fg-muted">request</div>
              <JsonBlock value={entry.requestBody} />
            </div>
          )}
          {entry.responseBody !== undefined && (
            <div className="border-l-[3px] border-l-wire-server pl-2">
              <div className="mb-1 text-xs text-fg-muted">response</div>
              <JsonBlock value={entry.responseBody} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function ExchangeLog({ entries }: ExchangeLogProps) {
  if (entries.length === 0) {
    return <p className="text-sm text-fg-muted">No exchanges yet.</p>;
  }
  return (
    <ul className="space-y-2">
      {entries.map((entry) => (
        <Exchange key={entry.id} entry={entry} />
      ))}
    </ul>
  );
}
