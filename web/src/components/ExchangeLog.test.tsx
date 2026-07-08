import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExchangeLog, type ExchangeEntry } from "./ExchangeLog";
import { formatBackoff } from "./format";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ENTRIES: ExchangeEntry[] = [
  {
    id: "1",
    method: "POST",
    path: "/v1/charges",
    status: 201,
    latencyMs: 210,
    requestBody: { amount: 1000, external_id: "run-x" },
    responseBody: { id: "chg_1", status: "created" },
  },
  {
    id: "2",
    method: "GET",
    path: "/v1/charges/chg_1",
    status: 429,
    latencyMs: 95,
    responseBody: { error: { status: 429, title: "Too Many Requests" } },
    retries: [{ attempt: 2, backoffMs: 1400 }],
  },
];

describe("ExchangeLog", () => {
  it("renders method, path, status chip, and latency per entry (§6.3)", () => {
    render(<ExchangeLog entries={ENTRIES} />);
    expect(screen.getByText("POST")).toBeTruthy();
    expect(screen.getByText("/v1/charges")).toBeTruthy();
    expect(screen.getByText("210ms")).toBeTruthy();
    // 2xx pass tint, 4xx/5xx fail tint.
    const ok = screen.getByText("201");
    expect(ok.getAttribute("data-tone")).toBe("pass");
    expect(ok.className).toContain("text-status-pass");
    const limited = screen.getByText("429");
    expect(limited.getAttribute("data-tone")).toBe("fail");
    expect(limited.className).toContain("text-status-fail");
  });

  it("shows the full path inline, on hover title, and copies it", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const path =
      "/v1/charges/019f3e03-a142-7b63-aaa1-e48381fc9f9b";

    render(
      <ExchangeLog
        entries={[
          {
            id: "long-path",
            method: "GET",
            path,
            status: 200,
            latencyMs: 83,
          },
        ]}
      />,
    );

    expect(screen.getByText(path)).toBeTruthy();
    expect(screen.getAllByTitle(path).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: `Copy path: ${path}` }));
    expect(writeText).toHaveBeenCalledWith(path);
  });

  it("renders retries as indented sub-entries labeled attempt · backoff", () => {
    render(<ExchangeLog entries={ENTRIES} />);
    const retry = screen.getByText("attempt 2 · backoff 1.4s");
    expect(retry.className).toContain("pl-6");
    expect(retry.className).toContain("wire-quote");
  });

  it("expands bodies to collapsible inset JSON trees with provenance edges", () => {
    const { container } = render(<ExchangeLog entries={[ENTRIES[0]!]} />);
    const header = screen.getByRole("button", { expanded: false });
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    // Verbatim bodies, rendered as a navigable JSON tree.
    expect(container.textContent).toContain('"external_id":');
    expect(container.textContent).toContain('"run-x"');
    expect(screen.getByText(/"chg_1"/)).toBeTruthy();
    expect(screen.getAllByRole("tree").length).toBe(2);
    expect(screen.getAllByRole("button", { name: "Expand all" }).length).toBe(2);
    expect(
      screen.getAllByRole("button", { name: "Collapse nested" }).length,
    ).toBe(2);
    // Teal client edge on the request, purple server edge on the response.
    expect(container.querySelector(".border-l-wire-client")).toBeTruthy();
    expect(container.querySelector(".border-l-wire-server")).toBeTruthy();
    const block = container.querySelector(".sse-json-tree");
    expect(block?.parentElement?.className).toContain("bg-surface-inset");
  });

  it("shows the empty state when no exchanges exist", () => {
    render(<ExchangeLog entries={[]} />);
    expect(screen.getByText("No exchanges yet.")).toBeTruthy();
  });
});

describe("format helpers", () => {
  it("formats backoff seconds (1400 → 1.4s, 2000 → 2s)", () => {
    expect(formatBackoff(1400)).toBe("1.4s");
    expect(formatBackoff(2000)).toBe("2s");
  });

});
