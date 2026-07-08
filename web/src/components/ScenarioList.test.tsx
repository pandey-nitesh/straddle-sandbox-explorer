import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScenarioList, type ScenarioListItem } from "./ScenarioList";
import { StatusChip } from "./StatusChip";

afterEach(cleanup);

const ITEMS: ScenarioListItem[] = [
  {
    id: "a",
    letter: "A",
    name: "Happy path",
    purpose: "Verified customer, active paykey, paid charge.",
    outcome: "paid",
    chip: "passed",
  },
  {
    id: "c",
    letter: "C",
    name: "Reversal",
    purpose: "Mock/replay reversal evidence: paid before reversed.",
    outcome: "reversed_insufficient_funds",
    chip: "watching",
    chipLabel: "watch",
  },
];

describe("StatusChip", () => {
  it("maps each variant onto the semantic token layer (design §6.1)", () => {
    const { container } = render(
      <>
        <StatusChip variant="idle" />
        <StatusChip variant="running" />
        <StatusChip variant="passed" />
        <StatusChip variant="failed" />
        <StatusChip variant="watching" />
      </>,
    );
    const chip = (variant: string) =>
      container.querySelector(`[data-variant="${variant}"]`) as HTMLElement;
    expect(chip("idle").className).toContain("border-edge-strong");
    expect(chip("running").className).toContain("bg-status-inflight");
    expect(chip("passed").className).toContain("bg-status-pass");
    expect(chip("failed").className).toContain("bg-status-fail");
    expect(chip("watching").className).toContain("bg-status-provisional");
    // Default label is the variant word; radius-chip + 150ms cross-fade.
    expect(chip("watching").textContent).toBe("watching");
    expect(chip("idle").className).toContain("rounded-chip");
    expect(chip("idle").className).toContain("chip-transition");
  });
});

describe("ScenarioList", () => {
  it("renders letter badge, purpose, and the mono forced-outcome line", () => {
    render(<ScenarioList items={ITEMS} />);
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("Happy path")).toBeTruthy();
    expect(
      screen.getByText("Verified customer, active paykey, paid charge."),
    ).toBeTruthy();
    // Wire vocabulary verbatim, mono (design §4/§6.1).
    const outcome = screen.getByText(
      "sandbox_outcome: reversed_insufficient_funds",
    );
    expect(outcome.className).toContain("wire-quote");
    // Chip label override ("watch" per the §5 layout sketch).
    expect(screen.getByText("watch")).toBeTruthy();
  });

  it("marks the selected row with the accent left edge", () => {
    render(<ScenarioList items={ITEMS} selectedId="c" />);
    const rows = screen.getAllByRole("listitem");
    const selected = rows.find((r) => r.getAttribute("aria-current") === "true");
    expect(selected?.className).toContain("border-l-accent");
    expect(selected?.className).toContain("border-edge-strong");
    const unselected = rows.find((r) => r.getAttribute("aria-current") === null);
    expect(unselected?.className).toContain("border-l-transparent");
  });

  it("clicking a row selects; the ghost Run button runs without selecting", () => {
    const onSelect = vi.fn();
    const onRun = vi.fn();
    render(<ScenarioList items={ITEMS} onSelect={onSelect} onRun={onRun} />);
    fireEvent.click(screen.getByText("Happy path"));
    expect(onSelect).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: "Run scenario C" }));
    expect(onRun).toHaveBeenCalledWith("c");
    expect(onSelect).toHaveBeenCalledTimes(1); // stopPropagation held
  });

  it("Enter on an inner button never selects the row (keyboard guard)", () => {
    const onSelect = vi.fn();
    render(<ScenarioList items={ITEMS} onSelect={onSelect} />);
    const runButton = screen.getByRole("button", { name: "Run scenario C" });
    // Bubbled Enter from a focused inner button must not be hijacked by the
    // row handler — the button keeps its native activation (audit finding).
    fireEvent.keyDown(runButton, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("running rows swap the Run button for a live elapsed mono timer", () => {
    const items: ScenarioListItem[] = [
      { ...ITEMS[1]!, chip: "running", runningSinceEpochMs: Date.now() - 65_000 },
    ];
    render(<ScenarioList items={items} />);
    expect(screen.queryByRole("button", { name: "Run scenario C" })).toBeNull();
    const timer = screen.getByTestId("elapsed-c");
    expect(timer.textContent).toBe("1:05");
    expect(timer.className).toContain("wire-quote");
  });

  it("is arrow-key navigable (design §10)", () => {
    const onSelect = vi.fn();
    render(<ScenarioList items={ITEMS} selectedId="a" onSelect={onSelect} />);
    const list = screen.getByRole("list", { name: "Scenarios" });
    const rows = screen.getAllByRole("listitem");
    rows[0]!.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith("c");
    expect(document.activeElement).toBe(rows[1]);
  });
});
