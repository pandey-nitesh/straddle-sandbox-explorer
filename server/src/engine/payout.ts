/**
 * Payout lane (P2-4 / api-notes §P13) — a mock-first CLI/teaching lane.
 *
 * Payouts are money OUT and deliberately live OUTSIDE the a–i scenario space and
 * the required A–E acceptance suite: they are a separate lane invoked only via
 * the CLI `--payout` flow, never part of Run All. Yet a payout run emits the
 * SAME RunEvents as a scenario run (run.started, api.exchange,
 * customer.review_changed, payment.status_changed, run.completed) so it flows
 * through the identical bus → recorder → registry → report machinery.
 *
 * scenario_id borrow (why this needs NO shared/ change):
 *   RunEvent.scenario_id and ScenarioDef.id are floored to a–i by the shared
 *   ScenarioIdSchema, and every letter is already a real scenario, so there is
 *   no free literal. A payout run therefore BORROWS scenario_id "a" purely as
 *   the event-envelope slot. This does not pollute the acceptance suite because:
 *     - it runs only via `--payout` (never `--all` / `--scenario`), on its own
 *       bus + registry, so it is never mixed into an A–E process here;
 *     - its report is inherently `partial` (A–E are not all covered) and its
 *       single scenario entry's `name` is "Payout …", so the borrowed `id` is
 *       unmistakable to any reader;
 *     - ScenarioIdSchema and the REQUIRED_SCENARIO_IDS gate are untouched.
 *   A future dedicated `"payout"` ScenarioId literal would remove the borrow,
 *   but that is one §14-synchronized shared change and is out of scope here.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { ScenarioDefSchema } from "@sse/shared";
import type { Report, RunEvent } from "@sse/shared";
import type { EventBus } from "./bus.js";
import { buildReport } from "./report.js";
import { RateFloorScheduler } from "./poller.js";
import type { PollPolicy } from "./poller.js";
import {
  RealClock,
  completeRun,
  customerInput,
  makeRunId,
  observeCharge,
  paykeyInput,
  pollCharge,
} from "./runner.js";
import type { RunContext, RunSuiteResult, ScenarioEvidence } from "./runner.js";
import type { RunnableScenarioDef } from "./scenarios.js";
import { createMockStraddleClient } from "../straddle/mock.js";
import type {
  Clock,
  PaykeyResult,
  PayoutInput,
  StraddleClient,
} from "../straddle/types.js";

/** The scenario_id a payout run borrows for its RunEvent envelopes (see file doc). */
export const PAYOUT_ENVELOPE_SCENARIO_ID = "a" as const;

/**
 * The payout run's ScenarioDef snapshot (carried on run.started, surfaced as the
 * report scenario's `name`). Its `label` makes the payout unmistakable despite
 * the borrowed `id`; its single required observation is the terminal `paid`.
 */
export const PAYOUT_SCENARIO = ScenarioDefSchema.parse({
  id: PAYOUT_ENVELOPE_SCENARIO_ID,
  label: "Payout (mock-first CLI lane)",
  purpose:
    "Create a payout to an active paykey and observe it settle as paid (spec P2-4 / api-notes §P13; live lifecycle timing UNMEASURED).",
  flow: [
    "Create a verified sandbox customer.",
    "Create an active bank-account paykey for that customer.",
    "Create a payout to that paykey and poll it until it settles as paid.",
  ],
  outcomes: { customer: "verified", paykey: "active" },
  requiredObservations: [{ kind: "terminal_status", status: "paid" }],
}) as RunnableScenarioDef;

/** Payout `config.sandbox_outcome`s this lane forces (both settle `paid`). */
export type PayoutSandboxOutcome = "paid" | "standard";

export interface PayoutRunOptions {
  bus: EventBus;
  clock?: Clock;
  recordingDir?: string;
  reportPath?: string;
  pollPolicy?: Partial<PollPolicy>;
  clientFactory?: (context: RunContext) => StraddleClient;
  /** Forced payout `sandbox_outcome` (default "paid"). */
  sandboxOutcome?: PayoutSandboxOutcome;
  /** Called synchronously after the run id is allocated, before work awaits. */
  onRunIds?: (runIds: string[]) => void;
  /**
   * Interrupt-safe shutdown (mirrors runScenarios). If already aborted the run
   * never starts and the result is `interrupted: true`; a partial report is
   * still written from whatever evidence exists (a bare run — none here). We
   * never fabricate a `run.completed`.
   */
  signal?: AbortSignal;
}

/**
 * Runs a single payout (customer → paykey → payout → poll) and writes a
 * standalone report + recording through the shared machinery. Returns the same
 * RunSuiteResult shape as `runScenarios`, so the CLI treats both uniformly.
 */
export async function runPayoutSuite(
  options: PayoutRunOptions,
): Promise<RunSuiteResult> {
  const clock = options.clock ?? new RealClock();
  const recordingDir = options.recordingDir ?? "runs";
  const scheduler = new RateFloorScheduler(clock, 250);
  const collectedEvents: RunEvent[] = [];
  const unsubscribe = options.bus.subscribe((event) => {
    collectedEvents.push(event);
  });
  const runId = makeRunId(PAYOUT_SCENARIO.id, clock);
  options.onRunIds?.([runId]);

  let report: Report | undefined;
  let interrupted = false;
  try {
    if (options.signal?.aborted === true) {
      interrupted = true;
    } else {
      await runOnePayout({
        run_id: runId,
        bus: options.bus,
        clock,
        recordingDir,
        scheduler,
        pollPolicy: options.pollPolicy,
        clientFactory: options.clientFactory,
        sandboxOutcome: options.sandboxOutcome ?? "paid",
      });
    }
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
    runIds: [runId],
    reportPath: options.reportPath,
    interrupted,
    ...(report !== undefined ? { report } : {}),
  };
}

async function runOnePayout(args: {
  run_id: string;
  bus: EventBus;
  clock: Clock;
  recordingDir: string;
  scheduler: RateFloorScheduler;
  pollPolicy?: Partial<PollPolicy>;
  clientFactory?: (context: RunContext) => StraddleClient;
  sandboxOutcome: PayoutSandboxOutcome;
}): Promise<void> {
  const scenario = PAYOUT_SCENARIO;
  const startedAt = args.clock.now();
  const evidence: ScenarioEvidence = { transitions: [], diagnostics: [] };
  const context: RunContext = {
    run_id: args.run_id,
    scenario_id: scenario.id,
    bus: args.bus,
    clock: args.clock,
  };
  const client =
    args.clientFactory?.(context) ??
    createMockStraddleClient({
      bus: args.bus,
      clock: args.clock,
      context: { run_id: args.run_id, scenario_id: scenario.id },
    });

  args.bus.emit({
    type: "run.started",
    run_id: args.run_id,
    scenario_id: scenario.id,
    scenario,
  });

  try {
    const customer = await client.createCustomer(
      customerInput(scenario, args.run_id),
    );
    const review = await client.getCustomerReview(customer.id);
    evidence.identityReview = review.summary;
    args.bus.emit({
      type: "customer.review_changed",
      run_id: args.run_id,
      scenario_id: scenario.id,
      customer_id: customer.id,
      status: review.status,
      review: review.summary,
    });

    const paykey = await client.createPaykey(
      paykeyInput(customer, scenario, args.run_id),
    );
    const payout = await client.createPayout(
      payoutInput(paykey, scenario, args.run_id, args.clock, args.sandboxOutcome),
    );
    // A PayoutResult is structurally a ChargeResult for observe/poll purposes
    // (same id/status/status_history), so the transition machinery is reused.
    observeCharge(
      { bus: args.bus, run_id: args.run_id, scenario },
      evidence,
      payout,
    );
    await pollCharge(
      {
        scenario,
        run_id: args.run_id,
        bus: args.bus,
        clock: args.clock,
        scheduler: args.scheduler,
        pollPolicy: args.pollPolicy,
      },
      evidence,
      client,
      payout,
      { fetch: () => client.getPayout(payout.id) },
    );
  } catch (error) {
    evidence.diagnostics.push(
      error instanceof Error ? error.message : String(error),
    );
  }

  completeRun(
    {
      scenario,
      run_id: args.run_id,
      bus: args.bus,
      clock: args.clock,
      recordingDir: args.recordingDir,
    },
    evidence,
    startedAt,
  );
}

function payoutInput(
  paykey: PaykeyResult,
  scenario: RunnableScenarioDef,
  runId: string,
  clock: Clock,
  sandboxOutcome: PayoutSandboxOutcome,
): PayoutInput {
  return {
    paykey: paykey.paykey, // the TOKEN, not paykey.id
    amount: 10_000,
    currency: "USD",
    description: `${scenario.label} sandbox payout`,
    device: { ip_address: "0.0.0.0" },
    external_id: runId,
    payment_date: new Date(clock.now()).toISOString().slice(0, 10),
    // No balance_check, no consent_type — payout body (api-notes §P13).
    config: { sandbox_outcome: sandboxOutcome },
    metadata: { scenario_id: scenario.id, lane: "payout" },
    // UUID (36 chars) — under the ~40-char Idempotency-Key cap (api-notes §12).
    idempotencyKey: randomUUID(),
  };
}
