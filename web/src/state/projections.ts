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
import type { NoteContent } from "../components/Note";
import type {
  DeviationNote,
  KnowledgeEntry,
  OutcomeEntry,
} from "../knowledge";
import {
  endpointNote,
  fieldNotesFor,
  outcomeNote,
  returnCodeNote,
  statusNote,
  timelineDeviationsFor,
} from "../knowledge";

/**
 * Learning-layer switch (design §6.6): projections attach knowledge notes to
 * view models only while Explain is on, so components stay note-agnostic and
 * Explain-off is provably the pre-learning screen.
 */
export interface ProjectionOptions {
  explain?: boolean;
}

function toNote(entry: KnowledgeEntry | undefined): NoteContent | undefined {
  if (entry === undefined) return undefined;
  return {
    term: entry.term,
    short: entry.short,
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    source: entry.source,
  };
}

/** Deviation → always-visible timeline callout content (design §6.6). */
function toCallout(dev: DeviationNote): NoteContent {
  return { short: dev.headline, detail: dev.detail, source: dev.source };
}

/** The outcome shown for a run/row is charge ?? customer ?? paykey (E shows
 *  the customer outcome) — the note lookup must use the same resource. */
function outcomeNoteFor(outcomes: {
  customer?: string | undefined;
  paykey?: string | undefined;
  charge?: string | undefined;
}): NoteContent | undefined {
  const resource: OutcomeEntry["resource"] | null =
    outcomes.charge !== undefined
      ? "charge"
      : outcomes.customer !== undefined
        ? "customer"
        : outcomes.paykey !== undefined
          ? "paykey"
          : null;
  if (resource === null) return undefined;
  const outcome =
    outcomes.charge ?? outcomes.customer ?? outcomes.paykey ?? "";
  return toNote(outcomeNote(resource, outcome));
}

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
  /** Which resource `outcome` forces — keys the learning note lookup. */
  outcomeResource: "charge" | "customer";
}

export const SCENARIO_COPY: readonly ScenarioCopy[] = [
  {
    id: "a",
    letter: "A",
    name: "Happy path",
    purpose: "Verified customer, active paykey, paid charge.",
    outcome: "paid",
    outcomeResource: "charge",
  },
  {
    id: "b",
    letter: "B",
    name: "Insufficient funds",
    purpose: "Verified customer with an R01 bank-decline failure.",
    outcome: "failed_insufficient_funds",
    outcomeResource: "charge",
  },
  {
    id: "c",
    letter: "C",
    name: "Reversal",
    purpose: "Mock/replay reversal evidence: paid before reversed.",
    outcome: "reversed_insufficient_funds",
    outcomeResource: "charge",
  },
  {
    id: "d",
    letter: "D",
    name: "Risk cancellation",
    purpose: "Charge cancelled with structured reason detail.",
    outcome: "cancelled_for_fraud_risk",
    outcomeResource: "charge",
  },
  {
    id: "e",
    letter: "E",
    name: "Rejected identity",
    purpose: "Rejected customer blocks downstream paykey creation.",
    outcome: "rejected",
    outcomeResource: "customer",
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

export function projectScenarioItems(
  state: ExplorerState,
  opts: ProjectionOptions = {},
): ScenarioListItem[] {
  const explain = opts.explain ?? false;
  return SCENARIO_COPY.map((copy) => {
    const run = latestRunForScenario(state, copy.id);
    if (run === null) {
      const note = explain
        ? toNote(outcomeNote(copy.outcomeResource, copy.outcome))
        : undefined;
      return {
        id: copy.id,
        letter: copy.letter,
        name: copy.name,
        purpose: copy.purpose,
        outcome: copy.outcome,
        ...(note !== undefined ? { outcomeNote: note } : {}),
        chip: "idle" as const,
      };
    }
    const { letter, name } = splitLabel(run.scenario.label);
    const outcome = outcomeOf(run) ?? copy.outcome;
    const startedMs = Date.parse(run.startedAt);
    const note = explain ? outcomeNoteFor(run.scenario.outcomes) : undefined;
    return {
      id: copy.id,
      letter,
      name,
      purpose: run.scenario.purpose,
      outcome,
      ...(note !== undefined ? { outcomeNote: note } : {}),
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
/** Terminal node kinds get status notes (design §6.6 sparse policy: the
 *  Lifecycle pane annotates the state machine's endpoints, nothing else). */
const TERMINAL_NODE_KINDS: readonly TimelineNodeKind[] = [
  "paid",
  "failed",
  "cancelled",
];

export function projectTimelineNodes(
  run: RunState,
  opts: ProjectionOptions = {},
): TimelineViewNode[] {
  const explain = opts.explain ?? false;
  const deviations = explain
    ? timelineDeviationsFor(run.scenario)
    : ({} as ReturnType<typeof timelineDeviationsFor>);
  const statusNodes = run.timeline.filter(
    (node): node is TimelineStatusNode => node.kind === "status",
  );
  const lastIndex = statusNodes.length - 1;
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
    const kind = nodeKind(node);
    const note =
      explain && TERMINAL_NODE_KINDS.includes(kind)
        ? toNote(statusNote(node.status))
        : undefined;
    const codeNote =
      explain && node.returnCode !== undefined
        ? toNote(returnCodeNote(node.returnCode))
        : undefined;
    // Deviation callouts (design §6.6): the live C/D terminal explains what
    // this failure means in production; contract C's provisional paid node
    // explains that the live sandbox cannot show this sequence.
    const deviation =
      kind === "provisional" && deviations.provisional !== undefined
        ? toCallout(deviations.provisional)
        : i === lastIndex &&
            TERMINAL_NODE_KINDS.includes(kind) &&
            deviations.terminal !== undefined
          ? toCallout(deviations.terminal)
          : undefined;
    return {
      id: String(node.seq),
      kind,
      status: node.status,
      at: node.at,
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(node.returnCode !== undefined ? { returnCode: node.returnCode } : {}),
      ...(node.reason !== undefined ? { reason: node.reason } : {}),
      ...(note !== undefined ? { statusNote: note } : {}),
      ...(codeNote !== undefined ? { codeNote } : {}),
      ...(deviation !== undefined ? { deviation } : {}),
    };
  });
}

export function projectRunOverview(
  run: RunState,
  opts: ProjectionOptions = {},
): RunOverviewProps {
  const explain = opts.explain ?? false;
  const outcomeRowNote = explain
    ? outcomeNoteFor(run.scenario.outcomes)
    : undefined;
  const rows: RunOverviewRow[] = [
    { label: "Run", value: run.runId, mono: true },
    {
      label: "Outcome",
      value: outcomeOf(run) ?? "n/a",
      mono: true,
      ...(outcomeRowNote !== undefined ? { note: outcomeRowNote } : {}),
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
export function projectExchanges(
  run: RunState,
  opts: ProjectionOptions = {},
): ExchangeLogEntry[] {
  const explain = opts.explain ?? false;
  return run.exchanges.flatMap((exchange) => {
    const final = exchange.attempts[exchange.attempts.length - 1];
    if (final === undefined) return [];
    const retries = exchange.attempts
      .filter((a) => a.attempt >= 2)
      .map((a) => ({ attempt: a.attempt, backoffMs: a.backoffMs ?? 0 }));
    const note = explain
      ? endpointNote(exchange.method, exchange.path)?.short
      : undefined;
    const fieldNotes = explain
      ? fieldNotesFor(
          exchange.method,
          exchange.path,
          final.requestBody,
          final.responseBody,
        )
      : [];
    return [
      {
        id: String(exchange.seq),
        method: exchange.method,
        path: exchange.path,
        status: final.status,
        latencyMs: final.latencyMs,
        ...(note !== undefined ? { endpointNote: note } : {}),
        ...(fieldNotes.length > 0 ? { fieldNotes } : {}),
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

/** Detail-panel quirk notes (design §6.6 sparse policy: the three identity /
 *  paykey facts a newcomer would otherwise get wrong). */
const IDENTITY_STATUS_NOTE: NoteContent = {
  short:
    "The customer's status field is the authoritative verification result.",
  detail:
    'The review payload\'s identity_details.decision is canned synthetic data — it reads "accept" even for rejected customers.',
  source: "api-notes §6",
};
const IDENTITY_SCORES_NOTE: NoteContent = {
  short: "Scores nest per module — no flat top-level score exists.",
  detail:
    "Risk maps from identity_details.breakdown.fraud.risk_score and correlation from breakdown.email.correlation_score, with documented fallbacks.",
  source: "api-notes §6",
};
const PAYKEY_ID_NOTE: NoteContent = {
  short:
    "Charges reference the paykey token, not this id — and the token is credential-class, raw only in the bridge create response.",
  source: "api-notes §7",
};

export function projectDetailPanel(
  run: RunState,
  opts: ProjectionOptions = {},
): DetailPanelProps {
  const explain = opts.explain ?? false;
  const identityRows: DetailRow[] = [];
  if (run.review !== undefined) {
    identityRows.push(
      { label: "Customer", value: run.review.customerId },
      {
        label: "Status",
        value: run.review.status,
        ...(explain ? { note: IDENTITY_STATUS_NOTE } : {}),
      },
      {
        label: "Risk",
        value:
          run.review.summary.risk_score === undefined
            ? "n/a"
            : run.review.summary.risk_score.toFixed(3),
        ...(explain ? { note: IDENTITY_SCORES_NOTE } : {}),
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
      {
        label: "Paykey",
        value: run.paykey.id,
        ...(explain ? { note: PAYKEY_ID_NOTE } : {}),
      },
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
    case "webhook.received":
      // Stored/inspectable but not yet surfaced in a dedicated pane (P2-3.4).
      return `webhook ${event.webhook_type} ${event.verified ? "verified" : "unverified"}`;
  }
}
