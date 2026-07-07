import { useState } from "react";

export interface EventConsoleEntry {
  id: string;
  line: string;
}

export function EventConsoleDrawer({ entries }: { entries: EventConsoleEntry[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-edge pt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <span className="pane-header">Event console</span>
        <span className="wire-quote text-xs text-fg-muted">{entries.length}</span>
      </button>
      {open && (
        <pre className="max-h-48 overflow-auto border-t border-edge p-3 text-xs text-fg-secondary">
          {entries.map((entry) => entry.line).join("\n")}
        </pre>
      )}
    </div>
  );
}
