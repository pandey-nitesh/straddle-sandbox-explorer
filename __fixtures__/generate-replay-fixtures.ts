/**
 * Replay-fixture generator for the P2-2 scenarios F/G/H/I (spec §11 / §19-C).
 *
 * Each fixture is a mock-generated JSONL recording — the SAME event stream a
 * live run would record, produced by driving the real runner against the
 * scripted mock client on a FakeClock. Because every body passes through the
 * server-side redactor before it is emitted (mock.ts), these files are
 * canary-clean by construction: account/routing numbers are masked to last-4,
 * paykey tokens are masked, and no key material can appear. They are committed
 * static artifacts; the browser replay viewer feeds them through the exact same
 * reducer as live events (spec §11), and __fixtures__/replay-fixtures.test.ts
 * asserts they stay valid.
 *
 * The run_id (and every id/path that embeds it) is remapped to a stable
 * `run-fixture-<id>` so the committed filenames and contents don't churn on the
 * random run-id suffix. Synthetic customer names and the masked account last-4
 * still vary if regenerated — that is expected; the committed file is the
 * artifact, this script only reproduces its shape.
 *
 * Regenerate: `npx tsx __fixtures__/generate-replay-fixtures.ts`
 *
 * G uses CONTRACT mode on purpose: replay demonstrates the intended
 * paid → reversed contract, mirroring the §18.1 pattern (live asserts the
 * documented deviation instead — see server/src/engine/live-mode.test.ts).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEvent, ScenarioId } from "@sse/shared";
import { createBus } from "../server/src/engine/bus.js";
import { runScenarios } from "../server/src/engine/runner.js";
import { createMockStraddleClient } from "../server/src/straddle/mock.js";
import { FakeClock } from "../server/src/straddle/fake-clock.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** One replay fixture per NEW P2-2 scenario. */
export const FIXTURE_SCENARIOS: readonly ScenarioId[] = ["f", "g", "h", "i"];

const POLL_POLICY = {
  baseMinMs: 5_000,
  baseMaxMs: 5_000,
  fastMs: 5_000,
  hardTimeoutMs: 600_000,
};

export function fixturePath(id: ScenarioId): string {
  return path.join(HERE, `run-fixture-${id}.jsonl`);
}

async function generateOne(id: ScenarioId): Promise<void> {
  const clock = new FakeClock(Date.parse("2026-07-08T12:00:00.000Z"));
  const bus = createBus({ now: () => new Date(clock.now()) });
  const events: RunEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const task = runScenarios({
    scenarios: [id],
    concurrency: "concurrent",
    bus,
    clock,
    recordingDir: "runs",
    mode: "contract",
    pollPolicy: POLL_POLICY,
    clientFactory: (context) =>
      createMockStraddleClient({
        bus,
        clock,
        context: { run_id: context.run_id, scenario_id: context.scenario_id },
      }),
  });

  await waitForSleepers(clock);
  await clock.advance(600_000);
  await task;

  const started = events.find((event) => event.type === "run.started");
  if (started === undefined) throw new Error(`no run.started emitted for ${id}`);
  const actualRunId = started.run_id;
  const stableRunId = `run-fixture-${id}`;

  const jsonl = `${events
    .map((event) => JSON.stringify(event).split(actualRunId).join(stableRunId))
    .join("\n")}\n`;

  const outPath = fixturePath(id);
  writeFileSync(outPath, jsonl, "utf8");
  console.log(`wrote ${path.relative(HERE, outPath)} (${events.length} events)`);
}

async function waitForSleepers(clock: FakeClock): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (clock.pendingSleepers() > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("runner did not reach polling sleeps");
}

async function main(): Promise<void> {
  for (const id of FIXTURE_SCENARIOS) {
    await generateOne(id);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
