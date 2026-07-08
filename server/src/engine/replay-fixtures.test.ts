import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RunEventSchema,
  SEEDED_BANK_CANARY_VALUES,
  type RunEvent,
} from "@sse/shared";

/**
 * P2-2 replay fixtures (spec §11): the committed mock-generated recordings for
 * scenarios F/G/H/I must stay valid — every line parses through the SAME
 * RunEventSchema the browser replay path uses (web/src/api.ts), the recording
 * is a complete run (run.started … run.completed), and no credential/canary
 * value survived into the file. Regenerate with
 * `npx tsx __fixtures__/generate-replay-fixtures.ts`.
 */
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../__fixtures__",
);

function loadFixture(id: string): { raw: string; events: RunEvent[] } {
  const raw = readFileSync(path.join(FIXTURES_DIR, `run-fixture-${id}.jsonl`), "utf8");
  const events = raw
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    // Each line must independently parse via the shared schema (spec §11).
    .map((line) => RunEventSchema.parse(JSON.parse(line)));
  return { raw, events };
}

const terminalsOf = (events: RunEvent[]): string[] =>
  events
    .filter((e): e is Extract<RunEvent, { type: "payment.status_changed" }> =>
      e.type === "payment.status_changed",
    )
    .map((e) => e.to);

describe("P2-2 replay fixtures", () => {
  for (const id of ["f", "g", "h", "i"] as const) {
    it(`${id}: is a valid, complete, canary-clean recording`, () => {
      const { raw, events } = loadFixture(id);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]?.type).toBe("run.started");
      const completed = events.at(-1);
      expect(completed?.type).toBe("run.completed");
      if (completed?.type === "run.completed") {
        expect(completed.result).toBe("passed");
      }
      // Global monotonic seq, strictly increasing within a single-run recording.
      const seqs = events.map((e) => e.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      // Redaction is a gate for replay files too (P2 principle): no seeded
      // account/routing value survives.
      for (const canary of SEEDED_BANK_CANARY_VALUES) {
        expect(raw).not.toContain(canary);
      }
    });
  }

  it("f: terminal failed carries the R02 closed-account code", () => {
    const { events } = loadFixture("f");
    expect(terminalsOf(events).at(-1)).toBe("failed");
    const failed = events.find(
      (e): e is Extract<RunEvent, { type: "payment.status_changed" }> =>
        e.type === "payment.status_changed" && e.to === "failed",
    );
    expect(failed?.return_code).toBe("R02");
  });

  it("g: replays the paid → reversed contract with the R02 code", () => {
    const terminals = terminalsOf(loadFixture("g").events);
    expect(terminals).toContain("paid");
    expect(terminals).toContain("reversed");
    expect(terminals.indexOf("paid")).toBeLessThan(terminals.indexOf("reversed"));
  });

  it("h: replays on_hold before the paid terminal", () => {
    const terminals = terminalsOf(loadFixture("h").events);
    expect(terminals).toContain("on_hold");
    expect(terminals).toContain("paid");
    expect(terminals.indexOf("on_hold")).toBeLessThan(terminals.lastIndexOf("paid"));
  });

  it("i: replays a real terminal cancelled", () => {
    expect(terminalsOf(loadFixture("i").events).at(-1)).toBe("cancelled");
  });
});
