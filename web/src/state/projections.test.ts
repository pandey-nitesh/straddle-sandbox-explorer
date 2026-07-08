import { describe, expect, it } from "vitest";
import type {
  ApiExchangeEvent,
  PaymentStatusChangedEvent,
  RunEvent,
  RunStartedEvent,
  ScenarioDef,
  ScenarioId,
} from "@sse/shared";
import { createEventStore, latestRunForScenario } from "./eventStore";
import {
  projectDetailPanel,
  projectExchanges,
  projectRunOverview,
  projectScenarioItems,
  projectTimelineNodes,
  projectWebhooks,
} from "./projections";

/**
 * Learning-layer projection tests (spec §19): notes attach to view models
 * only with { explain: true }, and Explain-off is byte-identical to the
 * pre-learning projections — no note fields at all.
 */

const DEF_A: ScenarioDef = {
  id: "a",
  label: "A. Happy path",
  purpose: "charge settles",
  outcomes: { customer: "verified", charge: "paid" },
  requiredObservations: [{ kind: "terminal_status", status: "paid" }],
};

const DEF_B: ScenarioDef = {
  id: "b",
  label: "B. Insufficient funds",
  purpose: "bank decline",
  outcomes: { customer: "verified", charge: "failed_insufficient_funds" },
  requiredObservations: [
    { kind: "terminal_status", status: "failed", returnCode: "R01" },
  ],
};

const T0 = Date.parse("2026-07-07T14:00:00.000Z");
const at = (offsetSec: number): string =>
  new Date(T0 + offsetSec * 1_000).toISOString();

function started(seq: number, runId: string, scenario: ScenarioDef): RunStartedEvent {
  return {
    type: "run.started",
    seq,
    timestamp: at(seq),
    run_id: runId,
    scenario_id: scenario.id,
    scenario,
  };
}

function status(
  seq: number,
  runId: string,
  scenarioId: ScenarioId,
  from: string | null,
  to: string,
  extra: Partial<PaymentStatusChangedEvent> = {},
): PaymentStatusChangedEvent {
  return {
    type: "payment.status_changed",
    seq,
    timestamp: at(seq),
    run_id: runId,
    scenario_id: scenarioId,
    resource_id: "chg_1",
    from,
    to,
    changed_at: at(seq),
    ...extra,
  };
}

function exchange(
  seq: number,
  runId: string,
  scenarioId: ScenarioId,
  extra: Partial<ApiExchangeEvent> = {},
): ApiExchangeEvent {
  return {
    type: "api.exchange",
    seq,
    timestamp: at(seq),
    run_id: runId,
    scenario_id: scenarioId,
    method: "POST",
    path: "/v1/customers",
    status: 201,
    latency_ms: 120,
    attempt: 1,
    ...extra,
  };
}

function runStateOf(events: RunEvent[], scenarioId: ScenarioId) {
  const store = createEventStore();
  store.applyEvents(events);
  const run = latestRunForScenario(store.getState(), scenarioId);
  if (run === null) throw new Error("fixture produced no run");
  return run;
}

describe("learning notes on timeline nodes", () => {
  const run = runStateOf(
    [
      started(1, "run-a", DEF_A),
      status(2, "run-a", "a", null, "created"),
      status(3, "run-a", "a", "created", "pending"),
      status(4, "run-a", "a", "pending", "paid"),
    ],
    "a",
  );

  it("attaches a status note to terminal nodes only", () => {
    const nodes = projectTimelineNodes(run, { explain: true });
    const byStatus = new Map(nodes.map((n) => [n.status, n]));
    expect(byStatus.get("paid")?.statusNote?.short).toContain("settled");
    expect(byStatus.get("paid")?.statusNote?.source).toMatch(/^api-notes/);
    expect(byStatus.get("created")?.statusNote).toBeUndefined();
    expect(byStatus.get("pending")?.statusNote).toBeUndefined();
  });

  it("attaches a return-code note next to the code chip", () => {
    const failed = runStateOf(
      [
        started(1, "run-b", DEF_B),
        status(2, "run-b", "b", null, "pending"),
        status(3, "run-b", "b", "pending", "failed", { return_code: "R01" }),
      ],
      "b",
    );
    const nodes = projectTimelineNodes(failed, { explain: true });
    const terminal = nodes[nodes.length - 1];
    expect(terminal?.returnCode).toBe("R01");
    expect(terminal?.codeNote?.short).toContain("Insufficient funds");
    expect(terminal?.statusNote).toBeDefined();
  });

  it("strips every note field with explain off (and by default)", () => {
    for (const nodes of [
      projectTimelineNodes(run),
      projectTimelineNodes(run, { explain: false }),
    ]) {
      for (const node of nodes) {
        expect(node.statusNote).toBeUndefined();
        expect(node.codeNote).toBeUndefined();
      }
    }
  });
});

describe("deviation callouts on the timeline", () => {
  const LIVE_C: ScenarioDef = {
    id: "c",
    label: "C. Reversal",
    purpose: "Live deviation evidence",
    outcomes: { customer: "verified", charge: "reversed_insufficient_funds" },
    requiredObservations: [
      { kind: "terminal_status", status: "failed", returnCode: "R01" },
    ],
  };
  const CONTRACT_C: ScenarioDef = {
    ...LIVE_C,
    purpose: "paid, then reversed",
    requiredObservations: [
      { kind: "ordered_statuses", statuses: ["paid", "reversed"] },
    ],
  };

  it("live C's terminal failed node carries the dev-1 callout", () => {
    const run = runStateOf(
      [
        started(1, "run-c-live", LIVE_C),
        status(2, "run-c-live", "c", null, "pending"),
        status(3, "run-c-live", "c", "pending", "failed", { return_code: "R01" }),
      ],
      "c",
    );
    const nodes = projectTimelineNodes(run, { explain: true });
    const terminal = nodes[nodes.length - 1];
    expect(terminal?.deviation?.short).toContain("never shows paid");
    expect(nodes[0]?.deviation).toBeUndefined();
  });

  it("contract C's provisional paid node carries the mirror callout; explain off strips it", () => {
    const events = [
      started(1, "run-c", CONTRACT_C),
      status(2, "run-c", "c", null, "pending"),
      status(3, "run-c", "c", "pending", "paid"),
    ];
    const run = runStateOf(events, "c");
    const nodes = projectTimelineNodes(run, { explain: true });
    const paid = nodes.find((n) => n.kind === "provisional");
    expect(paid?.deviation?.short).toContain("never shows paid");
    for (const node of projectTimelineNodes(run)) {
      expect(node.deviation).toBeUndefined();
    }
  });

  it("scenario A never gets a deviation callout", () => {
    const run = runStateOf(
      [
        started(1, "run-a", DEF_A),
        status(2, "run-a", "a", null, "paid"),
      ],
      "a",
    );
    for (const node of projectTimelineNodes(run, { explain: true })) {
      expect(node.deviation).toBeUndefined();
    }
  });
});

describe("fields to notice on wire exchanges", () => {
  it("attaches field notes for present fields with explain on only", () => {
    const run = runStateOf(
      [
        started(1, "run-a", DEF_A),
        exchange(2, "run-a", "a", {
          method: "POST",
          path: "/v1/charges",
          request_body: {
            amount: 10_000,
            currency: "USD",
            external_id: "run-a",
            config: { balance_check: "disabled", sandbox_outcome: "paid" },
          },
          response_body: { meta: { api_request_id: "req-1" } },
        }),
      ],
      "a",
    );
    const [entry] = projectExchanges(run, { explain: true });
    const paths = (entry?.fieldNotes ?? []).map((n) => n.path);
    expect(paths).toContain("config.balance_check");
    expect(paths).toContain("Idempotency-Key (header)");
    const [off] = projectExchanges(run);
    expect(off?.fieldNotes).toBeUndefined();
  });
});

describe("detail panel notes", () => {
  function runWithEvidence() {
    const store = createEventStore();
    store.applyEvents([
      started(1, "run-a", DEF_A),
      {
        type: "customer.review_changed",
        seq: 2,
        timestamp: at(2),
        run_id: "run-a",
        scenario_id: "a",
        customer_id: "cus_1",
        status: "verified",
        review: { verification_status: "verified", risk_score: 0.1, reason_codes: [] },
      },
      exchange(3, "run-a", "a", {
        method: "POST",
        path: "/v1/bridge/bank_account",
        status: 201,
        response_body: {
          data: { id: "pk_1", status: "active", label: "BANK - *4321" },
        },
      }),
    ]);
    const run = latestRunForScenario(store.getState(), "a");
    if (run === null) throw new Error("fixture produced no run");
    return run;
  }

  it("notes the identity status quirk and the paykey token-vs-id with explain on", () => {
    const run = runWithEvidence();
    const on = projectDetailPanel(run, { explain: true });
    const statusRow = on.identityRows.find((r) => r.label === "Status");
    expect(statusRow?.note?.detail).toContain("identity_details.decision");
    const paykeyRow = on.paykeyRows.find((r) => r.label === "Paykey");
    expect(paykeyRow?.note?.short).toContain("token");
    const off = projectDetailPanel(run);
    for (const row of [...off.identityRows, ...off.paykeyRows]) {
      expect(row.note).toBeUndefined();
    }
  });
});

describe("learning notes on wire exchanges", () => {
  const run = runStateOf(
    [
      started(1, "run-a", DEF_A),
      exchange(2, "run-a", "a"),
      exchange(3, "run-a", "a", { method: "GET", path: "/v1/charges/chg_1" }),
      exchange(4, "run-a", "a", { method: "GET", path: "/v1/nonesuch" }),
    ],
    "a",
  );

  it("attaches the endpoint purpose with explain on", () => {
    const entries = projectExchanges(run, { explain: true });
    expect(entries[0]?.endpointNote).toContain("identity verification");
    expect(entries[1]?.endpointNote).toContain("Polls the charge");
    expect(entries[2]?.endpointNote).toBeUndefined();
  });

  it("attaches nothing with explain off", () => {
    for (const entry of projectExchanges(run)) {
      expect(entry.endpointNote).toBeUndefined();
    }
  });
});

describe("webhook evidence projection (P2-3.4)", () => {
  const withWebhook = (): RunEvent[] => [
    started(1, "run-a", DEF_A),
    {
      type: "webhook.received",
      seq: 2,
      timestamp: at(2),
      run_id: "run-a",
      scenario_id: "a",
      event_id: "evt_1",
      webhook_type: "charge.event.v1",
      verified: true,
      resource_id: "chg_1",
      delivered_at: at(2),
      detail: { data: { id: "chg_1", status: "paid" } },
    },
  ];

  it("yields one row per webhook with the right fields", () => {
    const run = runStateOf(withWebhook(), "a");
    const { entries } = projectWebhooks(run);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: "2",
      webhookType: "charge.event.v1",
      verified: true,
      resourceId: "chg_1",
      deliveredAt: at(2),
      detail: { data: { id: "chg_1", status: "paid" } },
    });
  });

  it("attaches the learning note with explain on, and none with it off", () => {
    const run = runStateOf(withWebhook(), "a");
    const on = projectWebhooks(run, { explain: true });
    expect(on.note?.short).toContain("corroborate");
    expect(on.note?.source).toMatch(/^api-notes §/);
    expect(projectWebhooks(run, { explain: false }).note).toBeUndefined();
    expect(projectWebhooks(run).note).toBeUndefined();
  });

  it("is empty (and note-free) for a run with no webhooks", () => {
    const run = runStateOf([started(1, "run-a", DEF_A)], "a");
    const panel = projectWebhooks(run, { explain: true });
    expect(panel.entries).toEqual([]);
    expect(panel.note).toBeUndefined();
  });
});

describe("learning notes on scenario rows and the run overview", () => {
  it("annotates idle rows from the static copy", () => {
    const store = createEventStore();
    const items = projectScenarioItems(store.getState(), { explain: true });
    expect(items).toHaveLength(5);
    for (const item of items) {
      expect(item.outcomeNote?.short, item.id).toBeDefined();
    }
    // E's outcome is a customer outcome — the note must be the customer one.
    const e = items.find((i) => i.id === "e");
    expect(e?.outcomeNote?.short).toContain("paykey");
  });

  it("annotates rows from the run def once a run exists, and strips when off", () => {
    const store = createEventStore();
    store.applyEvents([started(1, "run-a", DEF_A)]);
    const on = projectScenarioItems(store.getState(), { explain: true });
    expect(on.find((i) => i.id === "a")?.outcomeNote?.short).toContain(
      "settlement",
    );
    for (const item of projectScenarioItems(store.getState())) {
      expect(item.outcomeNote).toBeUndefined();
    }
  });

  it("notes the overview outcome row with explain on only", () => {
    const run = runStateOf([started(1, "run-a", DEF_A)], "a");
    const on = projectRunOverview(run, { explain: true });
    const outcomeRow = on.rows.find((r) => r.label === "Outcome");
    expect(outcomeRow?.note?.short).toContain("settlement");
    const off = projectRunOverview(run);
    expect(off.rows.find((r) => r.label === "Outcome")?.note).toBeUndefined();
  });
});
