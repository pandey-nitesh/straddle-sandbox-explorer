import type {
  ApiExchangeEvent,
  ApiRefusal,
  CustomerReviewChangedEvent,
  PaymentStatusChangedEvent,
  Report,
  ReportScenario,
  RunCompletedEvent,
  RunEvent,
  RunStartedEvent,
  ScenarioAssertionEvent,
  StatusTransition,
} from "@sse/shared";
import { ReportSchema } from "@sse/shared";
import { recordingPathFor } from "./recorder.js";
import { REQUIRED_SCENARIO_IDS } from "./scenarios.js";

export interface BuildReportOptions {
  generatedAt?: string;
  recordingDir?: string;
}

interface RunBucket {
  started: RunStartedEvent;
  completed?: RunCompletedEvent;
  events: RunEvent[];
}

export function buildReport(
  events: readonly RunEvent[],
  options: BuildReportOptions = {},
): Report {
  const buckets = new Map<string, RunBucket>();
  for (const event of events) {
    if (event.type === "run.started") {
      buckets.set(event.run_id, { started: event, events: [event] });
      continue;
    }
    const bucket = buckets.get(event.run_id);
    if (bucket === undefined) continue;
    bucket.events.push(event);
    if (event.type === "run.completed") bucket.completed = event;
  }

  const latestByScenario = new Map<string, RunBucket>();
  for (const bucket of buckets.values()) {
    const existing = latestByScenario.get(bucket.started.scenario_id);
    if (existing === undefined || bucket.started.seq > existing.started.seq) {
      latestByScenario.set(bucket.started.scenario_id, bucket);
    }
  }

  const scenarios = [...latestByScenario.values()]
    .sort((a, b) => a.started.scenario_id.localeCompare(b.started.scenario_id))
    .map((bucket) => scenarioReport(bucket, options.recordingDir ?? "runs"));

  const covered = scenarios.map((s) => s.id);
  const anyFailed = scenarios.some((s) => s.status === "failed");
  // Coverage gates on the REQUIRED suite (A–E, spec §5), NOT the full runnable
  // set: F/G/H/I are reportable but never make a report `partial` by absence.
  // `anyFailed` still spans every covered scenario, so a failed F/G/H/I in the
  // same batch does fail the suite.
  const allCovered = REQUIRED_SCENARIO_IDS.every((id) => covered.includes(id));
  const suiteStatus = !allCovered ? "partial" : anyFailed ? "failed" : "passed";
  const latestBuckets = [...latestByScenario.values()];
  const firstStarted = minTimestamp(latestBuckets.map((bucket) => bucket.started.timestamp));
  const lastCompleted = maxTimestamp(
    latestBuckets.flatMap((b) =>
      b.completed === undefined ? [] : [b.completed.timestamp],
    ),
  );

  return ReportSchema.parse({
    generated_at: options.generatedAt ?? new Date().toISOString(),
    suite: {
      status: suiteStatus,
      duration_ms:
        firstStarted !== undefined && lastCompleted !== undefined
          ? Math.max(0, Date.parse(lastCompleted) - Date.parse(firstStarted))
          : 0,
      covered_scenarios: covered,
    },
    scenarios,
  });
}

function scenarioReport(bucket: RunBucket, recordingDir: string): ReportScenario {
  const transitions = bucket.events
    .filter((e): e is PaymentStatusChangedEvent => e.type === "payment.status_changed")
    .map(statusTransition);
  const review = bucket.events.find(
    (e): e is CustomerReviewChangedEvent => e.type === "customer.review_changed",
  );
  const assertions = bucket.events.filter(
    (e): e is ScenarioAssertionEvent => e.type === "scenario.assertion",
  );
  const diagnostics = [
    ...assertions.flatMap((a) => (a.diagnostic === undefined ? [] : [a.diagnostic])),
    ...(bucket.completed?.diagnostics ?? []),
  ];
  const refusal = deriveRefusal(bucket.events);
  const completed = bucket.completed;
  const terminal = transitions.at(-1);
  const status =
    completed === undefined ? "partial" : completed.result === "passed" ? "passed" : "failed";
  const resourceIds: Record<string, string> = {};
  if (review !== undefined) resourceIds.customer = review.customer_id;
  const chargeId = bucket.events.find(
    (e): e is PaymentStatusChangedEvent => e.type === "payment.status_changed",
  )?.resource_id;
  if (chargeId !== undefined) resourceIds.charge = chargeId;
  const paykeyId = deriveResourceId(bucket.events, "/v1/bridge/bank_account");
  if (paykeyId !== undefined) resourceIds.paykey = paykeyId;

  return {
    id: bucket.started.scenario_id,
    name: bucket.started.scenario.label,
    status,
    resource_ids: resourceIds,
    transitions,
    ...(terminal !== undefined
      ? {
          final_status: terminal.to,
          ...(terminal.return_code !== undefined
            ? { return_code: terminal.return_code }
            : {}),
          ...(terminal.reason !== undefined ? { reason_code: terminal.reason } : {}),
        }
      : {}),
    ...(review !== undefined ? { identity_review: review.review } : {}),
    ...(refusal !== undefined ? { refusal } : {}),
    recording_path:
      completed?.recording_path ?? recordingPathFor(recordingDir, bucket.started.run_id),
    duration_ms:
      completed?.duration_ms ??
      Math.max(
        0,
        Date.parse(bucket.events.at(-1)?.timestamp ?? bucket.started.timestamp) -
          Date.parse(bucket.started.timestamp),
      ),
    diagnostics,
  };
}

function statusTransition(event: PaymentStatusChangedEvent): StatusTransition {
  return {
    from: event.from,
    to: event.to,
    at: event.changed_at ?? event.timestamp,
    ...(event.return_code !== undefined ? { return_code: event.return_code } : {}),
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
  };
}

function deriveRefusal(events: readonly RunEvent[]): ApiRefusal | undefined {
  const exchange = events.find(
    (e): e is ApiExchangeEvent =>
      e.type === "api.exchange" &&
      e.status >= 400 &&
      (e.path === "/v1/bridge/bank_account" || e.path === "/v1/charges"),
  );
  if (exchange === undefined) return undefined;
  return {
    attempted_action:
      exchange.path === "/v1/bridge/bank_account" ? "create_paykey" : "create_charge",
    http_status: exchange.status,
    error_body: exchange.response_body,
  };
}

function deriveResourceId(
  events: readonly RunEvent[],
  path: string,
): string | undefined {
  const exchange = events.find(
    (e): e is ApiExchangeEvent =>
      e.type === "api.exchange" && e.path === path && e.status >= 200 && e.status < 300,
  );
  const body = exchange?.response_body;
  if (
    typeof body === "object" &&
    body !== null &&
    "data" in body &&
    typeof body.data === "object" &&
    body.data !== null &&
    "id" in body.data &&
    typeof body.data.id === "string"
  ) {
    return body.data.id;
  }
  return undefined;
}

function minTimestamp(values: Array<string | undefined>): string | undefined {
  return values.filter((v): v is string => v !== undefined).sort()[0];
}

function maxTimestamp(values: string[]): string | undefined {
  return values.sort().at(-1);
}
