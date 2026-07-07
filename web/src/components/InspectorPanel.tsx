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
    <div className="space-y-2 border-t border-edge pt-4">
      <div className="flex items-center gap-2">
        <h3 className="pane-header flex-1">Inspector</h3>
        <input
          aria-label="Filter events"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="wire-quote w-32 rounded-inset border border-edge bg-surface-inset px-2 py-1 text-xs text-fg"
          placeholder="filter"
        />
      </div>
      <div className="grid max-h-72 grid-cols-[140px_1fr] gap-2 overflow-hidden">
        <ul className="min-h-0 overflow-y-auto border-r border-edge pr-2">
          {filtered.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
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
        <div className="min-w-0 overflow-y-auto">
          {selected === null ? (
            <p className="text-xs text-fg-muted">No events.</p>
          ) : (
            <>
              <p className="wire-quote mb-2 truncate text-xs text-fg-secondary">
                {selected.summary}
              </p>
              <JsonBlock value={selected.value} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
