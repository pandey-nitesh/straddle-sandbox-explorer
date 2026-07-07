export interface DetailRow {
  label: string;
  value: string;
}

export interface DetailPanelProps {
  identityRows: DetailRow[];
  paykeyRows: DetailRow[];
}

function Rows({ rows }: { rows: DetailRow[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-fg-muted">No evidence captured yet.</p>;
  }
  return (
    <dl className="space-y-2">
      {rows.map((row) => (
        <div key={`${row.label}:${row.value}`} className="grid grid-cols-[92px_1fr] gap-2">
          <dt className="text-xs text-fg-muted">{row.label}</dt>
          <dd className="wire-quote min-w-0 truncate text-fg">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DetailPanel({ identityRows, paykeyRows }: DetailPanelProps) {
  return (
    <div className="space-y-3">
      <section>
        <h3 className="pane-header mb-2">Identity</h3>
        <Rows rows={identityRows} />
      </section>
      <section>
        <h3 className="pane-header mb-2">Paykey</h3>
        <Rows rows={paykeyRows} />
      </section>
    </div>
  );
}
