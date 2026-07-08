import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Faker, base, en, en_US } from "@faker-js/faker";
import {
  SEEDED_BANK,
  type ApiRefusal,
  type IdentityReviewSummary,
  type Report,
  type RunEvent,
  type ScenarioId,
  type StatusTransition,
} from "@sse/shared";
import type { EventBus } from "./bus.js";
import { evaluateScenario, emitAssertions } from "./evaluator.js";
import { buildReport } from "./report.js";
import { recordingPathFor } from "./recorder.js";
import {
  requireScenario,
  type RunnableScenarioDef,
  type RunnableScenarioId,
  type ScenarioMode,
} from "./scenarios.js";
import { DEFAULT_POLL_POLICY, poll, RateFloorScheduler } from "./poller.js";
import type { PollPolicy } from "./poller.js";
import { isStraddleApiError } from "../straddle/errors.js";
import { createMockStraddleClient } from "../straddle/mock.js";
import type {
  ChargeResult,
  Clock,
  CustomerResult,
  PaykeyResult,
  StraddleClient,
} from "../straddle/types.js";

export interface RunOptions {
  scenarios: ScenarioId[];
  concurrency: "concurrent" | "serial";
  bus: EventBus;
  clock?: Clock;
  recordingDir?: string;
  reportPath?: string;
  pollPolicy?: Partial<PollPolicy>;
  /** Scenario C variant per spec §18.1: "contract" (mock/replay) or "live". */
  mode?: ScenarioMode;
  clientFactory?: (context: RunContext) => StraddleClient;
  /** Called synchronously after run IDs are allocated, before work awaits. */
  onRunIds?: (runIds: string[]) => void;
  /**
   * Interrupt-safe shutdown (P2-R.2). When aborted mid-suite the runner stops
   * starting new scenarios, snapshots the report from whatever evidence exists,
   * and returns `interrupted: true` — it NEVER fabricates a `run.completed` for
   * an unfinished run, so interrupted runs stay `partial` (spec §5). In-flight
   * concurrent runs are abandoned, not awaited; their recordings are valid
   * prefixes (spec §11) and reappear as `partial` on the next boot (P2-R.1).
   */
  signal?: AbortSignal;
}

export interface RunContext {
  run_id: string;
  scenario_id: RunnableScenarioId;
  bus: EventBus;
  clock: Clock;
}

export interface RunSuiteResult {
  runIds: string[];
  reportPath?: string;
  report?: Report;
  /** True when the suite was aborted (P2-R.2) before every run finished. */
  interrupted: boolean;
}

interface ScenarioEvidence {
  transitions: StatusTransition[];
  identityReview?: IdentityReviewSummary;
  refusal?: ApiRefusal;
  diagnostics: string[];
}

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export async function runScenarios(options: RunOptions): Promise<RunSuiteResult> {
  const clock = options.clock ?? new RealClock();
  const recordingDir = options.recordingDir ?? "runs";
  const scheduler = new RateFloorScheduler(clock, 250);
  const runIds: string[] = [];
  const collectedEvents: RunEvent[] = [];
  const unsubscribe = options.bus.subscribe((event) => {
    collectedEvents.push(event);
  });
  const tasks = options.scenarios.map((id) => {
    const scenario = requireScenario(id, options.mode);
    const runId = makeRunId(scenario.id, clock);
    runIds.push(runId);
    return () =>
      runOneScenario({
        scenario,
        run_id: runId,
        bus: options.bus,
        clock,
        recordingDir,
        scheduler,
        pollPolicy: options.pollPolicy,
        clientFactory: options.clientFactory,
      });
  });
  options.onRunIds?.([...runIds]);

  let report: Report | undefined;
  let interrupted = false;
  try {
    if (options.concurrency === "serial") {
      for (const task of tasks) {
        if (options.signal?.aborted === true) {
          interrupted = true;
          break;
        }
        await task();
      }
    } else if (options.signal !== undefined) {
      interrupted = await raceUntilAbortOrDone(
        Promise.all(tasks.map((task) => task())),
        options.signal,
      );
    } else {
      await Promise.all(tasks.map((task) => task()));
    }

    // On interruption we still write a report — a snapshot of the partial
    // evidence, in which unfinished runs are `partial` (buildReport keys off
    // the absence of run.completed). We never manufacture a completion.
    if (options.reportPath !== undefined) {
      report = buildReport(collectedEvents, {
        recordingDir,
        generatedAt: new Date(clock.now()).toISOString(),
      });
      await writeFile(
        options.reportPath,
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8",
      );
    }
  } finally {
    unsubscribe();
  }

  return {
    runIds,
    reportPath: options.reportPath,
    interrupted,
    ...(report !== undefined ? { report } : {}),
  };
}

/**
 * Resolve `true` if `signal` aborts before `work` settles, else `false`.
 * `work` (the concurrent scenario batch) never rejects — runOneScenario
 * captures its own errors — but we defensively swallow so an abandoned,
 * still-pending batch cannot surface an unhandled rejection after we've
 * already resolved on abort.
 */
function raceUntilAbortOrDone(
  work: Promise<unknown>,
  signal: AbortSignal,
): Promise<boolean> {
  work.catch(() => undefined);
  if (signal.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => resolve(true);
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    });
  });
}

async function runOneScenario(args: {
  scenario: RunnableScenarioDef;
  run_id: string;
  bus: EventBus;
  clock: Clock;
  recordingDir: string;
  scheduler: RateFloorScheduler;
  pollPolicy?: Partial<PollPolicy>;
  clientFactory?: (context: RunContext) => StraddleClient;
}): Promise<void> {
  const startedAt = args.clock.now();
  const evidence: ScenarioEvidence = { transitions: [], diagnostics: [] };
  const context: RunContext = {
    run_id: args.run_id,
    scenario_id: args.scenario.id,
    bus: args.bus,
    clock: args.clock,
  };
  const client =
    args.clientFactory?.(context) ??
    createMockStraddleClient({
      bus: args.bus,
      clock: args.clock,
      context: { run_id: args.run_id, scenario_id: args.scenario.id },
    });

  args.bus.emit({
    type: "run.started",
    run_id: args.run_id,
    scenario_id: args.scenario.id,
    scenario: args.scenario,
  });

  try {
    const customer = await client.createCustomer(customerInput(args.scenario, args.run_id));
    const review = await client.getCustomerReview(customer.id);
    evidence.identityReview = review.summary;
    args.bus.emit({
      type: "customer.review_changed",
      run_id: args.run_id,
      scenario_id: args.scenario.id,
      customer_id: customer.id,
      status: review.status,
      review: review.summary,
    });

    if (args.scenario.id === "e") {
      await captureExpectedRefusal(client, customer, args.run_id, evidence);
      completeRun(args, evidence, startedAt);
      return;
    }

    const paykey = await client.createPaykey(paykeyInput(customer, args.scenario, args.run_id));
    const charge = await client.createCharge(
      chargeInput(paykey, args.scenario, args.run_id, args.clock),
    );
    observeCharge(args, evidence, charge);
    await pollCharge(args, evidence, client, charge);
  } catch (error) {
    if (error instanceof Error) {
      evidence.diagnostics.push(error.message);
    } else {
      evidence.diagnostics.push(String(error));
    }
  }

  completeRun(args, evidence, startedAt);
}

async function captureExpectedRefusal(
  client: StraddleClient,
  customer: CustomerResult,
  runId: string,
  evidence: ScenarioEvidence,
): Promise<void> {
  try {
    await client.createPaykey({
      customer_id: customer.id,
      routing_number: SEEDED_BANK.routing_number,
      account_number: SEEDED_BANK.preferred_account_number,
      account_type: "checking",
      config: { sandbox_outcome: "active" },
      external_id: runId,
      // UUID, not a run-id-derived string: the sandbox rejects Idempotency-Key
      // values over ~40 chars with a 400 that would mask the expected 422.
      idempotencyKey: randomUUID(),
    });
    evidence.diagnostics.push("expected create_paykey refusal, but the call succeeded");
  } catch (error) {
    if (isStraddleApiError(error) || hasMockApiErrorShape(error)) {
      evidence.refusal = {
        attempted_action: "create_paykey",
        http_status: error.status,
        error_body: error.errorBody,
      };
      return;
    }
    throw error;
  }
}

async function pollCharge(
  args: {
    scenario: RunnableScenarioDef;
    run_id: string;
    bus: EventBus;
    clock: Clock;
    scheduler: RateFloorScheduler;
    pollPolicy?: Partial<PollPolicy>;
  },
  evidence: ScenarioEvidence,
  client: StraddleClient,
  initial: ChargeResult,
): Promise<void> {
  // Poll-level retry counter (P2-R.3): the failed fetch is attempt 1, so the
  // retry.scheduled events start at 2 (RetryScheduledEventSchema requires >=2).
  let pollAttempt = 1;
  try {
    await poll({
      clock: args.clock,
      scheduler: args.scheduler,
      policy: args.pollPolicy,
      fetch: () => client.getCharge(initial.id),
      onObservation: (charge) => observeCharge(args, evidence, charge),
      statusOf: (charge) => charge.status,
      switchToFast: (charge) =>
        args.scenario.id === "c" && charge.status_history.some((h) => h.status === "pending"),
      isSettled: (charge) => isChargeSettled(args.scenario, charge, evidence.transitions),
      onFetchError: (error, context) => {
        // Only a RETRYABLE-exhausted Straddle error (429/5xx the client already
        // retried) is a transient blip we poll through; anything else (404,
        // other 4xx, non-API error) ends the poll and is recorded below.
        const apiError =
          isStraddleApiError(error) || hasMockApiErrorShape(error) ? error : undefined;
        if (apiError?.retryable !== true) return "fail";
        pollAttempt += 1;
        // A transient blip we poll THROUGH is not a failure, so it does NOT go
        // in evidence.diagnostics (the evaluator treats any diagnostic as a
        // failure). It stays visible as a retry.scheduled event in the wire log.
        // Only if the blip never clears does the eventual hard timeout add a
        // failure diagnostic below.
        args.bus.emit({
          type: "retry.scheduled",
          run_id: args.run_id,
          scenario_id: args.scenario.id,
          path: apiError.path,
          status: apiError.status,
          error_class: error instanceof Error ? error.name : "unknown",
          attempt: pollAttempt,
          delay_ms: context.nextDelayMs,
        });
        return "retry";
      },
    });
  } catch (error) {
    if (error instanceof Error) {
      evidence.diagnostics.push(error.message);
    } else {
      evidence.diagnostics.push(String(error));
    }
  }
}

function observeCharge(
  args: { bus: EventBus; run_id: string; scenario: RunnableScenarioDef },
  evidence: ScenarioEvidence,
  charge: ChargeResult,
): void {
  let previous = evidence.transitions.at(-1)?.to ?? null;
  for (const entry of charge.status_history) {
    if (
      evidence.transitions.some(
        (transition) => transition.to === entry.status && transition.at === entry.changed_at,
      )
    ) {
      continue;
    }
    if (previous === entry.status) continue;
    const transition: StatusTransition = {
      from: previous,
      to: entry.status,
      at: entry.changed_at,
      ...(entry.code !== undefined ? { return_code: entry.code } : {}),
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    };
    evidence.transitions.push(transition);
    args.bus.emit({
      type: "payment.status_changed",
      run_id: args.run_id,
      scenario_id: args.scenario.id,
      resource_id: charge.id,
      from: transition.from,
      to: transition.to,
      ...(transition.return_code !== undefined
        ? { return_code: transition.return_code }
        : {}),
      ...(transition.reason !== undefined ? { reason: transition.reason } : {}),
      ...(entry.source !== undefined ? { source: entry.source } : {}),
      changed_at: transition.at,
      detail: entry,
    });
    previous = entry.status;
  }
}

function completeRun(
  args: {
    scenario: RunnableScenarioDef;
    run_id: string;
    bus: EventBus;
    clock: Clock;
    recordingDir: string;
  },
  evidence: ScenarioEvidence,
  startedAt: number,
): void {
  const result = evaluateScenario(args.scenario, evidence);
  emitAssertions({ bus: args.bus, run_id: args.run_id, scenario: args.scenario, result });
  args.bus.emit({
    type: "run.completed",
    run_id: args.run_id,
    scenario_id: args.scenario.id,
    result: result.passed ? "passed" : "failed",
    duration_ms: Math.max(0, args.clock.now() - startedAt),
    recording_path: recordingPathFor(args.recordingDir, args.run_id),
    ...(evidence.diagnostics.length > 0
      ? { diagnostics: [...evidence.diagnostics] }
      : {}),
  });
}

const TERMINAL_CHARGE_STATUSES = new Set(["paid", "failed", "reversed", "cancelled"]);

function isChargeSettled(
  scenario: RunnableScenarioDef,
  charge: ChargeResult,
  transitions: StatusTransition[],
): boolean {
  if (scenario.id === "c") {
    // paid is provisional for C — keep watching for the reversal.
    return (
      transitions.some((t) => t.to === "reversed") ||
      TERMINAL_CHARGE_STATUSES.has(charge.status) && charge.status !== "paid"
    );
  }
  // ANY terminal settles the poll — reaching the wrong terminal is an
  // evaluator failure, not a reason to poll until the hard timeout.
  return TERMINAL_CHARGE_STATUSES.has(charge.status);
}

function customerInput(scenario: RunnableScenarioDef, runId: string) {
  const profile = fakeCustomerProfile(scenario.id, runId);
  return {
    name: profile.name,
    type: "individual" as const,
    email: profile.email,
    phone: profile.phone,
    device: { ip_address: "0.0.0.0" },
    config: { sandbox_outcome: scenario.outcomes.customer },
    external_id: runId,
    metadata: { scenario_id: scenario.id },
    idempotencyKey: randomUUID(),
  };
}

function fakeCustomerProfile(
  scenarioId: RunnableScenarioId,
  runId: string,
): { name: string; email: string; phone: string } {
  const faker = new Faker({
    locale: [en_US, en, base],
    seed: seedFromRun(scenarioId, runId),
  });
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  return {
    name: `${firstName} ${lastName}`,
    email: faker.internet.email({
      firstName,
      lastName,
      provider: "example.com",
    }),
    phone: faker.phone.number({ style: "international" }),
  };
}

function seedFromRun(scenarioId: RunnableScenarioId, runId: string): number {
  return createHash("sha256")
    .update(`${scenarioId}:${runId}`)
    .digest()
    .readUInt32BE(0);
}

function paykeyInput(
  customer: CustomerResult,
  scenario: RunnableScenarioDef,
  runId: string,
) {
  return {
    customer_id: customer.id,
    routing_number: SEEDED_BANK.routing_number,
    account_number: SEEDED_BANK.preferred_account_number,
    account_type: "checking" as const,
    config: { sandbox_outcome: scenario.outcomes.paykey ?? "active" },
    external_id: runId,
    metadata: { scenario_id: scenario.id },
    idempotencyKey: randomUUID(),
  };
}

function chargeInput(
  paykey: PaykeyResult,
  scenario: RunnableScenarioDef,
  runId: string,
  clock: Clock,
) {
  return {
    paykey: paykey.paykey,
    amount: 10_000,
    currency: "USD" as const,
    description: `Scenario ${scenario.id.toUpperCase()} sandbox charge`,
    consent_type: "internet" as const,
    device: { ip_address: "0.0.0.0" },
    external_id: runId,
    payment_date: new Date(clock.now()).toISOString().slice(0, 10),
    config: {
      balance_check: "disabled" as const,
      ...(scenario.outcomes.charge !== undefined
        ? { sandbox_outcome: scenario.outcomes.charge }
        : {}),
    },
    metadata: { scenario_id: scenario.id },
    idempotencyKey: randomUUID(),
  };
}

function makeRunId(scenarioId: RunnableScenarioId, clock: Clock): string {
  const stamp = new Date(clock.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `run-${stamp}-${scenarioId}-${randomBytes(2).toString("hex")}`;
}

function hasMockApiErrorShape(
  error: unknown,
): error is { status: number; errorBody: unknown; path: string; retryable: boolean } {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    "errorBody" in error &&
    "retryable" in error
  );
}
