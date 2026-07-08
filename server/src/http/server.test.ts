import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReportSchema, type RunEvent } from "@sse/shared";
import { loadConfig } from "../config.js";
import { createBus } from "../engine/bus.js";
import { buildReport } from "../engine/report.js";
import { createRunRegistry } from "../engine/registry.js";
import { FakeClock } from "../straddle/fake-clock.js";
import { createHttpServer } from "./server.js";

describe("HTTP server", () => {
  it("reports missing key without touching the sandbox", async () => {
    const app = await createHttpServer({
      config: loadConfig({ env: {}, envFilePath: false }),
      epoch: "test-epoch",
      attachRecorder: false,
      rehydrate: false,
      serveStatic: false,
      logger: false,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      epoch: "test-epoch",
      key: "missing",
    });
    await app.close();
  });

  it("runs a mock scenario through /api/runs and exposes events, snapshot, and report", async () => {
    const clock = new FakeClock(Date.parse("2026-07-07T12:00:00.000Z"));
    const dir = mkdtempSync(path.join(tmpdir(), "straddle-http-"));
    const app = await createHttpServer({
      config: loadConfig({ env: {}, envFilePath: false }),
      epoch: "test-epoch",
      mockMode: true,
      clock,
      recordingDir: path.join(dir, "runs"),
      serveStatic: false,
      logger: false,
    });

    const started = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { scenarios: ["e"] },
    });
    expect(started.statusCode).toBe(202);
    const runIds = started.json<{ run_ids: string[] }>().run_ids;
    expect(runIds).toHaveLength(1);

    await flushAsyncWork();

    const eventsResponse = await app.inject({
      method: "GET",
      url: "/api/events?since=0",
    });
    expect(eventsResponse.statusCode).toBe(200);
    const eventPayload = eventsResponse.json<{
      epoch: string;
      events: RunEvent[];
    }>();
    expect(eventPayload.epoch).toBe("test-epoch");
    expect(eventPayload.events.some((e) => e.type === "run.completed")).toBe(true);

    const runs = await app.inject({ method: "GET", url: "/api/runs" });
    expect(runs.statusCode).toBe(200);
    expect(runs.json().runs).toHaveLength(1);
    expect(runs.json().runs[0]).toMatchObject({
      run_id: runIds[0],
      scenario_id: "e",
      status: "passed",
      latest_for_scenario: true,
    });

    const reportResponse = await app.inject({
      method: "GET",
      url: "/api/report",
    });
    expect(reportResponse.statusCode).toBe(200);
    const report = ReportSchema.parse(reportResponse.json());
    expect(report.suite.status).toBe("partial");
    expect(report.scenarios).toHaveLength(1);
    expect(report.scenarios[0]).toMatchObject({
      id: "e",
      status: "passed",
      refusal: { attempted_action: "create_paykey", http_status: 422 },
    });

    await app.close();
  });

  it("marks the newest re-run as latest for a scenario", async () => {
    const clock = new FakeClock(Date.parse("2026-07-07T12:00:00.000Z"));
    const app = await createHttpServer({
      config: loadConfig({ env: {}, envFilePath: false }),
      epoch: "test-epoch",
      mockMode: true,
      clock,
      recordingDir: mkdtempSync(path.join(tmpdir(), "straddle-http-rerun-")),
      serveStatic: false,
      logger: false,
    });

    await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { scenarios: ["e"] },
    });
    await flushAsyncWork();
    const second = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { scenarios: ["e"] },
    });
    const secondRunId = second.json<{ run_ids: string[] }>().run_ids[0];
    await flushAsyncWork();

    const runs = (await app.inject({ method: "GET", url: "/api/runs" })).json();
    const latest = runs.runs.filter(
      (run: { latest_for_scenario: boolean }) => run.latest_for_scenario,
    );
    expect(runs.runs).toHaveLength(2);
    expect(latest).toHaveLength(1);
    expect(latest[0].run_id).toBe(secondRunId);

    await app.close();
  });

  it("keeps /api/report schema-identical to the report builder path", async () => {
    const clock = new FakeClock(Date.parse("2026-07-07T12:00:00.000Z"));
    const bus = createBus({ now: () => new Date(clock.now()) });
    const registry = createRunRegistry(bus);
    const recordingDir = mkdtempSync(path.join(tmpdir(), "straddle-http-roundtrip-"));
    const app = await createHttpServer({
      config: loadConfig({ env: {}, envFilePath: false }),
      epoch: "test-epoch",
      bus,
      registry,
      mockMode: true,
      clock,
      recordingDir,
      serveStatic: false,
      logger: false,
    });

    await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { scenarios: ["e"] },
    });
    await flushAsyncWork();

    const httpReport = ReportSchema.parse(
      (await app.inject({ method: "GET", url: "/api/report" })).json(),
    );
    const builderReport = buildReport(registry.allEvents(), {
      recordingDir,
      generatedAt: httpReport.generated_at,
    });
    expect(httpReport).toEqual(builderReport);

    await app.close();
  });

  it("lists and serves JSONL recordings, including partial markers", async () => {
    const recordingDir = mkdtempSync(path.join(tmpdir(), "straddle-http-recordings-"));
    const completeRunId = "run-20260707T120000Z-c-0001";
    const partialRunId = "run-20260707T120000Z-c-0002";
    writeFileSync(
      path.join(recordingDir, `${completeRunId}.jsonl`),
      [
        JSON.stringify({
          seq: 1,
          timestamp: "2026-07-07T12:00:00.000Z",
          type: "run.started",
          run_id: completeRunId,
          scenario_id: "c",
          scenario: {
            id: "c",
            label: "C. Reversal",
            purpose: "Mock/replay reversal evidence: paid before reversed.",
            outcomes: { customer: "verified", paykey: "active", charge: "reversed_insufficient_funds" },
            requiredObservations: [{ kind: "ordered_statuses", statuses: ["paid", "reversed"] }],
          },
        }),
        JSON.stringify({
          seq: 2,
          timestamp: "2026-07-07T12:00:01.000Z",
          type: "run.completed",
          run_id: completeRunId,
          scenario_id: "c",
          result: "passed",
          duration_ms: 1_000,
          recording_path: path.join(recordingDir, `${completeRunId}.jsonl`),
        }),
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(recordingDir, `${partialRunId}.jsonl`),
      JSON.stringify({
        seq: 3,
        timestamp: "2026-07-07T12:00:00.000Z",
        type: "run.started",
        run_id: partialRunId,
        scenario_id: "c",
        scenario: {
          id: "c",
          label: "C. Reversal",
          purpose: "Mock/replay reversal evidence: paid before reversed.",
          outcomes: { customer: "verified", paykey: "active", charge: "reversed_insufficient_funds" },
          requiredObservations: [{ kind: "ordered_statuses", statuses: ["paid", "reversed"] }],
        },
      }) + "\n",
    );
    const app = await createHttpServer({
      config: loadConfig({ env: {}, envFilePath: false }),
      epoch: "test-epoch",
      mockMode: true,
      attachRecorder: false,
      recordingDir,
      serveStatic: false,
      logger: false,
    });

    const list = await app.inject({ method: "GET", url: "/api/recordings" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([
      {
        run_id: completeRunId,
        path: path.join(recordingDir, `${completeRunId}.jsonl`),
        complete: true,
      },
      {
        run_id: partialRunId,
        path: path.join(recordingDir, `${partialRunId}.jsonl`),
        complete: false,
      },
    ]);

    const item = await app.inject({
      method: "GET",
      url: `/api/recordings/${completeRunId}`,
    });
    expect(item.statusCode).toBe(200);
    expect(item.body).toContain('"type":"run.completed"');

    await app.close();
  });

  it("rehydrates the registry from recordings and continues seq above history", async () => {
    const recordingDir = mkdtempSync(path.join(tmpdir(), "straddle-http-rehydrate-"));
    const completeRunId = "run-20260707T120000Z-c-0001";
    const partialRunId = "run-20260707T120100Z-c-0002";
    // A completed run recorded with a high original seq (11) — the sort of
    // stale, per-session value that must NOT leak into the live seq space.
    writeFileSync(
      path.join(recordingDir, `${completeRunId}.jsonl`),
      [
        JSON.stringify({
          seq: 10,
          timestamp: "2026-07-07T12:00:00.000Z",
          type: "run.started",
          run_id: completeRunId,
          scenario_id: "c",
          scenario: {
            id: "c",
            label: "C. Reversal",
            purpose: "Mock/replay reversal evidence.",
            outcomes: { customer: "verified", paykey: "active", charge: "reversed_insufficient_funds" },
            requiredObservations: [{ kind: "ordered_statuses", statuses: ["paid", "reversed"] }],
          },
        }),
        JSON.stringify({
          seq: 11,
          timestamp: "2026-07-07T12:00:05.000Z",
          type: "run.completed",
          run_id: completeRunId,
          scenario_id: "c",
          result: "passed",
          duration_ms: 5_000,
          recording_path: path.join(recordingDir, `${completeRunId}.jsonl`),
        }),
        "",
      ].join("\n"),
    );
    // A run whose recording stops before run.completed → partial on reload.
    writeFileSync(
      path.join(recordingDir, `${partialRunId}.jsonl`),
      JSON.stringify({
        seq: 4,
        timestamp: "2026-07-07T12:01:00.000Z",
        type: "run.started",
        run_id: partialRunId,
        scenario_id: "c",
        scenario: {
          id: "c",
          label: "C. Reversal",
          purpose: "Mock/replay reversal evidence.",
          outcomes: { customer: "verified", paykey: "active", charge: "reversed_insufficient_funds" },
          requiredObservations: [{ kind: "ordered_statuses", statuses: ["paid", "reversed"] }],
        },
      }) + "\n",
    );

    const clock = new FakeClock(Date.parse("2026-07-08T12:00:00.000Z"));
    const app = await createHttpServer({
      config: loadConfig({ env: {}, envFilePath: false }),
      epoch: "fresh-epoch",
      mockMode: true,
      clock,
      recordingDir,
      serveStatic: false,
      logger: false,
    });

    // Prior runs are back, with correct post-restart statuses.
    const runsBefore = (await app.inject({ method: "GET", url: "/api/runs" })).json();
    expect(runsBefore.runs).toHaveLength(2);
    const byId = Object.fromEntries(
      runsBefore.runs.map((r: { run_id: string }) => [r.run_id, r]),
    );
    expect(byId[completeRunId].status).toBe("passed");
    expect(byId[partialRunId].status).toBe("partial");

    // The rehydrated high-water mark: three events (2 + 1) renumbered to 1..3,
    // erasing the stale per-session seq (10, 11, 4) from the recordings.
    const cursor = Math.max(
      ...runsBefore.runs.flatMap((r: { events: { seq: number }[] }) =>
        r.events.map((e) => e.seq),
      ),
    );
    expect(cursor).toBe(3);

    // A fresh live run must emit events ABOVE the rehydrated cursor, so a
    // client polling since=cursor still receives them (the restart-cursor bug).
    await app.inject({ method: "POST", url: "/api/runs", payload: { scenarios: ["e"] } });
    await flushAsyncWork();

    const delta = (
      await app.inject({ method: "GET", url: `/api/events?since=${cursor}` })
    ).json<{ events: RunEvent[] }>();
    expect(delta.events.length).toBeGreaterThan(0);
    expect(delta.events.every((e) => e.seq > cursor)).toBe(true);
    expect(delta.events.some((e) => e.type === "run.started" && e.scenario_id === "e")).toBe(true);

    await app.close();
  });

  it("streams epoch and backfilled events over SSE", async () => {
    const bus = createBus();
    const registry = createRunRegistry(bus);
    bus.emit({
      type: "run.started",
      run_id: "run-20260707T120000Z-e-0001",
      scenario_id: "e",
      scenario: {
        id: "e",
        label: "E. Rejected identity",
        purpose: "Rejected customer blocks downstream paykey creation.",
        outcomes: { customer: "rejected", paykey: "active" },
        requiredObservations: [
          { kind: "customer_review", status: "rejected" },
          { kind: "api_refusal", afterAction: "create_paykey" },
        ],
      },
    });
    const app = await createHttpServer({
      config: loadConfig({ env: {}, envFilePath: false }),
      epoch: "test-epoch",
      bus,
      registry,
      mockMode: true,
      attachRecorder: false,
      serveStatic: false,
      logger: false,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/events/stream?since=0&once=1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: epoch");
    expect(response.body).toContain('"epoch":"test-epoch"');
    expect(response.body).toContain("event: run-event");
    expect(response.body).toContain('"type":"run.started"');
    // Each run-event carries an id: line so a native EventSource can resume via
    // Last-Event-ID (P2-R.4).
    expect(response.body).toContain("id: 1\nevent: run-event");

    await app.close();
  });

  it("resumes an SSE backfill from the Last-Event-ID header (P2-R.4)", async () => {
    const bus = createBus();
    const registry = createRunRegistry(bus);
    bus.emit({
      type: "run.started",
      run_id: "run-20260707T120000Z-a-0001",
      scenario_id: "a",
      scenario: {
        id: "a",
        label: "A. Happy path",
        purpose: "Charge settles to paid.",
        outcomes: { customer: "verified", charge: "paid" },
        requiredObservations: [{ kind: "terminal_status", status: "paid" }],
      },
    }); // seq 1
    bus.emit({
      type: "payment.status_changed",
      run_id: "run-20260707T120000Z-a-0001",
      scenario_id: "a",
      resource_id: "chg_1",
      from: null,
      to: "paid",
    }); // seq 2
    const app = await createHttpServer({
      config: loadConfig({ env: {}, envFilePath: false }),
      epoch: "test-epoch",
      bus,
      registry,
      mockMode: true,
      attachRecorder: false,
      serveStatic: false,
      logger: false,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/events/stream?since=0&once=1",
      headers: { "last-event-id": "1" }, // resume after seq 1 → only seq 2 backfills
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("id: 2\nevent: run-event");
    expect(response.body).not.toContain("id: 1\nevent: run-event");

    await app.close();
  });
});

async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
