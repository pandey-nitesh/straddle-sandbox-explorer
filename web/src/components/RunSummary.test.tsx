import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RunSummary } from "./RunSummary";

afterEach(cleanup);

describe("RunSummary (§6.5)", () => {
  it("renders the mono suite line", () => {
    render(<RunSummary passed={3} total={5} elapsedMs={702_000} />);
    const line = screen.getByText("3/5 passed · 11:42 elapsed");
    expect(line.className).toContain("wire-quote");
  });

  it("fires the download callback from the sole primary button", () => {
    const onDownloadReport = vi.fn();
    render(
      <RunSummary
        passed={5}
        total={5}
        elapsedMs={360_000}
        onDownloadReport={onDownloadReport}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Download report.json" }),
    );
    expect(onDownloadReport).toHaveBeenCalledTimes(1);
  });

  it("disables download until a callback is wired", () => {
    render(<RunSummary passed={0} total={5} elapsedMs={0} />);
    const button = screen.getByRole("button", {
      name: "Download report.json",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("expands to per-scenario assertion rows reusing the evidence-row pattern", () => {
    render(
      <RunSummary
        passed={1}
        total={5}
        elapsedMs={120_000}
        scenarios={[
          {
            id: "c",
            label: "C. Reversal",
            rows: [
              {
                fact: "ordered: paid before reversed",
                category: "Lifecycle",
                pass: false,
              },
            ],
          },
        ]}
      />,
    );
    expect(screen.queryByText("C. Reversal")).toBeNull();
    fireEvent.click(screen.getByText("1/5 passed · 2:00 elapsed"));
    expect(screen.getByText("C. Reversal")).toBeTruthy();
    expect(screen.getByText("ordered: paid before reversed")).toBeTruthy();
    expect(screen.getByLabelText("failed")).toBeTruthy();
  });
});
