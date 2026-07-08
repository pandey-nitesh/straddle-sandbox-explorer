import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ScenarioDef } from "@sse/shared";
import {
  ALL_OUTCOMES,
  CHARGE_STATUSES,
  CUSTOMER_STATUSES,
  DEVIATIONS,
  ENDPOINTS,
  PAYKEY_STATUSES,
  RETURN_CODES,
  deviationById,
  fieldNotesFor,
  matchEndpoint,
  outcomeNote,
  returnCodeNote,
  statusNote,
  timelineDeviationsFor,
} from "./index";
import { SCENARIO_COPY } from "../state/projections";

/**
 * Coverage guards for the learning layer (spec §19): everything the UI can
 * put on screen — statuses the mock schedules emit, the scenario outcomes,
 * the observed return codes — must have a curated explanation, and every
 * entry must cite its api-notes.md section so drift stays auditable.
 */

const ALL_ENTRIES = [
  ...CHARGE_STATUSES,
  ...CUSTOMER_STATUSES,
  ...PAYKEY_STATUSES,
  ...RETURN_CODES,
  ...ALL_OUTCOMES,
  ...ENDPOINTS,
];

describe("knowledge entries", () => {
  it("every entry has an id, a verbatim term, prose, and an api-notes source", () => {
    for (const entry of ALL_ENTRIES) {
      expect(entry.id.length, entry.term).toBeGreaterThan(0);
      expect(entry.term.length, entry.id).toBeGreaterThan(0);
      expect(entry.short.length, entry.id).toBeGreaterThan(0);
      expect(entry.source, entry.id).toMatch(/^api-notes §/);
    }
  });

  it("entry ids are unique across all categories", () => {
    const ids = ALL_ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every charge status the mock schedules can emit", () => {
    // Mirrors server/src/straddle/mock.ts SCHEDULES (web must not import
    // server); on_hold additionally covers the enum's remaining member.
    const mockEmittable = [
      "created",
      "scheduled",
      "pending",
      "paid",
      "failed",
      "reversed",
      "cancelled",
    ];
    for (const status of mockEmittable) {
      expect(statusNote(status), status).toBeDefined();
    }
  });

  it("covers every scenario outcome in SCENARIO_COPY", () => {
    for (const copy of SCENARIO_COPY) {
      expect(
        outcomeNote(copy.outcomeResource, copy.outcome),
        `${copy.id}: ${copy.outcome}`,
      ).toBeDefined();
    }
  });

  it("covers the observed and documented return codes", () => {
    for (const code of ["R01", "R02", "R05"]) {
      expect(returnCodeNote(code), code).toBeDefined();
    }
  });

  it("marks both customer-dispute outcomes as poisoning (api-notes §9)", () => {
    const disputes = ALL_OUTCOMES.filter((o) =>
      o.term.endsWith("_customer_dispute"),
    );
    expect(disputes).toHaveLength(2);
    for (const outcome of disputes) {
      expect(outcome.danger, outcome.term).toBe("poisons");
    }
  });
});

describe("deviations", () => {
  it("represents every numbered deviation in api-notes.md §12 (keyed off the doc)", () => {
    const apiNotes = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../api-notes.md",
      ),
      "utf8",
    );
    const section = apiNotes.split(/^## 12\./m)[1]?.split(/^## /m)[0];
    expect(section, "api-notes §12 exists").toBeDefined();
    const numbers = [...(section ?? "").matchAll(/^(\d+)\.\s/gm)].map((m) =>
      Number(m[1]),
    );
    expect(numbers.length).toBeGreaterThan(0);
    for (const n of numbers) {
      expect(deviationById(`dev-${n}`), `dev-${n}`).toBeDefined();
    }
  });

  it("every deviation entry has an id, headline, detail, and source", () => {
    for (const dev of DEVIATIONS) {
      expect(dev.id.length, dev.id).toBeGreaterThan(0);
      expect(dev.headline.length, dev.id).toBeGreaterThan(0);
      expect(dev.detail.length, dev.id).toBeGreaterThan(0);
      expect(dev.source, dev.id).toMatch(/api-notes §|spec §/);
    }
  });
});

describe("timelineDeviationsFor (structural, from the def snapshot)", () => {
  const contractC: ScenarioDef = {
    id: "c",
    label: "C. Reversal",
    purpose: "p",
    outcomes: { charge: "reversed_insufficient_funds" },
    requiredObservations: [
      { kind: "ordered_statuses", statuses: ["paid", "reversed"] },
    ],
  };
  const liveC: ScenarioDef = {
    ...contractC,
    requiredObservations: [
      { kind: "terminal_status", status: "failed", returnCode: "R01" },
    ],
  };
  const liveD: ScenarioDef = {
    id: "d",
    label: "D. Risk cancellation",
    purpose: "p",
    outcomes: { charge: "cancelled_for_fraud_risk" },
    requiredObservations: [
      { kind: "terminal_status", status: "failed", requireReasonDetail: true },
    ],
  };
  const contractD: ScenarioDef = {
    ...liveD,
    requiredObservations: [
      { kind: "terminal_status", status: "cancelled", requireReasonDetail: true },
    ],
  };
  const defA: ScenarioDef = {
    id: "a",
    label: "A. Happy path",
    purpose: "p",
    outcomes: { charge: "paid" },
    requiredObservations: [{ kind: "terminal_status", status: "paid" }],
  };

  it("live C gets the dev-1 terminal callout; contract C the provisional mirror", () => {
    expect(timelineDeviationsFor(liveC).terminal?.id).toBe("dev-1");
    expect(timelineDeviationsFor(liveC).provisional).toBeUndefined();
    expect(timelineDeviationsFor(contractC).provisional?.id).toBe("dev-1");
    expect(timelineDeviationsFor(contractC).terminal).toBeUndefined();
  });

  it("live D gets the watchtower callout; contract D and A get nothing", () => {
    expect(timelineDeviationsFor(liveD).terminal?.id).toBe("dev-gate-d");
    expect(timelineDeviationsFor(contractD)).toEqual({});
    expect(timelineDeviationsFor(defA)).toEqual({});
  });
});

describe("fieldNotesFor", () => {
  const chargeRequest = {
    paykey: "[redacted]",
    amount: 10_000,
    currency: "USD",
    external_id: "run-x",
    config: { balance_check: "disabled", sandbox_outcome: "paid" },
    device: { ip_address: "[redacted]" },
  };
  const chargeResponse = {
    data: {
      id: "chg",
      status: "failed",
      status_details: { code: "R01", reason: "insufficient_funds", source: "bank_decline" },
      status_history: [{ status: "created" }],
    },
    meta: { api_request_id: "req-1" },
  };

  it("returns notes only for fields actually present, plus the header note on creates", () => {
    const notes = fieldNotesFor("POST", "/v1/charges", chargeRequest, chargeResponse);
    const paths = notes.map((n) => n.path);
    expect(paths).toContain("Idempotency-Key (header)");
    expect(paths).toContain("config.sandbox_outcome");
    expect(paths).toContain("config.balance_check");
    expect(paths).toContain("external_id");
    expect(paths).toContain("meta.api_request_id");
    expect(paths).toContain("status_details.code");
    expect(paths).toContain("status_history");
    expect(paths).not.toContain("identity_details.decision");
    for (const note of notes) {
      expect(note.short.length, note.path).toBeGreaterThan(0);
      expect(note.source.length, note.path).toBeGreaterThan(0);
    }
  });

  it("polling GETs carry no header note and only response-present fields", () => {
    const notes = fieldNotesFor("GET", "/v1/charges/chg_1", undefined, chargeResponse);
    const paths = notes.map((n) => n.path);
    expect(paths).not.toContain("Idempotency-Key (header)");
    expect(paths).toContain("status_details.code");
    expect(paths).not.toContain("amount");
  });

  it("returns nothing for bodies without notable fields", () => {
    expect(fieldNotesFor("GET", "/v1/unknown", undefined, { data: { x: 1 } })).toEqual([]);
  });
});

describe("matchEndpoint", () => {
  it("matches literal create paths", () => {
    expect(matchEndpoint("POST", "/v1/customers")?.id).toBe(
      "endpoint-create-customer",
    );
    expect(matchEndpoint("POST", "/v1/bridge/bank_account")?.id).toBe(
      "endpoint-create-paykey",
    );
  });

  it("distinguishes the list ping from a customer GET by id", () => {
    expect(matchEndpoint("GET", "/v1/customers")?.id).toBe(
      "endpoint-list-customers",
    );
    expect(
      matchEndpoint("GET", "/v1/customers/0198a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b")
        ?.id,
    ).toBe("endpoint-get-customer");
  });

  it("matches {id} segments and nested review paths", () => {
    expect(matchEndpoint("GET", "/v1/charges/abc123")?.id).toBe(
      "endpoint-get-charge",
    );
    expect(matchEndpoint("GET", "/v1/customers/abc123/review")?.id).toBe(
      "endpoint-customer-review",
    );
  });

  it("ignores query strings and is method-sensitive", () => {
    expect(matchEndpoint("get", "/v1/customers?page_size=1")?.id).toBe(
      "endpoint-list-customers",
    );
    expect(matchEndpoint("DELETE", "/v1/customers")).toBeUndefined();
  });

  it("returns undefined for unknown paths", () => {
    expect(matchEndpoint("GET", "/v1/unknown")).toBeUndefined();
  });
});
