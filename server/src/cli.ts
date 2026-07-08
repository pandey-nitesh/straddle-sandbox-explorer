import { createBus } from "./engine/bus.js";
import { createRecorder } from "./engine/recorder.js";
import { runScenarios } from "./engine/runner.js";
import type { RunContext } from "./engine/runner.js";
import { runPayoutSuite } from "./engine/payout.js";
import { parseScenarioSelection } from "./engine/scenarios.js";
import { loadConfig } from "./config.js";
import { createStraddleClient } from "./straddle/client.js";
import { createMockStraddleClient } from "./straddle/mock.js";
import type { StraddleClient } from "./straddle/types.js";

interface CliArgs {
  all: boolean;
  scenarios: string[];
  serial: boolean;
  mock: boolean;
  payout: boolean;
  reportPath: string;
  recordingDir: string;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const config = loadConfig();
  const bus = createBus();
  const recorder = createRecorder(bus, args.recordingDir);
  const scenarioIds = parseScenarioSelection({
    all: args.all,
    scenarios: args.scenarios,
  });

  if (!args.mock && !config.keyPresent) {
    throw new CliError(
      2,
      "STRADDLE_API_KEY is missing. Set it in the environment/.env or pass --mock.",
    );
  }
  if (!args.mock) {
    // Preflight on a detached bus so the probe never reaches the recorder.
    const probe = createStraddleClient({
      apiKey: config.straddleApiKey ?? "",
      bus: createBus(),
      context: { run_id: "preflight", scenario_id: "a" },
    });
    const health = await probe.health();
    if (!health.ok) {
      throw new CliError(
        2,
        health.status === 401
          ? "Straddle rejected this key (401 · no response body). Regenerate it at dashboard.straddle.com → API keys."
          : `Straddle sandbox unreachable (${health.message ?? health.status}).`,
      );
    }
  }

  // Interrupt-safe shutdown (P2-R.2): Ctrl-C / SIGTERM aborts the suite; the
  // runner snapshots a partial report and we exit non-zero. Handlers are
  // removed once the suite settles so repeated CLI invocations don't leak them.
  const abort = new AbortController();
  let signalName: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    signalName = signal;
    abort.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const clientFactory = (context: RunContext): StraddleClient =>
    args.mock
      ? createMockStraddleClient({
          bus,
          clock: context.clock,
          context: {
            run_id: context.run_id,
            scenario_id: context.scenario_id,
          },
        })
      : createStraddleClient({
          apiKey: config.straddleApiKey ?? "",
          bus,
          clock: context.clock,
          context: {
            run_id: context.run_id,
            scenario_id: context.scenario_id,
          },
        });

  let result;
  try {
    result = args.payout
      ? await runPayoutSuite({
          bus,
          recordingDir: args.recordingDir,
          reportPath: args.reportPath,
          pollPolicy: config.pollPolicyOverrides,
          signal: abort.signal,
          clientFactory,
        })
      : await runScenarios({
          scenarios: scenarioIds,
          concurrency: args.serial ? "serial" : "concurrent",
          bus,
          recordingDir: args.recordingDir,
          reportPath: args.reportPath,
          pollPolicy: config.pollPolicyOverrides,
          mode: args.mock ? "contract" : "live",
          signal: abort.signal,
          clientFactory,
        });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  if (result.interrupted) {
    // The report snapshot and recordings (valid prefixes) are already durable;
    // flush is the explicit shutdown seam. Force-exit so abandoned in-flight
    // pollers don't keep the event loop alive until the hard timeout.
    await recorder.flush();
    console.error(
      `interrupted${signalName === undefined ? "" : ` (${signalName})`} — wrote partial ${args.reportPath}; unfinished runs left as partial evidence`,
    );
    process.exit(130);
  }

  // Keep stdout human-safe and terse; detailed evidence lives in report/runs.
  const report = result.report;
  if (report !== undefined) {
    const passed = report.scenarios.filter((s) => s.status === "passed").length;
    console.log(
      `suite: ${report.suite.status} · ${passed}/${report.scenarios.length} passed · wrote ${args.reportPath}`,
    );
    if (report.scenarios.some((s) => s.status !== "passed")) {
      process.exitCode = 1;
    }
  } else {
    console.log(`wrote ${args.reportPath}`);
  }
}

class CliError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {
    all: false,
    scenarios: [],
    serial: false,
    mock: false,
    payout: false,
    reportPath: "report.json",
    recordingDir: "runs",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--all":
        out.all = true;
        break;
      case "--scenario": {
        const value = argv[++i];
        if (value === undefined) throw new Error("--scenario requires a value");
        out.scenarios.push(value);
        break;
      }
      case "--serial":
        out.serial = true;
        break;
      case "--mock":
        out.mock = true;
        break;
      case "--payout":
        out.payout = true;
        break;
      case "--report": {
        const value = argv[++i];
        if (value === undefined) throw new Error("--report requires a value");
        out.reportPath = value;
        break;
      }
      case "--recording-dir": {
        const value = argv[++i];
        if (value === undefined) throw new Error("--recording-dir requires a value");
        out.recordingDir = value;
        break;
      }
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`Usage: npm run scenarios -- [--all | --scenario a | --payout] [--mock] [--serial]

Options:
  --all                  Run A-E (default when no --scenario is passed)
  --scenario <id>        Run one scenario; repeatable
  --payout               Run the payout lane (create -> observe -> report) instead
                         of the A-E scenarios; mock-first (spec P2-4 / api-notes §P13)
  --mock                 Use the scripted mock client instead of the live sandbox
  --serial               Run scenarios serially (P1 behavior, useful for debugging)
  --report <path>        Report output path (default: report.json)
  --recording-dir <dir>  JSONL recording directory (default: runs)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  });
}
