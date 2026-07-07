import { StatusChip, type ChipVariant } from "./StatusChip";

export interface RunOverviewRow {
  label: string;
  value: string;
  mono?: boolean;
}

export interface RunOverviewProps {
  label: string;
  purpose: string;
  chip: Exclude<ChipVariant, "idle">;
  chipLabel?: string;
  rows: RunOverviewRow[];
}

export function RunOverview({
  label,
  purpose,
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
