import { useMemo, useState } from "react";
import { JsonBlock } from "./JsonBlock";

export interface InspectorEntry {
  id: string;
  seq: number;
  type: string;
  summary: string;
  value: unknown;
}

export function InspectorPanel({ entries }: { entries: InspectorEntry[] }) {
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(entries[0]?.id ?? null);
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (q === "") return entries;
    return entries.filter(
      (entry) =>
        entry.type.toLowerCase().includes(q) ||
        entry.summary.toLowerCase().includes(q) ||
        String(entry.seq).includes(q),
    );
  }, [entries, filter]);
  const selected =
    filtered.find((entry) => entry.id === selectedId) ?? filtered[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2">
        <h3 className="pane-header flex-1">Inspector</h3>
        <span className="wire-quote text-xs text-fg-muted">
          {filtered.length}/{entries.length}
        </span>
        <input
          aria-label="Filter events"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="wire-quote w-32 rounded-inset border border-edge bg-surface-inset px-2 py-1 text-xs text-fg"
          placeholder="filter"
        />
      </div>
      <div className="mt-2 grid min-h-0 flex-1 grid-cols-[160px_minmax(0,1fr)] gap-2 overflow-hidden">
        <ul className="min-h-0 overflow-y-auto border-r border-edge pr-2">
          {filtered.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                aria-current={selected?.id === entry.id ? "true" : undefined}
                onClick={() => setSelectedId(entry.id)}
                className={`wire-quote w-full truncate rounded-inset px-1 py-1 text-left text-xs ${
                  selected?.id === entry.id ? "bg-surface-inset text-fg" : "text-fg-muted"
                }`}
              >
                {entry.seq} {entry.type}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          {selected === null ? (
            <p className="text-xs text-fg-muted">No events.</p>
          ) : (
            <>
              <p className="wire-quote mb-2 shrink-0 truncate text-xs text-fg-secondary">
                {selected.summary}
              </p>
              <JsonBlock
                value={selected.value}
                label="Selected event JSON"
                className="min-h-0 flex-1 max-h-none"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
