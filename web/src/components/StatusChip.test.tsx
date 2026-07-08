import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusChip, type ChipVariant } from "./StatusChip";

afterEach(cleanup);

/**
 * The scenario-row chip (design §6.1) maps straight onto the semantic token
 * layer — tokens only, no raw hexes (design §11). These guards lock that
 * mapping, including the inflight-slate `running` chip a non-terminal run
 * (e.g. a held `on_hold` charge in an H replay) shows.
 */
describe("StatusChip semantic colors (design §6.1)", () => {
  const cases: ReadonlyArray<{ variant: ChipVariant; cls: string }> = [
    { variant: "idle", cls: "text-fg-muted" },
    { variant: "running", cls: "bg-status-inflight" },
    { variant: "passed", cls: "bg-status-pass" },
    { variant: "failed", cls: "bg-status-fail" },
    { variant: "watching", cls: "bg-status-provisional" },
  ];

  it("maps each variant onto its semantic token", () => {
    for (const { variant, cls } of cases) {
      cleanup();
      render(<StatusChip variant={variant} />);
      const chip = screen.getByText(variant);
      expect(chip.className, variant).toContain(cls);
      expect(chip.dataset.variant, variant).toBe(variant);
    }
  });

  it("an in-progress run (e.g. a held on_hold charge) shows the inflight-slate running chip, distinct from terminal fills", () => {
    // on_hold is non-terminal, so the run's chip stays "running" (not
    // watching, not settled) and renders in the inflight semantic color —
    // deliberately the same slate as pending, never a terminal pass/fail fill.
    render(<StatusChip variant="running">running</StatusChip>);
    const chip = screen.getByText("running");
    expect(chip.className).toContain("bg-status-inflight");
    expect(chip.className).not.toContain("bg-status-pass");
    expect(chip.className).not.toContain("bg-status-fail");
  });

  it("defaults its label to the variant and honors explicit children", () => {
    const { rerender } = render(<StatusChip variant="passed" />);
    expect(screen.getByText("passed")).toBeTruthy();
    rerender(<StatusChip variant="passed">3/5 passed</StatusChip>);
    expect(screen.getByText("3/5 passed")).toBeTruthy();
  });
});
