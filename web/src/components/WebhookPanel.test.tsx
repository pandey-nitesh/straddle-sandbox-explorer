import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WebhookPanel, type WebhookViewEntry } from "./WebhookPanel";

afterEach(cleanup);

const verifiedEntry: WebhookViewEntry = {
  id: "3",
  webhookType: "charge.event.v1",
  verified: true,
  resourceId: "chg_1",
  deliveredAt: "2026-07-07T19:14:07.000Z",
  detail: { data: { id: "chg_1", status: "failed" }, type: "charge.event.v1" },
};

const unverifiedEntry: WebhookViewEntry = {
  id: "5",
  webhookType: "customer.event.v1",
  verified: false,
  resourceId: "cus_1",
};

describe("WebhookPanel", () => {
  it("renders each webhook's type, verified badge, resource id, and detail", () => {
    render(<WebhookPanel entries={[verifiedEntry]} />);
    expect(screen.getByText("charge.event.v1")).toBeTruthy();
    expect(screen.getByText("verified")).toBeTruthy();
    expect(screen.getByText("chg_1")).toBeTruthy();
    // The redacted detail renders as a JSON block (verbatim testimony).
    expect(
      screen.getByLabelText("Webhook charge.event.v1 detail"),
    ).toBeTruthy();
  });

  it("distinguishes verified (pass-ish) from unverified (caution)", () => {
    render(<WebhookPanel entries={[verifiedEntry, unverifiedEntry]} />);
    const verified = screen.getByText("verified");
    const unverified = screen.getByText("unverified");
    expect(verified.getAttribute("data-tone")).toBe("verified");
    expect(unverified.getAttribute("data-tone")).toBe("unverified");
    // Semantic tokens, not raw hexes: pass token for verified, caution for not.
    expect(verified.className).toContain("text-status-pass");
    expect(unverified.className).toContain("text-status-provisional");
  });

  it("renders a clean empty state with no chrome", () => {
    render(<WebhookPanel entries={[]} />);
    expect(screen.getByText(/No webhooks for this run/)).toBeTruthy();
    expect(screen.queryByText("Inbound webhooks")).toBeNull();
  });

  it("exposes the learning note as a click-to-expand affordance only when provided", () => {
    const note = {
      short: "Webhooks corroborate; polling stays authoritative.",
      source: "api-notes §12.22",
    };
    render(<WebhookPanel entries={[verifiedEntry]} note={note} />);
    const trigger = screen.getByRole("button", { name: /Explain webhooks/ });
    // Sparse by default — the prose is behind a click (design §6.6).
    expect(screen.queryByText(note.short)).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText(note.short)).toBeTruthy();
  });

  it("shows no note affordance when none is provided (Explain off)", () => {
    render(<WebhookPanel entries={[verifiedEntry]} />);
    expect(screen.queryByRole("button", { name: /Explain webhooks/ })).toBeNull();
  });
});
