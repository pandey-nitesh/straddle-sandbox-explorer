import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Timeline, type TimelineNode } from "./Timeline";

afterEach(cleanup);

const T0 = "2026-07-07T14:02:11Z";
const T1 = "2026-07-07T14:03:07Z";
const T2 = "2026-07-07T14:06:12Z";

const C_NODES_PROVISIONAL: TimelineNode[] = [
  { id: "1", kind: "inflight", status: "created", at: T0 },
  { id: "2", kind: "inflight", status: "pending", at: T1, elapsedMs: 56_000 },
  { id: "3", kind: "provisional", status: "paid", at: T2, elapsedMs: 185_000 },
];

const C_NODES_TERMINAL: TimelineNode[] = [
  ...C_NODES_PROVISIONAL,
  {
    id: "4",
    kind: "failed",
    status: "reversed",
    at: "2026-07-07T14:08:10Z",
    elapsedMs: 118_000,
    returnCode: "R01",
  },
];

describe("Timeline provisional-paid (the signature element, §6.2)", () => {
  it("shows the amber label, watching sub-line, and pulse while live", () => {
    render(<Timeline nodes={C_NODES_PROVISIONAL} live />);
    const label = screen.getByText("paid — provisional");
    expect(label.className).toContain("text-status-provisional");
    expect(label.className).toContain("wire-quote");
    expect(screen.getByText("watching for reversal…")).toBeTruthy();
    const dots = screen.getAllByTestId("dot");
    const amber = dots[dots.length - 1]!;
    expect(amber.className).toContain("animate-provisional-pulse");
    expect(amber.className).toContain("border-status-provisional");
  });

  it("stops the pulse at terminal while the amber node STAYS", () => {
    render(<Timeline nodes={C_NODES_TERMINAL} live={false} />);
    // Node stays — both transitions permanently visible (FR-2).
    expect(screen.getByText("paid — provisional")).toBeTruthy();
    const dots = screen.getAllByTestId("dot");
    for (const dot of dots) {
      expect(dot.className).not.toContain("animate-provisional-pulse");
    }
    // reversed lands as a separate red node with its code chip.
    const reversed = screen.getByText("reversed");
    expect(reversed.className).toContain("text-status-failed");
    expect(screen.getByText("R01")).toBeTruthy();
  });
});

describe("Timeline nodes", () => {
  it("renders only observed transitions with wall clock and +m:ss deltas", () => {
    render(<Timeline nodes={C_NODES_PROVISIONAL} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3); // nothing invented
    expect(screen.getByText("created")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.getByText("+0:56")).toBeTruthy();
    expect(screen.getByText("+3:05")).toBeTruthy();
  });

  it("terminal paid (non-reversal) is filled green with a check", () => {
    render(
      <Timeline
        nodes={[{ id: "1", kind: "paid", status: "paid", at: T0 }]}
      />,
    );
    expect(screen.getByText("paid").className).toContain("text-status-paid");
    expect(screen.getByTestId("dot").className).toContain("bg-status-paid");
    expect(screen.getByLabelText("terminal success")).toBeTruthy();
  });

  it("on_hold renders as an inflight slate node — verbatim label, filled dot, distinct from cancelled", () => {
    // on_hold arrives from the projection as an `inflight` kind (design §3);
    // it is NON-terminal (a hold that will resume), so no check/code chip and
    // a filled slate dot — never the hollow cancelled ring (design §12.3).
    render(
      <Timeline
        nodes={[
          { id: "1", kind: "inflight", status: "created", at: T0 },
          {
            id: "2",
            kind: "inflight",
            status: "on_hold",
            at: T1,
            elapsedMs: 5_000,
          },
        ]}
      />,
    );
    const label = screen.getByText("on_hold");
    expect(label.className).toContain("text-status-inflight");
    expect(label.className).toContain("wire-quote"); // mono, verbatim
    const dots = screen.getAllByTestId("dot");
    const held = dots[dots.length - 1]!;
    expect(held.className).toContain("bg-status-inflight"); // filled slate
    expect(held.className).not.toContain("border-status-cancelled"); // not hollow
    expect(screen.queryByLabelText("terminal success")).toBeNull();
  });

  it("cancelled is a hollow slate ring with the reason underneath", () => {
    render(
      <Timeline
        nodes={[
          {
            id: "1",
            kind: "cancelled",
            status: "cancelled",
            at: T0,
            reason: "cancelled_for_fraud_risk",
          },
        ]}
      />,
    );
    const dot = screen.getByTestId("dot");
    expect(dot.className).toContain("border-status-cancelled");
    expect(dot.className).toContain("bg-surface-card");
    expect(dot.className).not.toContain("bg-status-");
    expect(screen.getByText("cancelled_for_fraud_risk")).toBeTruthy();
  });

  it("shows a live ticking in-flight bottom node while the run is live", () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    render(
      <Timeline
        nodes={[{ id: "1", kind: "inflight", status: "pending", at: recent }]}
        live
      />,
    );
    expect(screen.getByTestId("inflight-tick").textContent).toContain("+0:30");
  });
});

describe("Timeline evidence card (Scenario E, §6.2)", () => {
  it("renders fact rows with category tags, pass marks, and the verbatim refusal body", () => {
    const refusal = {
      error: { status: 422, detail: "customer is rejected" },
    };
    render(
      <Timeline
        nodes={[]}
        evidence={{
          rows: [
            { fact: "customer status: rejected", category: "Identity", pass: true },
            { fact: "paykey refused: 422", category: "API", pass: true },
          ],
          refusalBody: refusal,
        }}
      />,
    );
    expect(screen.getByTestId("evidence-card")).toBeTruthy();
    expect(screen.getByText("customer status: rejected")).toBeTruthy();
    expect(screen.getByText("paykey refused: 422")).toBeTruthy();
    expect(screen.getByText("Identity")).toBeTruthy();
    expect(screen.getByText("API")).toBeTruthy();
    expect(screen.getAllByLabelText("passed")).toHaveLength(2);
    // Verbatim JSON block, exactly as testimony.
    expect(screen.getByText(/"customer is rejected"/)).toBeTruthy();
  });
});
