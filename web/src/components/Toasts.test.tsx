import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  PaymentStatusChangedEvent,
  RunEvent,
  RunStartedEvent,
  ScenarioDef,
  ScenarioId,
} from "@sse/shared";
import type { RegistrySnapshot, RunSnapshot } from "../api";
import { createEventStore } from "../state/eventStore";
import { Toasts } from "./Toasts";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Fixtures — synthetic, mirroring the shared contracts (never captured output)
// ---------------------------------------------------------------------------

const DEF_A: ScenarioDef = {
  id: "a",
  label: "A. Happy path",
  purpose: "charge settles",
  outcomes: { customer: "verified", charge: "paid" },
  requiredObservations: [{ kind: "terminal_status", status: "paid" }],
};

const DEF_C: ScenarioDef = {
  id: "c",
  label: "C. Reversal",
  purpose: "paid, then reversed",
  outcomes: { customer: "verified", charge: "reversed_insufficient_funds" },
  requiredObservations: [
    { kind: "ordered_statuses", statuses: ["paid", "reversed"] },
  ],
};

const at = (n: number): string => new Date(1_700_000_000_000 + n * 1_000).toISOString();

function started(seq: number, runId: string, def: ScenarioDef): RunStartedEvent {
  return {
    type: "run.started",
    seq,
    timestamp: at(seq),
    run_id: runId,
    scenario_id: def.id,
    scenario: def,
  };
}

function status(
  seq: number,
  runId: string,
  scenarioId: ScenarioId,
  from: string | null,
  to: string,
  extra: Partial<PaymentStatusChangedEvent> = {},
): PaymentStatusChangedEvent {
  return {
    type: "payment.status_changed",
    seq,
    timestamp: at(seq),
    run_id: runId,
    scenario_id: scenarioId,
    resource_id: "chg_1",
    from,
    to,
    changed_at: at(seq),
    ...extra,
  };
}

/** A C run driven to provisional `paid`. */
const cToPaid = (run = "run-c"): RunEvent[] => [
  started(1, run, DEF_C),
  status(2, run, "c", null, "pending"),
  status(3, run, "c", "pending", "paid"),
];

function snapshotOf(runs: Array<{ def: ScenarioDef; events: RunEvent[] }>): RegistrySnapshot {
  const latest: Partial<Record<ScenarioId, string>> = {};
  const runSnapshots: RunSnapshot[] = runs.map(({ def, events }) => {
    const first = events[0];
    if (first === undefined) throw new Error("fixture run needs events");
    latest[def.id] = first.run_id;
    return {
      run_id: first.run_id,
      scenario_id: def.id,
      scenario: def,
      status: "running",
      started_at: first.timestamp,
      latest_for_scenario: true,
      events,
    };
  });
  return { runs: runSnapshots, latest_by_scenario: latest };
}

/** The toast card is the element carrying the entry animation. */
function toastCard(line: string): HTMLElement {
  const button = screen.getByRole("button", { name: line });
  const card = button.parentElement;
  if (card === null) throw new Error("toast has no card element");
  return card;
}

// ---------------------------------------------------------------------------

describe("Toasts — offscreen transitions (design §6.5)", () => {
  it("toasts a notable transition on an unselected scenario with a status-colored edge", () => {
    const store = createEventStore();
    render(<Toasts store={store} />);
    act(() => store.applyEvents(cToPaid()));

    // "C · paid — provisional" per the design example, wire status verbatim.
    expect(screen.getByText("C · paid — provisional")).toBeTruthy();
    const card = toastCard("C · paid — provisional");
    // Amber provisional edge, token-based (no hard-coded hex, design §11).
    expect(card.style.borderLeftColor).toBe("var(--status-provisional)");
    // Reuses the budgeted entry animation, which reduced-motion collapses (§7).
    expect(card.className).toContain("animate-node-entry");
  });

  it("does not toast the currently selected scenario (it is already on screen)", () => {
    const store = createEventStore();
    render(<Toasts store={store} />);
    act(() => store.selectScenario("c"));
    act(() => store.applyEvents(cToPaid()));
    expect(screen.queryByText("C · paid — provisional")).toBeNull();
  });

  it("ignores in-flight steps — only notable statuses toast", () => {
    const store = createEventStore();
    render(<Toasts store={store} />);
    act(() =>
      store.applyEvents([
        started(1, "run-c", DEF_C),
        status(2, "run-c", "c", null, "created"),
        status(3, "run-c", "c", "created", "pending"),
      ]),
    );
    // created / pending are noise on an unselected scenario — no toast.
    expect(screen.queryByText(/^C ·/)).toBeNull();
  });

  it("colors terminal (non-reversal) paid green and reversed red", () => {
    const store = createEventStore();
    render(<Toasts store={store} />);
    act(() =>
      store.applyEvents([started(1, "run-a", DEF_A), status(2, "run-a", "a", null, "paid")]),
    );
    expect(toastCard("A · paid").style.borderLeftColor).toBe("var(--status-paid)");

    act(() =>
      store.applyEvents([
        ...cToPaid(),
        status(4, "run-c", "c", "paid", "reversed", { return_code: "R01" }),
      ]),
    );
    expect(toastCard("C · reversed").style.borderLeftColor).toBe("var(--status-failed)");
  });
});

describe("Toasts — de-dup and no hydration/replay flood", () => {
  it("does not toast pre-existing transitions present at first render (baseline)", () => {
    const store = createEventStore();
    store.applyEvents(cToPaid()); // already happened before the component mounts
    render(<Toasts store={store} />);
    expect(screen.queryByText("C · paid — provisional")).toBeNull();
  });

  it("does not toast rehydrated historical transitions (initial load / epoch reset)", () => {
    const store = createEventStore();
    render(<Toasts store={store} />);
    act(() => store.hydrate(snapshotOf([{ def: DEF_C, events: cToPaid() }])));
    // Hydration replaced the whole snapshot — historical, so no flood.
    expect(screen.queryByText("C · paid — provisional")).toBeNull();

    // A genuinely NEW transition after the baseline still toasts.
    act(() => store.applyEvents([status(4, "run-c", "c", "paid", "reversed", { return_code: "R01" })]));
    expect(screen.getByText("C · reversed")).toBeTruthy();
  });

  it("never toasts the same transition twice across re-derivations", () => {
    const store = createEventStore();
    render(<Toasts store={store} />);
    act(() => store.applyEvents(cToPaid()));
    expect(screen.getAllByText("C · paid — provisional")).toHaveLength(1);

    // Later events re-derive the run; the paid node keeps its key → no re-toast.
    act(() =>
      store.applyEvents([
        status(4, "run-c", "c", "paid", "reversed", { return_code: "R01" }),
      ]),
    );
    expect(screen.getAllByText("C · paid — provisional")).toHaveLength(1);
    expect(screen.getAllByText("C · reversed")).toHaveLength(1);
  });
});

describe("Toasts — lifetime and interaction", () => {
  it("auto-dismisses after ~4s", () => {
    vi.useFakeTimers();
    try {
      const store = createEventStore();
      render(<Toasts store={store} />);
      act(() => store.applyEvents(cToPaid()));
      expect(screen.getByText("C · paid — provisional")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(4_100);
      });
      expect(screen.queryByText("C · paid — provisional")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clicking a toast selects that scenario and dismisses it", () => {
    const store = createEventStore();
    const onSelect = vi.fn();
    render(<Toasts store={store} onSelect={onSelect} />);
    act(() => store.applyEvents(cToPaid()));

    fireEvent.click(screen.getByRole("button", { name: "C · paid — provisional" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("c");
    expect(screen.queryByText("C · paid — provisional")).toBeNull();
  });

  it("the dismiss control removes the toast without selecting", () => {
    const store = createEventStore();
    const onSelect = vi.fn();
    render(<Toasts store={store} onSelect={onSelect} />);
    act(() => store.applyEvents(cToPaid()));

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss C · paid — provisional" }),
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByText("C · paid — provisional")).toBeNull();
  });

  it("falls back to store.selectScenario when no onSelect is wired", () => {
    const store = createEventStore();
    render(<Toasts store={store} />);
    act(() => store.applyEvents(cToPaid()));
    fireEvent.click(screen.getByRole("button", { name: "C · paid — provisional" }));
    expect(store.getState().selectedScenario).toBe("c");
  });
});
