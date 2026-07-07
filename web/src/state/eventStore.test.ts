import { describe, expect, it } from "vitest";
import type {
  ApiExchangeEvent,
  CustomerReviewChangedEvent,
  PaymentStatusChangedEvent,
  RetryScheduledEvent,
  RunCompletedEvent,
  RunEvent,
  RunStartedEvent,
  ScenarioAssertionEvent,
  ScenarioDef,
  ScenarioId,
} from "@sse/shared";
import type { RegistrySnapshot, RunSnapshot } from "../api";
import {
  createEventStore,
  latestRunForScenario,
  scenarioChip,
  selectedRun,
} from "./eventStore";

// ---------------------------------------------------------------------------
// Fixtures — synthetic, mirroring the shared contracts (never captured output)
// ---------------------------------------------------------------------------

const DEF_A: ScenarioDef = {
  id: "a",
  label: "Happy path",
  purpose: "charge settles",
  outcomes: { customer: "verified", charge: "paid" },
  requiredObservations: [{ kind: "terminal_status", status: "paid" }],
};

const DEF_C: ScenarioDef = {
  id: "c",
  label: "Reversal",
  purpose: "paid, then reversed",
  outcomes: { customer: "verified", charge: "reversed_insufficient_funds" },
  requiredObservations: [
    { kind: "ordered_statuses", statuses: ["paid", "reversed"] },
  ],
};

const DEF_E: ScenarioDef = {
  id: "e",
  label: "Rejected identity",
  purpose: "rejected review refuses a paykey",
  outcomes: { customer: "rejected" },
  requiredObservations: [
    { kind: "customer_review", status: "rejected" },
    { kind: "api_refusal", afterAction: "create_paykey" },
  ],
};

const T0 = Date.parse("2026-07-07T14:00:00.000Z");
const at = (offsetSec: number): string =>
  new Date(T0 + offsetSec * 1_000).toISOString();

function started(
  seq: number,
  runId: string,
  scenario: ScenarioDef,
  timestamp = at(0),
): RunStartedEvent {
  return {
    type: "run.started",
    seq,
    timestamp,
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

function review(
  seq: number,
  runId: string,
  scenarioId: ScenarioId,
  reviewStatus: string,
): CustomerReviewChangedEvent {
  return {
    type: "customer.review_changed",
    seq,
    timestamp: at(seq),
    run_id: runId,
    scenario_id: scenarioId,
    customer_id: "cus_1",
    status: reviewStatus,
    review: { verification_status: reviewStatus, reason_codes: [] },
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

function retryScheduled(
  seq: number,
  runId: string,
  scenarioId: ScenarioId,
  extra: Partial<RetryScheduledEvent> = {},
): RetryScheduledEvent {
  return {
    type: "retry.scheduled",
    seq,
    timestamp: at(seq),
    run_id: runId,
    scenario_id: scenarioId,
    attempt: 2,
    delay_ms: 1_400,
    ...extra,
  };
}

function assertion(
  seq: number,
  runId: string,
  scenarioId: ScenarioId,
  kind: ScenarioAssertionEvent["kind"],
  pass: boolean,
  diagnostic?: string,
): ScenarioAssertionEvent {
  return {
    type: "scenario.assertion",
    seq,
    timestamp: at(seq),
    run_id: runId,
    scenario_id: scenarioId,
    kind,
    pass,
    ...(diagnostic !== undefined ? { diagnostic } : {}),
  };
}

function completed(
  seq: number,
  runId: string,
  scenarioId: ScenarioId,
  result: "passed" | "failed",
): RunCompletedEvent {
  return {
    type: "run.completed",
    seq,
    timestamp: at(seq),
    run_id: runId,
    scenario_id: scenarioId,
    result,
    duration_ms: seq * 1_000,
    recording_path: `runs/${runId}.jsonl`,
  };
}

function snapshotOf(runs: Array<{ def: ScenarioDef; events: RunEvent[] }>): RegistrySnapshot {
  const latest: Partial<Record<ScenarioId, string>> = {};
  const runSnapshots: RunSnapshot[] = runs.map(({ def, events }) => {
    const first = events[0];
    if (first === undefined) throw new Error("fixture run needs events");
    latest[def.id] = first.run_id;
    return {
      run_id: first.run_id,
      scenario_id: def.id,
      scenario: def,
      status: "running",
      started_at: first.timestamp,
      latest_for_scenario: true,
      events,
    };
  });
  return { runs: runSnapshots, latest_by_scenario: latest };
}

// ---------------------------------------------------------------------------

describe("eventStore reducer", () => {
  it("tolerates seq gaps — order comes from sorting, never counting", () => {
    const store = createEventStore();
    store.applyEvents([
      started(1, "run-a", DEF_A),
      // seq 2..40 belong to other runs' interleaved events (spec §5)
      status(41, "run-a", "a", null, "created"),
      status(97, "run-a", "a", "created", "paid"),
    ]);

    const run = store.getState().runs["run-a"];
    expect(run).toBeDefined();
    expect(run?.timeline.map((n) => (n.kind === "status" ? n.status : n.kind))).toEqual([
      "created",
      "paid",
    ]);
    expect(run?.latestPaymentStatus).toBe("paid");
  });

  it("sorts out-of-order deliveries by seq, including a late run.started", () => {
    const store = createEventStore();
    // paid arrives before created; run.started arrives last of all
    store.applyEvents([status(9, "run-a", "a", "created", "paid")]);
    expect(store.getState().runs["run-a"]).toBeUndefined(); // buffered, not lost

    store.applyEvents([status(5, "run-a", "a", null, "created")]);
    store.applyEvents([started(1, "run-a", DEF_A)]);

    const run = store.getState().runs["run-a"];
    expect(run?.events.map((e) => e.seq)).toEqual([1, 5, 9]);
    expect(
      run?.timeline.map((n) => (n.kind === "status" ? n.status : n.kind)),
    ).toEqual(["created", "paid"]);
  });

  it("ignores duplicate deliveries of the same seq", () => {
    const store = createEventStore();
    const paid = status(3, "run-a", "a", null, "paid");
    store.applyEvents([started(1, "run-a", DEF_A), paid]);
    const before = store.getState();
    store.applyEvents([paid]);
    expect(store.getState()).toBe(before); // no change, same snapshot reference
    expect(store.getState().runs["run-a"]?.timeline).toHaveLength(1);
  });

  it("computes elapsed-since-previous per timeline node", () => {
    const store = createEventStore();
    store.applyEvents([
      started(1, "run-a", DEF_A, at(0)),
      review(2, "run-a", "a", "verified"), // at +2s
      status(10, "run-a", "a", null, "created"), // at +10s
      status(70, "run-a", "a", "created", "paid"), // at +70s
    ]);
    const run = store.getState().runs["run-a"];
    expect(run?.timeline.map((n) => n.elapsedMs)).toEqual([null, 8_000, 60_000]);
  });
});

describe("provisional paid (scenario C contract)", () => {
  const events = (upTo: number): RunEvent[] =>
    [
      started(1, "run-c", DEF_C),
      status(3, "run-c", "c", null, "pending"),
      status(5, "run-c", "c", "pending", "paid"),
      status(8, "run-c", "c", "paid", "reversed", { return_code: "R01" }),
      assertion(9, "run-c", "c", "ordered_statuses", true),
      completed(10, "run-c", "c", "passed"),
    ].filter((e) => e.seq <= upTo);

  it("derives 'watching' while latest observed status is paid", () => {
    const store = createEventStore();
    store.applyEvents(events(5));
    const run = store.getState().runs["run-c"];
    expect(run?.expectsReversal).toBe(true);
    expect(run?.watching).toBe(true);
    expect(run?.chip).toBe("watching");
    expect(scenarioChip(store.getState(), "c")).toBe("watching");

    const paidNode = run?.timeline.find(
      (n) => n.kind === "status" && n.status === "paid",
    );
    expect(paidNode !== undefined && paidNode.kind === "status" && paidNode.provisional).toBe(true);
  });

  it("stops watching when reversed lands, but the paid node STAYS provisional", () => {
    const store = createEventStore();
    store.applyEvents(events(8));
    const run = store.getState().runs["run-c"];
    expect(run?.watching).toBe(false);
    expect(run?.chip).toBe("running"); // not yet completed

    const nodes = run?.timeline.filter((n) => n.kind === "status") ?? [];
    expect(nodes.map((n) => n.status)).toEqual(["pending", "paid", "reversed"]);
    // both transitions permanently visible (design §6.2)
    expect(nodes[1]?.provisional).toBe(true);
    expect(nodes[2]?.provisional).toBe(false);
    expect(nodes[2]?.returnCode).toBe("R01");
  });

  it("chips settle to the run result on completion", () => {
    const store = createEventStore();
    store.applyEvents(events(10));
    expect(store.getState().runs["run-c"]?.chip).toBe("passed");
  });

  it("never marks paid provisional in a non-reversal scenario", () => {
    const store = createEventStore();
    store.applyEvents([
      started(1, "run-a", DEF_A),
      status(2, "run-a", "a", null, "paid"),
    ]);
    const run = store.getState().runs["run-a"];
    expect(run?.watching).toBe(false);
    expect(run?.chip).toBe("running");
    const node = run?.timeline[0];
    expect(node?.kind === "status" && node.provisional).toBe(false);
  });
});

describe("scenario E refusal evidence", () => {
  const refusalBody = {
    error: { status: 422, type: "validation_error", detail: "customer is rejected" },
  };
  const eEvents: RunEvent[] = [
    started(1, "run-e", DEF_E),
    exchange(2, "run-e", "e", { path: "/v1/customers", status: 201 }),
    review(3, "run-e", "e", "rejected"),
    exchange(4, "run-e", "e", {
      path: "/v1/bridge/bank_account",
      status: 422,
      response_body: refusalBody,
    }),
    assertion(5, "run-e", "e", "customer_review", true),
    assertion(6, "run-e", "e", "api_refusal", true),
    completed(7, "run-e", "e", "passed"),
  ];

  it("captures the refusal and the review as evidence", () => {
    const store = createEventStore();
    store.applyEvents(eEvents);
    const run = store.getState().runs["run-e"];

    expect(run?.review).toEqual({
      status: "rejected",
      customerId: "cus_1",
      summary: { verification_status: "rejected", reason_codes: [] },
    });
    expect(run?.refusal).toEqual({
      attemptedAction: "create_paykey",
      httpStatus: 422,
      errorBody: refusalBody,
    });
    expect(run?.chip).toBe("passed");
    expect(run?.assertions.map((a) => [a.kind, a.pass])).toEqual([
      ["customer_review", true],
      ["api_refusal", true],
    ]);
  });

  it("renders review + refusal timeline nodes for the evidence card", () => {
    const store = createEventStore();
    store.applyEvents(eEvents);
    const run = store.getState().runs["run-e"];
    expect(run?.timeline.map((n) => n.kind)).toEqual(["review", "refusal"]);
    const refusalNode = run?.timeline[1];
    expect(
      refusalNode?.kind === "refusal" ? refusalNode.errorBody : undefined,
    ).toEqual(refusalBody);
  });

  it("does not treat a 4xx as refusal evidence outside refusal-expecting defs", () => {
    const store = createEventStore();
    store.applyEvents([
      started(1, "run-a", DEF_A),
      exchange(2, "run-a", "a", { path: "/v1/charges", status: 400 }),
    ]);
    expect(store.getState().runs["run-a"]?.refusal).toBeUndefined();
    expect(store.getState().runs["run-a"]?.timeline).toEqual([]);
  });
});

describe("latest run per scenario", () => {
  it("re-running a scenario makes the new run the latest", () => {
    const store = createEventStore();
    store.applyEvents([
      started(1, "run-a1", DEF_A),
      status(2, "run-a1", "a", null, "failed"),
      completed(3, "run-a1", "a", "failed"),
      started(4, "run-a2", DEF_A),
    ]);
    const state = store.getState();
    expect(state.latestByScenario.a).toBe("run-a2");
    expect(latestRunForScenario(state, "a")?.runId).toBe("run-a2");
    expect(scenarioChip(state, "a")).toBe("running"); // chip follows the LATEST run
    expect(state.runOrder).toEqual(["run-a1", "run-a2"]); // older run stays visible

    store.applyEvents([
      status(5, "run-a2", "a", null, "paid"),
      completed(6, "run-a2", "a", "passed"),
    ]);
    expect(scenarioChip(store.getState(), "a")).toBe("passed");
  });

  it("latest-run ordering follows started seq even when delivered out of order", () => {
    const store = createEventStore();
    store.applyEvents([started(9, "run-a2", DEF_A)]);
    store.applyEvents([started(1, "run-a1", DEF_A)]);
    expect(store.getState().latestByScenario.a).toBe("run-a2");
  });
});

describe("exchange list", () => {
  it("orders exchanges and folds retries in as attempts with their backoff", () => {
    const store = createEventStore();
    store.applyEvents([
      started(1, "run-a", DEF_A),
      exchange(2, "run-a", "a", { path: "/v1/customers", status: 201 }),
      exchange(3, "run-a", "a", { method: "GET", path: "/v1/charges/chg_1", status: 500 }),
      retryScheduled(4, "run-a", "a", {
        method: "GET",
        path: "/v1/charges/chg_1",
        status: 500,
        attempt: 2,
        delay_ms: 1_400,
      }),
      exchange(5, "run-a", "a", {
        method: "GET",
        path: "/v1/charges/chg_1",
        status: 200,
        attempt: 2,
      }),
      exchange(6, "run-a", "a", { path: "/v1/charges", status: 201 }),
    ]);

    const run = store.getState().runs["run-a"];
    expect(run?.exchanges.map((x) => [x.method, x.path])).toEqual([
      ["POST", "/v1/customers"],
      ["GET", "/v1/charges/chg_1"],
      ["POST", "/v1/charges"],
    ]);
    const retried = run?.exchanges[1];
    expect(retried?.attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(retried?.attempts[0]?.status).toBe(500);
    expect(retried?.attempts[0]?.backoffMs).toBeUndefined();
    expect(retried?.attempts[1]?.status).toBe(200);
    expect(retried?.attempts[1]?.backoffMs).toBe(1_400); // "attempt 2 · backoff 1.4s"
  });

  it("attaches backoff from retry.scheduled events that omit method/path", () => {
    const store = createEventStore();
    store.applyEvents([
      started(1, "run-a", DEF_A),
      exchange(2, "run-a", "a", { path: "/v1/customers", status: 502 }),
      retryScheduled(3, "run-a", "a", { attempt: 2, delay_ms: 900 }),
      exchange(4, "run-a", "a", { path: "/v1/customers", status: 201, attempt: 2 }),
    ]);
    const entry = store.getState().runs["run-a"]?.exchanges[0];
    expect(entry?.attempts).toHaveLength(2);
    expect(entry?.attempts[1]?.backoffMs).toBe(900);
  });
});

describe("selection and summary", () => {
  it("selectScenario drives selectedRun to the scenario's latest run", () => {
    const store = createEventStore();
    store.applyEvents([started(1, "run-a", DEF_A), started(2, "run-c", DEF_C)]);
    expect(selectedRun(store.getState())).toBeNull();

    store.selectScenario("c");
    expect(store.getState().selectedScenario).toBe("c");
    expect(selectedRun(store.getState())?.runId).toBe("run-c");

    store.selectScenario("b"); // no run yet — selection valid, run absent
    expect(selectedRun(store.getState())).toBeNull();
  });

  it("summarizes latest suite runs: n/5 passed and settled elapsed", () => {
    const store = createEventStore();
    store.applyEvents([
      started(1, "run-a", DEF_A, at(1)),
      status(2, "run-a", "a", null, "paid"),
      completed(4, "run-a", "a", "passed"),
      started(5, "run-c", DEF_C, at(5)),
      status(6, "run-c", "c", null, "pending"),
    ]);

    let summary = store.getState().summary;
    expect(summary.total).toBe(5);
    expect(summary.covered).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.allSettled).toBe(false);
    expect(summary.earliestStartedAt).toBe(at(1));
    expect(summary.elapsedMs).toBeNull(); // live — components tick from the anchor

    store.applyEvents([completed(120, "run-c", "c", "failed")]);
    summary = store.getState().summary;
    expect(summary.failed).toBe(1);
    expect(summary.allSettled).toBe(true);
    expect(summary.latestEndedAt).toBe(at(120));
    expect(summary.elapsedMs).toBe(119_000); // at(120) - at(1)
  });

  it("notifies subscribers once per applied batch and supports unsubscribe", () => {
    const store = createEventStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.applyEvents([started(1, "run-a", DEF_A), status(2, "run-a", "a", null, "paid")]);
    expect(calls).toBe(1);
    unsubscribe();
    store.applyEvents([completed(3, "run-a", "a", "passed")]);
    expect(calls).toBe(1);
  });
});

describe("hydration", () => {
  it("hydrate replaces all run state from a registry snapshot", () => {
    const store = createEventStore();
    // Pre-mismatch state from a dead epoch
    store.applyEvents([started(900, "run-old", DEF_A), status(901, "run-old", "a", null, "paid")]);
    store.selectScenario("a");

    // Fresh process: new run ids, seq restarted
    const snapshot = snapshotOf([
      {
        def: DEF_A,
        events: [
          started(1, "run-new-a", DEF_A),
          status(2, "run-new-a", "a", null, "created"),
        ],
      },
      { def: DEF_C, events: [started(3, "run-new-c", DEF_C)] },
    ]);
    store.hydrate(snapshot);

    const state = store.getState();
    expect(state.runs["run-old"]).toBeUndefined(); // dead-epoch state discarded
    expect(state.runOrder).toEqual(["run-new-a", "run-new-c"]);
    expect(state.latestByScenario).toEqual({ a: "run-new-a", c: "run-new-c" });
    expect(state.selectedScenario).toBe("a"); // selection names a scenario, survives
    expect(selectedRun(state)?.runId).toBe("run-new-a");
  });

  it("store.handlers wire hydrate + incremental events for the poller", () => {
    const store = createEventStore();
    store.handlers.onHydrate(
      snapshotOf([{ def: DEF_C, events: [started(1, "run-c", DEF_C)] }]),
    );
    store.handlers.onEvents([status(5, "run-c", "c", null, "paid")]);
    expect(store.getState().runs["run-c"]?.chip).toBe("watching");
  });

  it("reset clears everything", () => {
    const store = createEventStore();
    store.applyEvents([started(1, "run-a", DEF_A)]);
    store.reset();
    expect(store.getState().runOrder).toEqual([]);
    expect(store.getState().summary.covered).toBe(0);
  });
});
