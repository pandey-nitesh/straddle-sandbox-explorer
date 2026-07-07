import { JsonBlock } from "./JsonBlock";

/**
 * Evidence-row card (design §6.2) — a direct quote of Straddle's own
 * verification-results pattern: labeled fact rows with category tags and
 * pass indicators. Scenario E's lifecycle pane renders this instead of a
 * rail; the summary strip drill-down (§6.5) reuses the same row pattern.
 */
export interface EvidenceRow {
  /** Mono, quoted-from-the-wire fact, e.g. `customer status: rejected`. */
  fact: string;
  /** Category tag, e.g. "Identity", "API". */
  category: string;
  pass: boolean;
}

export function EvidenceRows({ rows }: { rows: EvidenceRow[] }) {
  return (
    <ul className="divide-y divide-edge">
      {rows.map((row, i) => (
        <li key={i} className="flex items-center gap-2 py-2">
          <span className="wire-quote flex-1 text-fg">{row.fact}</span>
          <span className="rounded-chip border border-edge px-2 py-0.5 text-xs text-fg-secondary">
            {row.category}
          </span>
          {row.pass ? (
            <span
              aria-label="passed"
              className="text-sm font-semibold text-status-pass"
            >
              ✓
            </span>
          ) : (
            <span
              aria-label="failed"
              className="text-sm font-semibold text-status-fail"
            >
              ✗
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface EvidenceCardProps {
  rows: EvidenceRow[];
  /** Verbatim (already credential-redacted) refusal body, rendered as a JSON block. */
  refusalBody?: unknown;
}

export function EvidenceCard({ rows, refusalBody }: EvidenceCardProps) {
  return (
    <div
      data-testid="evidence-card"
      className="rounded-card border border-edge bg-surface-card p-3"
    >
      <EvidenceRows rows={rows} />
      {refusalBody !== undefined && (
        <div className="mt-3">
          <JsonBlock value={refusalBody} />
        </div>
      )}
    </div>
  );
}
