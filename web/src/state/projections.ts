import type {
  RequiredObservation,
  RequiredObservationKind,
  ScenarioId,
} from "@sse/shared";
import type { EvidenceCardProps, EvidenceRow } from "../components/EvidenceCard";
import type { ExchangeEntry as ExchangeLogEntry } from "../components/ExchangeLog";
import type { ScenarioListItem } from "../components/ScenarioList";
import type { ScenarioAssertions } from "../components/RunSummary";
import type {
  RunOverviewProps,
  RunOverviewRow,
} from "../components/RunOverview";
import type {
  DetailPanelProps,
  DetailRow,
} from "../components/DetailPanel";
import type {
  EventConsoleEntry,
} from "../components/EventConsoleDrawer";
import type {
  InspectorEntry,
} from "../components/InspectorPanel";
import type {
  TimelineNode as TimelineViewNode,
  TimelineNodeKind,
} from "../components/Timeline";
import {
  latestRunForScenario,
  SUITE_SCENARIOS,
  type ExplorerState,
  type RunState,
  type TimelineStatusNode,
} from "./eventStore";

/**
 * Pure projections from the event store's derived state onto the components'
 * view-model props. This is the App-to-store seam: components stay
 * store-agnostic, the store stays component-agnostic, and everything here is
 * a pure function testable without React.
 */

// ---------------------------------------------------------------------------
// Static scenario copy (left pane, design §6.1)
// ---------------------------------------------------------------------------

/**
 * Display copy for the A–E rows BEFORE any run exists. Mirrors the labels,
 * purposes, and forced outcomes in server/src/engine/scenarios.ts
 * RUNNABLE_SCENARIOS — mirrored rather than imported because web/ must never
 * import from server/ (redactor-unreachability invariant, spec §8), and no
 * endpoint serves defs before a run starts. Once a run exists its
 * run.started def snapshot wins.
 */
export interface ScenarioCopy {
  id: ScenarioId;
  letter: string;
  name: string;
  purpose: string;
  /** Forced sandbox outcome shown in mono (charge outcome; customer for E). */
  outcome: string;
}

export const SCENARIO_COPY: readonly ScenarioCopy[] = [
  {
    id: "a",
    letter: "A",
    name: "Happy path",
    purpose: "Verified customer, active paykey, paid charge.",
    outcome: "paid",
  },
  {
    id: "b",
    letter: "B",
    name: "Insufficient funds",
    purpose: "Verified customer with an R01 bank-decline failure.",
    outcome: "failed_insufficient_funds",
  },
  {
    id: "c",
    letter: "C",
    name: "Reversal",
    purpose: "Mock/replay reversal evidence: paid before reversed.",
    outcome: "reversed_insufficient_funds",
  },
  {
    id: "d",
    letter: "D",
    name: "Risk cancellation",
    purpose: "Charge cancelled with structured reason detail.",
    outcome: "cancelled_for_fraud_risk",
  },
  {
    id: "e",
    letter: "E",
    name: "Rejected identity",
    purpose: "Rejected customer blocks downstream paykey creation.",
    outcome: "rejected",
  },
];

/** "A. Happy path" → { letter: "A", name: "Happy path" } (def label format). */
function splitLabel(label: string): { letter: string; name: string } {
  const match = /^([A-Za-z])\.\s+(.*)$/.exec(label);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return { letter: match[1].toUpperCase(), name: match[2] };
  }
  return { letter: label.slice(0, 1).toUpperCase(), name: label };
}

function outcomeOf(run: RunState): string | undefined {
  const outcomes = run.scenario.outcomes;
  return outcomes.charge ?? outcomes.customer ?? outcomes.paykey;
}

// ---------------------------------------------------------------------------
// Left pane
// ---------------------------------------------------------------------------

export function projectScenarioItems(state: ExplorerState): ScenarioListItem[] {
  return SCENARIO_COPY.map((copy) => {
    const run = latestRunForScenario(state, copy.id);
    if (run === null) {
      return {
        id: copy.id,
        letter: copy.letter,
        name: copy.name,
        purpose: copy.purpose,
        outcome: copy.outcome,
        chip: "idle" as const,
      };
    }
    const { letter, name } = splitLabel(run.scenario.label);
    const outcome = outcomeOf(run) ?? copy.outcome;
    const startedMs = Date.parse(run.startedAt);
    return {
      id: copy.id,
      letter,
      name,
      purpose: run.scenario.purpose,
      outcome,
      chip: run.chip,
      ...(run.completed === undefined && !Number.isNaN(startedMs)
        ? { runningSinceEpochMs: startedMs }
        : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Center pane (timeline rail / evidence card)
// ---------------------------------------------------------------------------

function nodeKind(node: TimelineStatusNode): TimelineNodeKind {
  if (node.provisional) return "provisional";
  if (node.status === "paid") return "paid";
  if (node.status === "failed" || node.status === "reversed") return "failed";
  if (node.status === "cancelled") return "cancelled";
  return "inflight";
}

/**
 * The rail renders one node per OBSERVED payment transition. Review and
 * refusal timeline entries are not charge transitions — the review feeds the
 * P1 identity panel and Scenario E's evidence card instead.
 */
export function projectTimelineNodes(run: RunState): TimelineViewNode[] {
  const statusNodes = run.timeline.filter(
    (node): node is TimelineStatusNode => node.kind === "status",
  );
  return statusNodes.map((node, i) => {
    // Elapsed-since-previous VISIBLE node (design §6.2): recomputed here
    // between status nodes, because the store's elapsedMs is relative to the
    // previous timeline entry of ANY kind (review/refusal), which the rail
    // filters out — the first rail node must carry no delta.
    const previous = statusNodes[i - 1];
    const at = Date.parse(node.at);
    const previousAt = previous === undefined ? NaN : Date.parse(previous.at);
    const elapsedMs =
      Number.isNaN(at) || Number.isNaN(previousAt)
        ? undefined
        : Math.max(0, at - previousAt);
    return {
      id: String(node.seq),
      kind: nodeKind(node),
      status: node.status,
      at: node.at,
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(node.returnCode !== undefined ? { returnCode: node.returnCode } : {}),
      ...(node.reason !== undefined ? { reason: node.reason } : {}),
    };
  });
}

export function projectRunOverview(run: RunState): RunOverviewProps {
  const rows: RunOverviewRow[] = [
    { label: "Run", value: run.runId, mono: true },
    {
      label: "Outcome",
      value: outcomeOf(run) ?? "n/a",
      mono: true,
    },
    {
      label: "Started",
      value: run.startedAt,
      mono: true,
    },
    {
      label: "Duration",
      value:
        run.completed === undefined
          ? "running"
          : `${Math.round(run.completed.durationMs / 1000)}s`,
      mono: true,
    },
  ];

  if (run.latestPaymentStatus !== null) {
    rows.push({ label: "Latest", value: run.latestPaymentStatus, mono: true });
  }
  if (run.completed !== undefined) {
    rows.push(
      { label: "Result", value: run.completed.result, mono: true },
      { label: "Ended", value: run.completed.at, mono: true },
      { label: "Recording", value: run.completed.recordingPath, mono: true },
    );
  }
  rows.push({
    label: "Expects",
    value: run.scenario.requiredObservations.map(describeObservation).join("; "),
  });

  return {
    label: run.scenario.label,
    purpose: run.scenario.purpose,
    ...(run.scenario.flow !== undefined && run.scenario.flow.length > 0
      ? { flow: run.scenario.flow }
      : {}),
    chip: run.chip,
    rows,
  };
}

function describeObservation(obs: RequiredObservation): string {
  switch (obs.kind) {
    case "terminal_status":
      return `terminal ${obs.status}${obs.returnCode !== undefined ? ` ${obs.returnCode}` : ""}`;
    case "ordered_statuses":
      return obs.statuses.join(" -> ");
    case "customer_review":
      return `customer ${obs.status}`;
    case "api_refusal":
      return `refusal after ${obs.afterAction}`;
  }
}

// ---------------------------------------------------------------------------
// Evidence rows (Scenario E card §6.2 + summary drill-down §6.5)
// ---------------------------------------------------------------------------

const OBSERVATION_CATEGORY: Record<RequiredObservationKind, string> = {
  terminal_status: "Status",
  ordered_statuses: "Order",
  customer_review: "Identity",
  api_refusal: "API",
};

function observationFact(obs: RequiredObservation, run: RunState): string {
  switch (obs.kind) {
    case "terminal_status":
      return `terminal ${obs.status}${obs.returnCode !== undefined ? ` ${obs.returnCode}` : ""}`;
    case "ordered_statuses":
      return obs.statuses.join(" → ");
    case "customer_review":
      return `customer status: ${run.review?.status ?? obs.status}`;
    case "api_refusal":
      return run.refusal !== undefined
        ? `${obs.afterAction === "create_paykey" ? "paykey" : "charge"} refused: ${run.refusal.httpStatus}`
        : `refusal after ${obs.afterAction}`;
  }
}

/**
 * Scenario E's evidence card (design §6.2): one row per satisfied
 * RequiredObservation, live as the evidence lands — pass state comes from the
 * evaluator's assertion when the run has completed, and from the observed
 * evidence itself while it is still live.
 */
export function projectEvidence(run: RunState): EvidenceCardProps | undefined {
  const expectsRefusal = run.scenario.requiredObservations.some(
    (o) => o.kind === "api_refusal",
  );
  if (!expectsRefusal) return undefined;
  if (run.review === undefined && run.refusal === undefined) return undefined;

  const assertionFor = (kind: RequiredObservationKind) =>
    run.assertions.find((a) => a.kind === kind);

  const rows: EvidenceRow[] = [];
  for (const obs of run.scenario.requiredObservations) {
    if (obs.kind === "customer_review" && run.review !== undefined) {
      rows.push({
        fact: observationFact(obs, run),
        category: OBSERVATION_CATEGORY[obs.kind],
        pass: assertionFor(obs.kind)?.pass ?? run.review.status === obs.status,
      });
    }
    if (obs.kind === "api_refusal" && run.refusal !== undefined) {
      rows.push({
        fact: observationFact(obs, run),
        category: OBSERVATION_CATEGORY[obs.kind],
        pass: assertionFor(obs.kind)?.pass ?? true,
      });
    }
  }

  return {
    rows,
    ...(run.refusal !== undefined && run.refusal.errorBody !== undefined
      ? { refusalBody: run.refusal.errorBody }
      : {}),
  };
}

/** Summary strip drill-down (§6.5): per-scenario assertion rows. */
export function projectAssertionRows(state: ExplorerState): ScenarioAssertions[] {
  const out: ScenarioAssertions[] = [];
  for (const id of SUITE_SCENARIOS) {
    const run = latestRunForScenario(state, id);
    if (run === null || run.assertions.length === 0) continue;
    const rows: EvidenceRow[] = run.assertions.map((assertion, i) => {
      const obs = run.scenario.requiredObservations[i];
      const base =
        obs !== undefined ? observationFact(obs, run) : assertion.kind;
      return {
        fact:
          !assertion.pass && assertion.diagnostic !== undefined
            ? `${base} — ${assertion.diagnostic}`
            : base,
        category: OBSERVATION_CATEGORY[assertion.kind],
        pass: assertion.pass,
      };
    });
    out.push({ id, label: run.scenario.label, rows });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Right pane (wire log)
// ---------------------------------------------------------------------------

/**
 * One row per logical exchange: header shows the FINAL attempt's status and
 * latency; earlier retries appear as indented `attempt N · backoff` sub-lines
 * (design §6.3 — retries visible per acceptance criterion 7).
 */
export function projectExchanges(run: RunState): ExchangeLogEntry[] {
  return run.exchanges.flatMap((exchange) => {
    const final = exchange.attempts[exchange.attempts.length - 1];
    if (final === undefined) return [];
    const retries = exchange.attempts
      .filter((a) => a.attempt >= 2)
      .map((a) => ({ attempt: a.attempt, backoffMs: a.backoffMs ?? 0 }));
    return [
      {
        id: String(exchange.seq),
        method: exchange.method,
        path: exchange.path,
        status: final.status,
        latencyMs: final.latencyMs,
        ...(final.requestBody !== undefined
          ? { requestBody: final.requestBody }
          : {}),
        ...(final.responseBody !== undefined
          ? { responseBody: final.responseBody }
          : {}),
        ...(retries.length > 0 ? { retries } : {}),
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// P1 right-pane details
// ---------------------------------------------------------------------------

export function projectDetailPanel(run: RunState): DetailPanelProps {
  const identityRows: DetailRow[] = [];
  if (run.review !== undefined) {
    identityRows.push(
      { label: "Customer", value: run.review.customerId },
      { label: "Status", value: run.review.status },
      {
        label: "Risk",
        value:
          run.review.summary.risk_score === undefined
            ? "n/a"
            : run.review.summary.risk_score.toFixed(3),
      },
      {
        label: "Correlation",
        value:
          run.review.summary.correlation_score === undefined
            ? "n/a"
            : run.review.summary.correlation_score.toFixed(3),
      },
      {
        label: "Reason codes",
        value:
          run.review.summary.reason_codes.length === 0
            ? "none"
            : run.review.summary.reason_codes.join(", "),
      },
    );
  }

  const paykeyRows: DetailRow[] = [];
  if (run.paykey !== undefined) {
    paykeyRows.push(
      { label: "Paykey", value: run.paykey.id },
      ...(run.paykey.status !== undefined
        ? [{ label: "Status", value: run.paykey.status }]
        : []),
      ...(run.paykey.institutionName !== undefined
        ? [{ label: "Institution", value: run.paykey.institutionName }]
        : []),
      ...(run.paykey.label !== undefined
        ? [{ label: "Label", value: run.paykey.label }]
        : []),
      ...(run.paykey.account !== undefined
        ? [{ label: "Account", value: run.paykey.account }]
        : []),
      ...(run.paykey.accountType !== undefined
        ? [{ label: "Type", value: run.paykey.accountType }]
        : []),
    );
  }

  return { identityRows, paykeyRows };
}

export function projectInspectorEntries(run: RunState): InspectorEntry[] {
  return run.events.map((event) => ({
    id: String(event.seq),
    seq: event.seq,
    type: event.type,
    summary: summarizeEvent(event),
    value: event,
  }));
}

export function projectEventConsoleEntries(run: RunState): EventConsoleEntry[] {
  return run.events.map((event) => ({
    id: String(event.seq),
    line: `${String(event.seq).padStart(4, "0")} ${event.type} ${event.run_id}`,
  }));
}

function summarizeEvent(event: RunState["events"][number]): string {
  switch (event.type) {
    case "api.exchange":
      return `${event.method} ${event.path} -> ${event.status}`;
    case "payment.status_changed":
      return `${event.from ?? "start"} -> ${event.to}`;
    case "customer.review_changed":
      return `customer ${event.customer_id}: ${event.status}`;
    case "retry.scheduled":
      return `attempt ${event.attempt} after ${event.delay_ms}ms`;
    case "scenario.assertion":
      return `${event.kind}: ${event.pass ? "pass" : "fail"}`;
    case "run.completed":
      return event.result;
    case "run.started":
      return event.scenario.label;
  }
}
