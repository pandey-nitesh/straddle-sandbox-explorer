import { useRef } from "react";
import type { KeyboardEvent } from "react";
import { StatusChip, type ChipVariant } from "./StatusChip";
import { formatElapsed } from "./format";
import { useNow } from "./useNow";

/**
 * Left-pane scenario rows A–E (design §6.1). Store-agnostic view model:
 * the state layer projects its runs into these items; callbacks go out.
 */
export interface ScenarioListItem {
  id: string;
  /** Letter badge, mono 600 — "A". */
  letter: string;
  /** Row name — "Happy path". */
  name: string;
  /** One-line purpose, `--text-secondary`. */
  purpose: string;
  /** Forced sandbox outcome, verbatim wire vocabulary — rendered as
   *  `sandbox_outcome: reversed_insufficient_funds` in mono-muted. */
  outcome?: string;
  chip: ChipVariant;
  /** Chip text; defaults to the variant word. */
  chipLabel?: string;
  /** Present while the row's run is live — swaps the ghost Run button for a
   *  live elapsed mono timer. Epoch ms. */
  runningSinceEpochMs?: number;
}

export interface ScenarioListProps {
  items: ScenarioListItem[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  onRun?: (id: string) => void;
}

export function ScenarioList({
  items,
  selectedId,
  onSelect,
  onRun,
}: ScenarioListProps) {
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const anyRunning = items.some((i) => i.runningSinceEpochMs !== undefined);
  const now = useNow(anyRunning);

  // Arrow-key navigable list (design §10): roving focus over the rows.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const focused = items.findIndex(
      (i) => rowRefs.current.get(i.id) === document.activeElement,
    );
    const start = focused === -1 ? items.findIndex((i) => i.id === selectedId) : focused;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = Math.min(Math.max((start === -1 ? 0 : start) + delta, 0), items.length - 1);
    const target = items[next];
    if (target === undefined) return;
    event.preventDefault();
    rowRefs.current.get(target.id)?.focus();
    onSelect?.(target.id);
  };

  return (
    <div
      role="listbox"
      aria-label="Scenarios"
      className="space-y-2"
      onKeyDown={handleKeyDown}
    >
      {items.map((item, index) => {
        const selected = item.id === selectedId;
        const running = item.runningSinceEpochMs !== undefined;
        const tabbable = selected || (selectedId === undefined && index === 0);
        return (
          <div
            key={item.id}
            ref={(el) => {
              if (el === null) rowRefs.current.delete(item.id);
              else rowRefs.current.set(item.id, el);
            }}
            role="option"
            aria-selected={selected}
            tabIndex={tabbable ? 0 : -1}
            data-selected={selected || undefined}
            onClick={() => onSelect?.(item.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect?.(item.id);
              }
            }}
            className={`group cursor-pointer rounded-card border p-3 shadow-card ${
              selected
                ? "border-edge-strong border-l-[3px] border-l-accent bg-surface-card"
                : "border-edge border-l-[3px] border-l-transparent bg-surface-card"
            }`}
          >
            {/* Line 1: letter badge + name + status chip right-aligned. */}
            <div className="flex items-center gap-2">
              <span className="wire-quote font-semibold text-fg">
                {item.letter}
              </span>
              <span className="flex-1 truncate text-sm font-medium text-fg">
                {item.name}
              </span>
              <StatusChip variant={item.chip}>{item.chipLabel}</StatusChip>
            </div>
            {/* Line 2: one-line purpose. */}
            <p className="mt-1 truncate text-sm text-fg-secondary">
              {item.purpose}
            </p>
            {/* Line 3: forced outcome in mono-muted; ghost Run on hover,
                swapped for a live elapsed mono timer while running. */}
            <div className="mt-1 flex min-h-6 items-center justify-between gap-2">
              {item.outcome !== undefined ? (
                <span className="wire-quote truncate text-xs text-fg-muted">
                  sandbox_outcome: {item.outcome}
                </span>
              ) : (
                <span />
              )}
              {running ? (
                <span
                  data-testid={`elapsed-${item.id}`}
                  className="wire-quote shrink-0 text-xs text-fg-secondary"
                >
                  {formatElapsed(now - (item.runningSinceEpochMs ?? now))}
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={`Run scenario ${item.letter}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRun?.(item.id);
                  }}
                  className="chip-transition shrink-0 rounded-lg border border-edge px-2 py-0.5 text-xs font-medium text-fg-secondary opacity-0 hover:border-edge-strong focus-visible:opacity-100 group-hover:opacity-100"
                >
                  Run
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
