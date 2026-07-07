import { expectsReversal } from "@sse/shared";
import type {
  IdentityReviewSummary,
  RequiredObservationKind,
  RunCompletedEvent,
  RunEvent,
  RunStartedEvent,
  ScenarioDef,
  ScenarioId,
} from "@sse/shared";
import type { PollerHandlers, RegistrySnapshot } from "../api";

/**
 * Event store (spec §10): a reducer over RunEvent[], keyed by run_id, ordered
 * by seq WITHOUT assuming density — per-run streams have gaps by design
 * (spec §5), so ordering is by sort, never by counting.
 *
 * The store is framework-light: plain state + subscribe/getState, directly
 * usable with React's useSyncExternalStore. Everything the UI renders —
 * per-scenario latest run, timeline nodes, exchange list, chips, summary — is
 * DERIVED here from the raw events; components never re-derive.
 */

// ---------------------------------------------------------------------------
// Derived shapes
// ---------------------------------------------------------------------------

/**
 * Scenario-row chip states (design §6.1). "idle" only ever appears at the
 * scenario level (no run yet); a materialized run is never idle. "watching"
 * is the provisional-paid state: a reversal-expecting run whose latest
 * observed payment status is `paid`, not yet completed.
 */
export type ChipStatus = "idle" | "running" | "watching" | "passed" | "failed";

/** A payment.status_changed observation (design §6.2 rail node). */
export interface TimelineStatusNode {
  kind: "status";
  seq: number;
  /** changed_at (authoritative server-side time) when present, else timestamp. */
  at: string;
  from: string | null;
  status: string;
  returnCode?: string;
  reason?: string;
  /**
   * `paid` observed in a reversal-expecting scenario. PERMANENT — the amber
   * node stays after `reversed` lands (design §6.2); only the pulse
   * (RunState.watching) stops.
   */
  provisional: boolean;
  /** ms since the previous node; null on the first node. */
  elapsedMs: number | null;
}

/** The settled customer review (one per run; all scenarios). */
export interface TimelineReviewNode {
  kind: "review";
  seq: number;
  at: string;
  status: string;
  customerId: string;
  review: IdentityReviewSummary;
  elapsedMs: number | null;
}

/** Scenario E's captured refusal — the one place a 4xx is evidence. */
export interface TimelineRefusalNode {
  kind: "refusal";
  seq: number;
  at: string;
  attemptedAction: "create_paykey" | "create_charge";
  httpStatus: number;
  errorBody: unknown;
  elapsedMs: number | null;
}

export type TimelineNode =
  | TimelineStatusNode
  | TimelineReviewNode
  | TimelineRefusalNode;

/** One HTTP attempt inside an exchange (design §6.3). */
export interface ExchangeAttempt {
  seq: number;
  attempt: number;
  status: number;
  latencyMs: number;
  at: string;
  requestBody?: unknown;
  responseBody?: unknown;
  apiRequestId?: string;
  /** Backoff of the retry.scheduled that preceded this attempt (attempt >= 2). */
  backoffMs?: number;
}

/**
 * One logical exchange: attempt 1 plus any retries of the same method+path,
 * rendered as indented sub-entries (design §6.3).
 */
export interface ExchangeEntry {
  seq: number; // seq of the first attempt
  method: string;
  path: string;
  attempts: ExchangeAttempt[];
}

export interface AssertionRow {
  seq: number;
  kind: RequiredObservationKind;
  pass: boolean;
  diagnostic?: string;
}

export interface RefusalEvidence {
  attemptedAction: "create_paykey" | "create_charge";
  httpStatus: number;
  errorBody: unknown;
}

export interface ReviewEvidence {
  status: string;
  customerId: string;
  summary: IdentityReviewSummary;
}

export interface PaykeyEvidence {
  id: string;
  status?: string;
  label?: string;
  institutionName?: string;
  account?: string;
  accountType?: string;
}

export interface RunState {
  runId: string;
  scenarioId: ScenarioId;
  /** Scenario def snapshot from run.started. */
  scenario: ScenarioDef;
  /** Derived from the def via shared expectsReversal — never stored upstream. */
  expectsReversal: boolean;
  startedSeq: number;
  startedAt: string;
  completed?: {
    result: "passed" | "failed";
    at: string;
    durationMs: number;
    recordingPath: string;
  };
  /** running | watching | passed | failed (never "idle" for a real run). */
  chip: Exclude<ChipStatus, "idle">;
  /** Live provisional-paid: expectsReversal && !completed && latest status is paid. */
  watching: boolean;
  latestPaymentStatus: string | null;
  timeline: TimelineNode[];
  exchanges: ExchangeEntry[];
  assertions: AssertionRow[];
  review?: ReviewEvidence;
  paykey?: PaykeyEvidence;
  refusal?: RefusalEvidence;
  /** Raw events, sorted by seq (gaps expected), deduped by seq. */
  events: RunEvent[];
}

/** The A–E suite the summary strip counts against (spec §5 suite semantics). */
export const SUITE_SCENARIOS: readonly ScenarioId[] = ["a", "b", "c", "d", "e"];

export interface SummaryData {
  /** Latest-run-per-scenario counts over SUITE_SCENARIOS only. */
  passed: number;
  failed: number;
  covered: number;
  total: number; // SUITE_SCENARIOS.length
  /** True when every covered suite scenario's latest run has completed. */
  allSettled: boolean;
  /** Earliest started_at across latest suite runs (elapsed-ticker anchor). */
  earliestStartedAt: string | null;
  /** Latest completion timestamp, only when allSettled. */
  latestEndedAt: string | null;
  /** Settled suite elapsed; null while anything is live (tick from anchor). */
  elapsedMs: number | null;
}

export interface ExplorerState {
  runs: Record<string, RunState>;
  /** run_ids ordered by started seq. */
  runOrder: string[];
  latestByScenario: Partial<Record<ScenarioId, string>>;
  selectedScenario: ScenarioId | null;
  summary: SummaryData;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface EventStore {
  /** Stable-reference snapshot (useSyncExternalStore-compatible). */
  getState(): ExplorerState;
  subscribe(listener: () => void): () => void;
  /** Incremental delivery; order and density are NOT assumed. */
  applyEvents(events: readonly RunEvent[]): void;
  /**
   * Full replacement from a GET /api/runs snapshot — initial load and epoch
   * mismatch (spec §3). Existing run state is discarded; selection survives
   * (it names a scenario, not a process-scoped resource).
   */
  hydrate(snapshot: RegistrySnapshot): void;
  reset(): void;
  selectScenario(id: ScenarioId | null): void;
  /** Pre-bound wiring for createEventPoller({ handlers: store.handlers }). */
  handlers: PollerHandlers;
}

export function createEventStore(): EventStore {
  /** Raw events per run, sorted by seq, deduped. Runs without a run.started
   *  yet (out-of-order delivery) are buffered here and materialize later. */
  const rawByRun = new Map<string, RunEvent[]>();
  const runStates = new Map<string, RunState>();
  const listeners = new Set<() => void>();
  let selected: ScenarioId | null = null;
  let state: ExplorerState = buildState(runStates, selected);

  function notify(): void {
    state = buildState(runStates, selected);
    for (const listener of [...listeners]) listener();
  }

  /** Insert by seq (binary position from the end — deliveries are mostly
   *  in order), rejecting duplicates. Returns whether anything changed. */
  function insert(event: RunEvent): boolean {
    let list = rawByRun.get(event.run_id);
    if (list === undefined) {
      list = [];
      rawByRun.set(event.run_id, list);
    }
    let i = list.length;
    while (i > 0) {
      const prev = list[i - 1];
      if (prev === undefined || prev.seq < event.seq) break;
      if (prev.seq === event.seq) return false; // duplicate delivery
      i -= 1;
    }
    list.splice(i, 0, event);
    return true;
  }

  function rederive(runId: string): void {
    const events = rawByRun.get(runId);
    const derived = events === undefined ? null : deriveRun(events);
    if (derived === null) runStates.delete(runId);
    else runStates.set(runId, derived);
  }

  function applyEvents(events: readonly RunEvent[]): void {
    const touched = new Set<string>();
    for (const event of events) {
      if (insert(event)) touched.add(event.run_id);
    }
    if (touched.size === 0) return;
    for (const runId of touched) rederive(runId);
    notify();
  }

  function clear(): void {
    rawByRun.clear();
    runStates.clear();
  }

  function hydrate(snapshot: RegistrySnapshot): void {
    clear();
    for (const run of snapshot.runs) {
      for (const event of run.events) insert(event);
    }
    for (const runId of rawByRun.keys()) rederive(runId);
    notify();
  }

  const store: EventStore = {
    getState: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    applyEvents,
    hydrate,
    reset(): void {
      clear();
      notify();
    },
    selectScenario(id: ScenarioId | null): void {
      if (selected === id) return;
      selected = id;
      notify();
    },
    handlers: {
      onEvents: (events) => applyEvents(events),
      onHydrate: (snapshot) => hydrate(snapshot),
    },
  };
  return store;
}

// ---------------------------------------------------------------------------
// Selectors (pure; components import these instead of re-deriving)
// ---------------------------------------------------------------------------

export function latestRunForScenario(
  state: ExplorerState,
  id: ScenarioId,
): RunState | null {
  const runId = state.latestByScenario[id];
  if (runId === undefined) return null;
  return state.runs[runId] ?? null;
}

/** Chip for a scenario row: its latest run's chip, or "idle" with no runs. */
export function scenarioChip(state: ExplorerState, id: ScenarioId): ChipStatus {
  return latestRunForScenario(state, id)?.chip ?? "idle";
}

/** The run the center/right panes render: latest run of the selection. */
export function selectedRun(state: ExplorerState): RunState | null {
  if (state.selectedScenario === null) return null;
  return latestRunForScenario(state, state.selectedScenario);
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** Materialize a run from its sorted events; null until run.started is seen. */
function deriveRun(events: readonly RunEvent[]): RunState | null {
  const started = events.find(
    (e): e is RunStartedEvent => e.type === "run.started",
  );
  if (started === undefined) return null;

  const scenario = started.scenario;
  const reversalExpected = expectsReversal(scenario);
  const refusalExpected = scenario.requiredObservations.some(
    (o) => o.kind === "api_refusal",
  );

  const timeline: TimelineNode[] = [];
  const exchanges: ExchangeEntry[] = [];
  const assertions: AssertionRow[] = [];
  /** delay_ms from retry.scheduled, keyed for the upcoming attempt. */
  const pendingBackoff = new Map<string, number>();
  let completedEvent: RunCompletedEvent | undefined;
  let review: ReviewEvidence | undefined;
  let paykey: PaykeyEvidence | undefined;
  let refusal: RefusalEvidence | undefined;
  let latestPaymentStatus: string | null = null;

  for (const event of events) {
    switch (event.type) {
      case "run.started":
        break;

      case "payment.status_changed": {
        latestPaymentStatus = event.to;
        timeline.push({
          kind: "status",
          seq: event.seq,
          at: event.changed_at ?? event.timestamp,
          from: event.from,
          status: event.to,
          ...(event.return_code !== undefined
            ? { returnCode: event.return_code }
            : {}),
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
          provisional: reversalExpected && event.to === "paid",
          elapsedMs: null,
        });
        break;
      }

      case "customer.review_changed": {
        review = {
          status: event.status,
          customerId: event.customer_id,
          summary: event.review,
        };
        timeline.push({
          kind: "review",
          seq: event.seq,
          at: event.timestamp,
          status: event.status,
          customerId: event.customer_id,
          review: event.review,
          elapsedMs: null,
        });
        break;
      }

      case "retry.scheduled": {
        pendingBackoff.set(
          backoffKey(event.method, event.path, event.attempt),
          event.delay_ms,
        );
        break;
      }

      case "api.exchange": {
        const backoffMs =
          takeBackoff(pendingBackoff, event.method, event.path, event.attempt);
        const attempt: ExchangeAttempt = {
          seq: event.seq,
          attempt: event.attempt,
          status: event.status,
          latencyMs: event.latency_ms,
          at: event.timestamp,
          ...(event.request_body !== undefined
            ? { requestBody: event.request_body }
            : {}),
          ...(event.response_body !== undefined
            ? { responseBody: event.response_body }
            : {}),
          ...(event.api_request_id !== undefined
            ? { apiRequestId: event.api_request_id }
            : {}),
          ...(backoffMs !== undefined ? { backoffMs } : {}),
        };
        // Retries fold into the exchange they retry (design §6.3 sub-entries).
        const target =
          event.attempt > 1
            ? findLast(
                exchanges,
                (x) => x.method === event.method && x.path === event.path,
              )
            : undefined;
        if (target !== undefined) {
          target.attempts.push(attempt);
        } else {
          exchanges.push({
            seq: event.seq,
            method: event.method,
            path: event.path,
            attempts: [attempt],
          });
        }

        // Scenario E: the deliberate post-rejection 4xx is EVIDENCE, not an
        // error (spec §6). Mirrors server/src/engine/report.ts deriveRefusal,
        // gated on the def actually expecting a refusal.
        if (
          refusalExpected &&
          refusal === undefined &&
          event.status >= 400 &&
          (event.path === "/v1/bridge/bank_account" ||
            event.path === "/v1/charges")
        ) {
          refusal = {
            attemptedAction:
              event.path === "/v1/bridge/bank_account"
                ? "create_paykey"
                : "create_charge",
            httpStatus: event.status,
            errorBody: event.response_body,
          };
          timeline.push({
            kind: "refusal",
            seq: event.seq,
            at: event.timestamp,
            attemptedAction: refusal.attemptedAction,
            httpStatus: refusal.httpStatus,
            errorBody: refusal.errorBody,
            elapsedMs: null,
          });
        }
        if (
          paykey === undefined &&
          event.status >= 200 &&
          event.status < 300 &&
          event.method === "POST" &&
          event.path === "/v1/bridge/bank_account"
        ) {
          paykey = derivePaykey(event.response_body);
        }
        break;
      }

      case "scenario.assertion": {
        assertions.push({
          seq: event.seq,
          kind: event.kind,
          pass: event.pass,
          ...(event.diagnostic !== undefined
            ? { diagnostic: event.diagnostic }
            : {}),
        });
        break;
      }

      case "run.completed": {
        completedEvent = event;
        break;
      }
    }
  }

  // Elapsed-since-previous across the timeline, in node (seq) order.
  let previousAt: number | null = null;
  for (const node of timeline) {
    const at = Date.parse(node.at);
    node.elapsedMs =
      previousAt === null || Number.isNaN(at)
        ? null
        : Math.max(0, at - previousAt);
    if (!Number.isNaN(at)) previousAt = at;
  }

  const watching =
    reversalExpected &&
    completedEvent === undefined &&
    latestPaymentStatus === "paid";
  const chip: RunState["chip"] =
    completedEvent !== undefined
      ? completedEvent.result
      : watching
        ? "watching"
        : "running";

  return {
    runId: started.run_id,
    scenarioId: started.scenario_id,
    scenario,
    expectsReversal: reversalExpected,
    startedSeq: started.seq,
    startedAt: started.timestamp,
    ...(completedEvent !== undefined
      ? {
          completed: {
            result: completedEvent.result,
            at: completedEvent.timestamp,
            durationMs: completedEvent.duration_ms,
            recordingPath: completedEvent.recording_path,
          },
        }
      : {}),
    chip,
    watching,
    latestPaymentStatus,
    timeline,
    exchanges,
    assertions,
    ...(review !== undefined ? { review } : {}),
    ...(paykey !== undefined ? { paykey } : {}),
    ...(refusal !== undefined ? { refusal } : {}),
    events: [...events],
  };
}

function derivePaykey(body: unknown): PaykeyEvidence | undefined {
  const envelope = asRecord(body);
  const data = asRecord(envelope.data);
  if (typeof data.id !== "string") return undefined;
  const bankData = asRecord(data.bank_data);
  return {
    id: data.id,
    ...(typeof data.status === "string" ? { status: data.status } : {}),
    ...(typeof data.label === "string" ? { label: data.label } : {}),
    ...(typeof data.institution_name === "string"
      ? { institutionName: data.institution_name }
      : {}),
    ...(typeof bankData.account_number === "string"
      ? { account: bankData.account_number }
      : {}),
    ...(typeof bankData.account_type === "string"
      ? { accountType: bankData.account_type }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function backoffKey(
  method: string | undefined,
  path: string | undefined,
  attempt: number,
): string {
  return `${method ?? "?"} ${path ?? "?"} ${attempt}`;
}

/** Exact method+path+attempt match, falling back to an anonymous retry. */
function takeBackoff(
  pending: Map<string, number>,
  method: string,
  path: string,
  attempt: number,
): number | undefined {
  for (const key of [
    backoffKey(method, path, attempt),
    backoffKey(undefined, undefined, attempt),
  ]) {
    const delay = pending.get(key);
    if (delay !== undefined) {
      pending.delete(key);
      return delay;
    }
  }
  return undefined;
}

function findLast<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && predicate(item)) return item;
  }
  return undefined;
}

function buildState(
  runStates: ReadonlyMap<string, RunState>,
  selected: ScenarioId | null,
): ExplorerState {
  const ordered = [...runStates.values()].sort(
    (a, b) => a.startedSeq - b.startedSeq,
  );
  const latestByScenario: Partial<Record<ScenarioId, string>> = {};
  for (const run of ordered) {
    // ascending startedSeq — the last write per scenario is the latest run
    latestByScenario[run.scenarioId] = run.runId;
  }
  const runs = Object.fromEntries(ordered.map((run) => [run.runId, run]));

  return {
    runs,
    runOrder: ordered.map((run) => run.runId),
    latestByScenario,
    selectedScenario: selected,
    summary: buildSummary(runs, latestByScenario),
  };
}

function buildSummary(
  runs: Record<string, RunState>,
  latestByScenario: Partial<Record<ScenarioId, string>>,
): SummaryData {
  const latestSuiteRuns = SUITE_SCENARIOS.flatMap((id) => {
    const runId = latestByScenario[id];
    const run = runId === undefined ? undefined : runs[runId];
    return run === undefined ? [] : [run];
  });

  const passed = latestSuiteRuns.filter((r) => r.chip === "passed").length;
  const failed = latestSuiteRuns.filter((r) => r.chip === "failed").length;
  const covered = latestSuiteRuns.length;
  const allSettled =
    covered > 0 && latestSuiteRuns.every((r) => r.completed !== undefined);
  const earliestStartedAt =
    latestSuiteRuns.map((r) => r.startedAt).sort()[0] ?? null;
  const latestEndedAt = allSettled
    ? (latestSuiteRuns
        .map((r) => r.completed?.at)
        .filter((at): at is string => at !== undefined)
        .sort()
        .at(-1) ?? null)
    : null;
  const elapsedMs =
    earliestStartedAt !== null && latestEndedAt !== null
      ? Math.max(0, Date.parse(latestEndedAt) - Date.parse(earliestStartedAt))
      : null;

  return {
    passed,
    failed,
    covered,
    total: SUITE_SCENARIOS.length,
    allSettled,
    earliestStartedAt,
    latestEndedAt,
    elapsedMs,
  };
}
