import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ScenarioId } from "@sse/shared";
import {
  selectToastTransitions,
  type EventStore,
  type ToastTransition,
} from "../state/eventStore";

/**
 * Bottom-right transition toasts (design §6.5): short-lived, status-colored
 * left edge, no layout overlap. They announce notable transitions on scenarios
 * the viewer is NOT looking at — the selected scenario is already live in the
 * timeline, so it never toasts.
 *
 * Derived from the LIVE store only: replay runs on a separate store instance
 * (Dashboard), so playback produces no toasts by construction (P2-1.3).
 *
 * De-dup + no-flood: every notable transition carries a stable key
 * (run_id + status + seq), so a re-derivation never re-toasts. The first
 * observed state and any full re-hydration (initial load, epoch reset) mark
 * their transitions seen WITHOUT toasting — only transitions observed after a
 * baseline fire, so hydrating existing runs never floods the screen.
 */

const TOAST_TTL_MS = 4_000;

type ToastVariant = "provisional" | "paid" | "failed" | "cancelled" | "inflight";

/** Semantic status-layer colors (design §3) as tokens — never hard-coded hexes;
 *  inline var mirrors Timeline's precedent so the left edge is guaranteed to
 *  paint regardless of Tailwind's border-color utility generation. */
const EDGE_VAR: Record<ToastVariant, string> = {
  provisional: "var(--status-provisional)",
  paid: "var(--status-paid)",
  failed: "var(--status-failed)",
  cancelled: "var(--status-cancelled)",
  inflight: "var(--status-inflight)",
};

function variantOf(t: ToastTransition): ToastVariant {
  if (t.provisional) return "provisional";
  switch (t.status) {
    case "paid":
      return "paid";
    case "failed":
    case "reversed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "inflight"; // on_hold and any future notable in-flight-ish status
  }
}

/** "C · paid — provisional" (design §6.5); wire status stays verbatim (§4). */
function lineOf(t: ToastTransition): string {
  const label = t.provisional ? `${t.status} — provisional` : t.status;
  return `${t.scenarioId.toUpperCase()} · ${label}`;
}

interface ActiveToast {
  key: string;
  scenarioId: ScenarioId;
  line: string;
  variant: ToastVariant;
}

export interface ToastsProps {
  store: EventStore;
  /** Toast click → select the scenario. Falls back to store.selectScenario so
   *  the component works in isolation; Dashboard passes a handler that also
   *  clears any active replay view. */
  onSelect?: (id: ScenarioId) => void;
}

export function Toasts({ store, onSelect }: ToastsProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const seen = useRef<Set<string>>(new Set());
  // null until the first baseline; then it tracks the store's hydration count.
  const baseline = useRef<number | null>(null);

  useEffect(() => {
    const transitions = selectToastTransitions(state);
    // First observation OR any full re-hydration: (re)baseline, never toast.
    if (baseline.current !== state.hydrationCount) {
      baseline.current = state.hydrationCount;
      seen.current = new Set(transitions.map((t) => t.key));
      return;
    }
    const fresh: ActiveToast[] = [];
    for (const t of transitions) {
      if (seen.current.has(t.key)) continue;
      seen.current.add(t.key); // seen even when selected → never toasts later
      if (t.scenarioId === state.selectedScenario) continue;
      fresh.push({
        key: t.key,
        scenarioId: t.scenarioId,
        line: lineOf(t),
        variant: variantOf(t),
      });
    }
    if (fresh.length > 0) setToasts((prev) => [...prev, ...fresh]);
  }, [state]);

  // Stable so ToastItem's auto-dismiss timer isn't reset on every store poll.
  const dismiss = useCallback((key: string) => {
    setToasts((prev) => prev.filter((t) => t.key !== key));
  }, []);

  const handleSelect = (toast: ActiveToast) => {
    if (onSelect !== undefined) onSelect(toast.scenarioId);
    else store.selectScenario(toast.scenarioId);
    dismiss(toast.key);
  };

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-72 flex-col gap-2"
    >
      {toasts.map((toast) => (
        <ToastItem
          key={toast.key}
          toast={toast}
          onSelect={handleSelect}
          onDismiss={dismiss}
        />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onSelect,
  onDismiss,
}: {
  toast: ActiveToast;
  onSelect: (toast: ActiveToast) => void;
  onDismiss: (key: string) => void;
}) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.key), TOAST_TTL_MS);
    return () => clearTimeout(timer);
  }, [toast.key, onDismiss]);

  return (
    // animate-node-entry reuses the budgeted entry animation (design §7): a
    // 200ms fade + 4px rise that reduced-motion already collapses to "appear".
    <div
      className="animate-node-entry pointer-events-auto flex items-center gap-2 rounded-card border border-edge border-l-4 bg-surface-card px-3 py-2 shadow-card"
      style={{ borderLeftColor: EDGE_VAR[toast.variant] }}
    >
      <button
        type="button"
        onClick={() => onSelect(toast)}
        className="wire-quote min-w-0 flex-1 truncate text-left text-xs text-fg"
      >
        {toast.line}
      </button>
      <button
        type="button"
        aria-label={`Dismiss ${toast.line}`}
        onClick={() => onDismiss(toast.key)}
        className="shrink-0 rounded px-1 text-sm leading-none text-fg-muted hover:text-fg"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
