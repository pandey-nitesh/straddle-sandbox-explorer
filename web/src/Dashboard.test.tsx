import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RunEvent, ScenarioDef } from "@sse/shared";
import { Dashboard } from "./Dashboard";
import type { FetchLike, RegistrySnapshot } from "./api";

afterEach(cleanup);

/**
 * Integration: Dashboard against a scripted in-memory API (spec §9 shapes).
 * Exercises the full seam: poller → store → projections → components.
 */

const EPOCH = "epoch-qa-1";

const SCENARIO_C: ScenarioDef = {
  id: "c",
  label: "C. Reversal",
  purpose: "Mock/replay reversal evidence: paid before reversed.",
  outcomes: { customer: "verified", paykey: "active", charge: "reversed_insufficient_funds" },
  requiredObservations: [{ kind: "ordered_statuses", statuses: ["paid", "reversed"] }],
};

const SCENARIO_E: ScenarioDef = {
  id: "e",
  label: "E. Rejected identity",
  purpose: "Rejected customer blocks downstream paykey creation.",
  flow: [
    "Create a rejected customer.",
    "Capture the rejected review.",
    "Attempt paykey creation and preserve the refusal.",
  ],
  outcomes: { customer: "rejected" },
  requiredObservations: [
    { kind: "customer_review", status: "rejected" },
    { kind: "api_refusal", afterAction: "create_paykey" },
  ],
};

interface FakeApi {
  fetchFn: FetchLike;
  push(...events: RunEvent[]): void;
  record(runId: string, events: RunEvent[]): void;
  postedBodies: unknown[];
}

function createFakeApi(): FakeApi {
  const events: RunEvent[] = [];
  const recordings: Record<string, RunEvent[]> = {};
  const postedBodies: unknown[] = [];

  const jsonResponse = (body: unknown, status = 200): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  const snapshot = (): RegistrySnapshot => {
    const byRun = new Map<string, RunEvent[]>();
    for (const event of events) {
      const list = byRun.get(event.run_id) ?? [];
      list.push(event);
      byRun.set(event.run_id, list);
    }
    return {
      runs: [...byRun.entries()].flatMap(([run_id, runEvents]) => {
        const started = runEvents.find((e) => e.type === "run.started");
        if (started === undefined || started.type !== "run.started") return [];
        const completed = runEvents.find((e) => e.type === "run.completed");
        return [
          {
            run_id,
            scenario_id: started.scenario_id,
            scenario: started.scenario,
            status:
              completed?.type === "run.completed"
                ? completed.result
                : ("running" as const),
            started_at: started.timestamp,
            latest_for_scenario: true,
            events: runEvents,
          },
        ];
      }),
      latest_by_scenario: {},
    };
  };

  const fetchFn: FetchLike = async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/health")) {
      return jsonResponse({ epoch: EPOCH, key: "ok" });
    }
    if (url.startsWith("/api/runs") && init?.method === "POST") {
      postedBodies.push(JSON.parse(String(init.body)));
      return jsonResponse({ run_ids: [] }, 202);
    }
    if (url.startsWith("/api/runs")) {
      return jsonResponse(snapshot());
    }
    if (url.startsWith("/api/events")) {
      const since = Number(new URL(url, "http://x").searchParams.get("since") ?? "0");
      return jsonResponse({ epoch: EPOCH, events: events.filter((e) => e.seq > since) });
    }
    if (url.startsWith("/api/report")) {
      return jsonResponse({ error: "not scripted" }, 500);
    }
    if (url === "/api/recordings") {
      return jsonResponse(
        Object.entries(recordings).map(([run_id, recording]) => ({
          run_id,
          path: `runs/${run_id}.jsonl`,
          complete: recording.some((event) => event.type === "run.completed"),
        })),
      );
    }
    if (url.startsWith("/api/recordings/")) {
      const runId = decodeURIComponent(url.slice("/api/recordings/".length));
      const recording = recordings[runId];
      if (recording === undefined) return jsonResponse({ error: "not found" }, 404);
      return ({
        ok: true,
        status: 200,
        text: async () =>
          `${recording.map((event) => JSON.stringify(event)).join("\n")}\n`,
      }) as unknown as Response;
    }
    throw new Error(`unscripted path: ${url}`);
  };

  return {
    fetchFn,
    push: (...batch) => events.push(...batch),
    record: (runId, runEvents) => {
      recordings[runId] = runEvents;
    },
    postedBodies,
  };
}

function baseEvent(seq: number, runId: string, scenario: "c" | "e") {
  return {
    seq,
    run_id: runId,
    scenario_id: scenario,
    timestamp: new Date(1_700_000_000_000 + seq * 1_000).toISOString(),
  };
}

async function renderDashboard(api: FakeApi) {
  render(<Dashboard fetchFn={api.fetchFn} />);
  // First poll cycle hydrates from /api/runs.
  await waitFor(() => expect(screen.getByText("Happy path")).toBeTruthy());
}

describe("Dashboard wiring", () => {
  it("wires the header key pill to /api/health (spec Wave 5 item 7)", async () => {
    const api = createFakeApi();
    const fetchFn: FetchLike = async (input, init) =>
      String(input).startsWith("/api/health")
        ? ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ epoch: EPOCH, key: "invalid" }),
          } as unknown as Response)
        : api.fetchFn(input, init);
    render(<Dashboard fetchFn={fetchFn} />);
    await waitFor(() =>
      expect(document.querySelector('[data-status="invalid"]')).toBeTruthy(),
    );
  });

  it("renders the five scenario rows idle with labeled chips (not color-alone, design §10)", async () => {
    const api = createFakeApi();
    await renderDashboard(api);

    const list = screen.getByRole("list", { name: "Scenarios" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.length).toBe(5);
    // Every chip carries a TEXT label — status is never color-alone.
    for (const row of rows) {
      const chip = row.querySelector("[data-variant]") as HTMLElement;
      expect(chip.getAttribute("data-variant")).toBe("idle");
      expect(chip.textContent?.trim()).toBe("idle");
    }
    // Forced outcomes render in wire vocabulary.
    expect(
      screen.getByText(/sandbox_outcome: reversed_insufficient_funds/),
    ).toBeTruthy();
  });

  it("Run all posts the full suite and Run posts one scenario", async () => {
    const api = createFakeApi();
    await renderDashboard(api);

    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    await waitFor(() => expect(api.postedBodies.length).toBe(1));
    expect(api.postedBodies[0]).toEqual({
      scenarios: ["a", "b", "c", "d", "e"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Run scenario C" }));
    await waitFor(() => expect(api.postedBodies.length).toBe(2));
    expect(api.postedBodies[1]).toEqual({ scenarios: ["c"] });
  });

  it("projects a live C run: provisional paid stays amber after reversed lands (FR-2)", async () => {
    const api = createFakeApi();
    const run = "run-1-c";
    api.push(
      { ...baseEvent(1, run, "c"), type: "run.started", scenario: SCENARIO_C },
      {
        ...baseEvent(2, run, "c"),
        type: "payment.status_changed",
        resource_id: "chg_1",
        from: null,
        to: "created",
      },
      {
        ...baseEvent(3, run, "c"),
        type: "payment.status_changed",
        resource_id: "chg_1",
        from: "created",
        to: "paid",
      },
    );
    await renderDashboard(api);

    // Select C (click its row).
    fireEvent.click(screen.getByText("Reversal"));
    await waitFor(() =>
      expect(screen.getByText("paid — provisional")).toBeTruthy(),
    );
    expect(screen.getByText("watching for reversal…")).toBeTruthy();
    // Chip mirrors the watching state.
    const list = screen.getByRole("list", { name: "Scenarios" });
    expect(
      within(list)
        .getAllByRole("listitem")[2]
        ?.querySelector('[data-variant="watching"]'),
    ).toBeTruthy();

    // The reversal lands.
    api.push(
      {
        ...baseEvent(4, run, "c"),
        type: "payment.status_changed",
        resource_id: "chg_1",
        from: "paid",
        to: "reversed",
        return_code: "R01",
      },
      {
        ...baseEvent(5, run, "c"),
        type: "scenario.assertion",
        kind: "ordered_statuses",
        pass: true,
      },
      {
        ...baseEvent(6, run, "c"),
        type: "run.completed",
        result: "passed",
        duration_ms: 5_000,
        recording_path: `runs/${run}.jsonl`,
      },
    );
    // The poller's next 2s cycle delivers the batch.
    await waitFor(
      () => expect(screen.getAllByText("reversed").length).toBeGreaterThan(0),
      { timeout: 5_000 },
    );

    // Both nodes permanently visible: amber provisional AND red reversed.
    expect(screen.getByText("paid — provisional")).toBeTruthy();
    expect(screen.getByText("R01")).toBeTruthy();
    // Suite summary strip appears with the pass count.
    expect(screen.getByText(/1\/5 passed/)).toBeTruthy();
  }, 15_000);

  it("renders Scenario E as an evidence card with the verbatim refusal body", async () => {
    const api = createFakeApi();
    const run = "run-1-e";
    const refusalBody = {
      error: { status: 422, detail: "customer is rejected" },
    };
    api.push(
      { ...baseEvent(1, run, "e"), type: "run.started", scenario: SCENARIO_E },
      {
        ...baseEvent(2, run, "e"),
        type: "customer.review_changed",
        customer_id: "cust_1",
        status: "rejected",
        review: { verification_status: "rejected", reason_codes: [] },
      },
      {
        ...baseEvent(3, run, "e"),
        type: "api.exchange",
        method: "POST",
        path: "/v1/bridge/bank_account",
        status: 422,
        latency_ms: 120,
        attempt: 1,
        response_body: refusalBody,
      },
      {
        ...baseEvent(4, run, "e"),
        type: "scenario.assertion",
        kind: "customer_review",
        pass: true,
      },
      {
        ...baseEvent(5, run, "e"),
        type: "scenario.assertion",
        kind: "api_refusal",
        pass: true,
      },
      {
        ...baseEvent(6, run, "e"),
        type: "run.completed",
        result: "passed",
        duration_ms: 2_000,
        recording_path: `runs/${run}.jsonl`,
      },
    );
    await renderDashboard(api);

    fireEvent.click(screen.getByText("Rejected identity"));
    await waitFor(() => expect(screen.getByTestId("evidence-card")).toBeTruthy());
    const card = screen.getByTestId("evidence-card");
    expect(within(card).getByText("customer status: rejected")).toBeTruthy();
    expect(within(card).getByText("paykey refused: 422")).toBeTruthy();
    expect(within(card).getAllByLabelText("passed").length).toBe(2);
    // Verbatim refusal body as a JSON block.
    expect(card.textContent).toContain('"customer is rejected"');

    // The wire pane shows the 422 exchange with a fail-tinted chip + label.
    const wire = screen.getByRole("region", { name: "Wire" });
    expect(within(wire).getByText("POST")).toBeTruthy();
    expect(within(wire).getByText("422")).toBeTruthy();

    const lifecycle = screen.getByRole("region", { name: "Lifecycle" });
    expect(lifecycle.textContent).toContain(run);
    expect(lifecycle.textContent).toContain(SCENARIO_E.purpose);
    expect(lifecycle.textContent).toContain("Create a rejected customer.");
    expect(lifecycle.textContent).toContain(
      "Attempt paykey creation and preserve the refusal.",
    );
    expect(lifecycle.textContent).toContain(
      "customer rejected; refusal after create_paykey",
    );
    expect(lifecycle.textContent).toContain(`runs/${run}.jsonl`);
  });

  it("plays a selected replay into the main lifecycle and wire panes", async () => {
    const api = createFakeApi();
    const run = "run-replay-c";
    api.record(run, [
      { ...baseEvent(1, run, "c"), type: "run.started", scenario: SCENARIO_C },
      {
        ...baseEvent(2, run, "c"),
        type: "api.exchange",
        method: "POST",
        path: "/v1/charges",
        status: 201,
        latency_ms: 120,
        attempt: 1,
      },
      {
        ...baseEvent(3, run, "c"),
        type: "payment.status_changed",
        resource_id: "chg_1",
        from: null,
        to: "created",
      },
      {
        ...baseEvent(4, run, "c"),
        type: "payment.status_changed",
        resource_id: "chg_1",
        from: "created",
        to: "paid",
      },
    ]);
    await renderDashboard(api);
    await screen.findByRole("option", { name: run });

    fireEvent.click(screen.getByRole("button", { name: "Play 10x" }));

    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Lifecycle" })).getByText(run),
      ).toBeTruthy(),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Lifecycle" })).queryByText(
          /No runs yet\. Run scenario C/,
        ),
      ).toBeNull(),
    );

    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Lifecycle" })).getByText(
          "paid — provisional",
        ),
      ).toBeTruthy(),
    );
    const wire = screen.getByRole("region", { name: "Wire" });
    fireEvent.click(within(wire).getByRole("tab", { name: /Exchanges/ }));
    await waitFor(() =>
      expect(within(wire).getByText("/v1/charges")).toBeTruthy(),
    );
  });

  it("keeps the lifecycle pane a polite live region and Run all focusable (design §10)", async () => {
    const api = createFakeApi();
    await renderDashboard(api);

    const lifecycle = screen.getByRole("region", { name: "Lifecycle" });
    expect(lifecycle.getAttribute("aria-live")).toBe("polite");

    const runAll = screen.getByRole("button", { name: "Run all" });
    runAll.focus();
    expect(document.activeElement).toBe(runAll);
  });
});
