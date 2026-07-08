import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { AppShell } from "./components/AppShell";
import { StartupState } from "./components/StartupState";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function expectNoExternalFontRequests() {
  // Fonts are self-hosted via fontsource (design §11): nothing rendered may
  // point at an external stylesheet/font host.
  const externalLinks = document.querySelectorAll(
    'link[href^="http"], link[href^="//"]',
  );
  expect(externalLinks.length).toBe(0);
  expect(document.head.innerHTML).not.toContain("fonts.googleapis.com");
  expect(document.head.innerHTML).not.toContain("fonts.gstatic.com");
}

describe("AppShell", () => {
  it("renders header, panes, summary strip, and footer per design §5", () => {
    render(<AppShell />);

    // Type-set wordmark with "Straddle" at brand weight.
    expect(screen.getByText("Straddle")).toBeTruthy();
    expect(screen.getByText(/Sandbox Explorer/)).toBeTruthy();
    // [sandbox] chip and the sole primary actions.
    expect(screen.getByText("sandbox")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run all" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Download report.json" }),
    ).toBeTruthy();

    // Pane headers (sentence case in markup; uppercase is CSS-only).
    for (const pane of ["Scenarios", "Lifecycle", "Wire"]) {
      expect(screen.getByRole("heading", { name: pane })).toBeTruthy();
    }

    // Empty-state copy (design §9) and the §1 unaffiliation footer line.
    expect(
      screen.getByText(
        /No runs yet\. Run scenario C to watch a payment settle and then un-settle\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Unofficial developer demo — not affiliated with Straddle Payments Inc.",
      ),
    ).toBeTruthy();

    expectNoExternalFontRequests();
  });

  it("marks the lifecycle pane as a polite live region (design §10)", () => {
    render(<AppShell />);
    const lifecycle = screen.getByRole("heading", { name: "Lifecycle" })
      .parentElement as HTMLElement;
    expect(lifecycle.getAttribute("aria-live")).toBe("polite");
  });
});

describe("StartupState", () => {
  it("checking: wordmark plus spinner", () => {
    render(<StartupState state="checking" />);
    expect(screen.getByText("Straddle")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
    expectNoExternalFontRequests();
  });

  it("missing key: instructions, env command in a mono block, copy button", () => {
    render(<StartupState state="missing" />);
    expect(screen.getByText("Add your sandbox API key")).toBeTruthy();
    expect(screen.getByText("dashboard.straddle.com")).toBeTruthy();
    expect(screen.getByText("cp .env.example .env")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expectNoExternalFontRequests();
  });

  it("invalid key without a body: M0's 401 status line, regenerate hint", () => {
    render(<StartupState state="invalid" />);
    expect(screen.getByText("Straddle rejected this key")).toBeTruthy();
    expect(screen.getByText("401 · no response body")).toBeTruthy();
    expect(screen.getByText(/Regenerate the key/)).toBeTruthy();
    expectNoExternalFontRequests();
  });

  it("invalid key with a body: renders the credential-redacted body verbatim as JSON", () => {
    render(
      <StartupState
        state="invalid"
        errorBody={{ error: { status: 401, title: "Unauthorized" } }}
      />,
    );
    expect(screen.queryByText("401 · no response body")).toBeNull();
    const tree = screen.getByRole("tree", { name: "JSON tree" });
    expect(tree.textContent).toContain('"Unauthorized"');
    expect(tree.textContent).toContain('"status":');
    expect(tree.textContent).toContain("401");
    expect(screen.getByRole("button", { name: "Collapse nested" })).toBeTruthy();
  });
});

describe("App startup flow (GET /api/health)", () => {
  function stubHealth(body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      })),
    );
  }

  it("shows the checking card first", () => {
    stubHealth({ epoch: "e1", key: "ok" });
    render(<App />);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("key ok → renders the shell", async () => {
    stubHealth({ epoch: "e1", key: "ok" });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run all" })).toBeTruthy(),
    );
  });

  it("key missing → missing-key card", async () => {
    stubHealth({ epoch: "e1", key: "missing" });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText("Add your sandbox API key")).toBeTruthy(),
    );
  });

  it("key invalid with empty body → status-line card", async () => {
    stubHealth({ epoch: "e1", key: "invalid" });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText("Straddle rejected this key")).toBeTruthy(),
    );
    expect(screen.getByText("401 · no response body")).toBeTruthy();
  });
});
