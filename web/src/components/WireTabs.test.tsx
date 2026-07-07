import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WireTabs } from "./WireTabs";

afterEach(cleanup);

const event = {
  seq: 42,
  timestamp: "2026-07-07T19:14:07.000Z",
  run_id: "run-c",
  scenario_id: "c",
  type: "api.exchange",
  method: "POST",
  path: "/v1/charges",
  status: 201,
  latency_ms: 240,
  attempt: 1,
  response_body: {
    data: {
      id: "charge_1",
      status_history: Array.from({ length: 30 }, (_, i) => ({
        status: i % 2 === 0 ? "pending" : "failed",
        detail: `line ${i}`,
      })),
    },
  },
};

describe("WireTabs", () => {
  it("shows one wire view at a time and keeps event JSON focusable", () => {
    render(
      <div className="h-[600px]">
        <WireTabs
          details={{ identityRows: [], paykeyRows: [] }}
          events={[
            {
              id: "42",
              seq: 42,
              type: "api.exchange",
              summary: "POST /v1/charges -> 201",
              value: event,
            },
          ]}
          consoleEntries={[{ id: "42", line: "0042 api.exchange run-c" }]}
          exchanges={[
            {
              id: "42",
              method: "POST",
              path: "/v1/charges",
              status: 201,
              latencyMs: 240,
              responseBody: event.response_body,
            },
          ]}
        />
      </div>,
    );

    expect(
      screen.getByRole("tab", { name: /Exchanges/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByText("/v1/charges")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Events/ }));
    expect(
      screen.getByRole("tab", { name: /Events/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByText("/v1/charges")).toBeNull();

    const list = screen.getByRole("list");
    expect(
      within(list)
        .getByRole("button", { name: /api.exchange/ })
        .getAttribute("aria-current"),
    ).toBe("true");
    const json = screen.getByLabelText("Selected event JSON");
    expect(json.getAttribute("tabIndex")).toBe("0");
    expect(json.className).toContain("overflow-auto");
  });
});
