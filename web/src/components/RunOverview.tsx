import { StatusChip, type ChipVariant } from "./StatusChip";

export interface RunOverviewRow {
  label: string;
  value: string;
  mono?: boolean;
}

export interface RunOverviewProps {
  label: string;
  purpose: string;
  flow?: readonly string[];
  chip: Exclude<ChipVariant, "idle">;
  chipLabel?: string;
  rows: RunOverviewRow[];
}

export function RunOverview({
  label,
  purpose,
  flow,
  chip,
  chipLabel,
  rows,
}: RunOverviewProps) {
  return (
    <section className="mb-5 rounded-inset border border-edge bg-surface-inset p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-fg">{label}</h3>
          <p className="mt-1 text-sm leading-5 text-fg-secondary">{purpose}</p>
        </div>
        <StatusChip variant={chip}>{chipLabel}</StatusChip>
      </div>
      {flow !== undefined && flow.length > 0 && (
        <div className="mt-3 rounded-inset border border-edge bg-surface-card p-3">
          <h4 className="pane-header mb-2">Flow</h4>
          <ol className="space-y-1.5">
            {flow.map((step, index) => (
              <li
                key={`${index}:${step}`}
                className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2 text-xs leading-5 text-fg-secondary"
              >
                <span className="wire-quote text-fg-muted">{index + 1}</span>
                <span className="min-w-0 break-words">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <dl className="mt-3 space-y-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="grid grid-cols-[88px_minmax(0,1fr)] gap-2"
          >
            <dt className="text-xs text-fg-muted">{row.label}</dt>
            <dd
              className={`min-w-0 break-words text-xs text-fg ${
                row.mono === true ? "wire-quote" : ""
              }`}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
