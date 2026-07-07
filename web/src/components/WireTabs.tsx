import { useMemo, useState, type ReactNode } from "react";
import { DetailPanel, type DetailPanelProps } from "./DetailPanel";
import {
  EventConsoleDrawer,
  type EventConsoleEntry,
} from "./EventConsoleDrawer";
import { ExchangeLog, type ExchangeEntry } from "./ExchangeLog";
import { InspectorPanel, type InspectorEntry } from "./InspectorPanel";

export interface WireTabsProps {
  details: DetailPanelProps;
  events: InspectorEntry[];
  consoleEntries: EventConsoleEntry[];
  exchanges: ExchangeEntry[];
}

type WireTabId = "details" | "events" | "exchanges" | "console";

interface WireTab {
  id: WireTabId;
  label: string;
  count?: number;
}

export function WireTabs({
  details,
  events,
  consoleEntries,
  exchanges,
}: WireTabsProps) {
  const tabs = useMemo<WireTab[]>(
    () => [
      { id: "exchanges", label: "Exchanges", count: exchanges.length },
      { id: "events", label: "Events", count: events.length },
      { id: "details", label: "Details" },
      { id: "console", label: "Console", count: consoleEntries.length },
    ],
    [consoleEntries.length, events.length, exchanges.length],
  );
  const [active, setActive] = useState<WireTabId>(
    exchanges.length > 0 ? "exchanges" : "details",
  );
  const activeTab = tabs.find((tab) => tab.id === active) ?? {
    id: "exchanges",
    label: "Exchanges",
    count: exchanges.length,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Wire views"
        className="grid shrink-0 grid-cols-4 gap-1 rounded-inset bg-surface-inset p-1"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab.id === tab.id}
            aria-controls={`wire-panel-${tab.id}`}
            id={`wire-tab-${tab.id}`}
            onClick={() => setActive(tab.id)}
            className={`wire-quote min-w-0 rounded-inset px-2 py-1 text-xs ${
              activeTab.id === tab.id
                ? "bg-surface-card text-fg shadow-card"
                : "text-fg-muted hover:text-fg-secondary"
            }`}
          >
            <span className="block truncate">{tab.label}</span>
            {tab.count !== undefined && (
              <span className="text-[0.6875rem] text-fg-muted">{tab.count}</span>
            )}
          </button>
        ))}
      </div>
      <div
        id={`wire-panel-${activeTab.id}`}
        role="tabpanel"
        aria-labelledby={`wire-tab-${activeTab.id}`}
        className="mt-4 min-h-0 flex-1 overflow-hidden"
      >
        {activeTab.id === "details" && <DetailPanel {...details} />}
        {activeTab.id === "events" && <InspectorPanel entries={events} />}
        {activeTab.id === "exchanges" && (
          <ScrollablePanel empty={exchanges.length === 0 ? "No exchanges yet." : undefined}>
            <ExchangeLog entries={exchanges} />
          </ScrollablePanel>
        )}
        {activeTab.id === "console" && (
          <ScrollablePanel>
            <EventConsoleDrawer entries={consoleEntries} defaultOpen />
          </ScrollablePanel>
        )}
      </div>
    </div>
  );
}

function ScrollablePanel({
  children,
  empty,
}: {
  children: ReactNode;
  empty?: string;
}) {
  if (empty !== undefined) {
    return <p className="text-sm text-fg-muted">{empty}</p>;
  }
  return <div className="h-full min-h-0 overflow-y-auto pr-1">{children}</div>;
}
