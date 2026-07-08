import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AppShell } from "./AppShell";

afterEach(cleanup);

function Boom(): never {
  throw new Error("pane exploded");
}

describe("AppShell error isolation (P2-R.5)", () => {
  it("isolates a crashing pane and keeps the others live", () => {
    // React logs the caught error; silence it so the test output stays clean.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <AppShell
        lifecycle={<p>lifecycle is fine</p>}
        wire={<Boom />}
        scenarios={<p>scenarios are fine</p>}
      />,
    );

    // The crashed pane shows its fallback...
    expect(screen.getByText("This panel hit an error.")).toBeTruthy();
    // ...while the other panes render normally.
    expect(screen.getByText("lifecycle is fine")).toBeTruthy();
    expect(screen.getByText("scenarios are fine")).toBeTruthy();
    spy.mockRestore();
  });

  it("shows the stale banner only when stale", () => {
    const { rerender } = render(<AppShell />);
    expect(screen.queryByTestId("stale-banner")).toBeNull();
    rerender(<AppShell stale />);
    expect(screen.getByTestId("stale-banner")).toBeTruthy();
  });
});
