import { describe, expect, it } from "vitest";
import { SEEDED_BANK, SEEDED_BANK_CANARY_VALUES } from "./constants.js";

describe("SEEDED_BANK (verbatim from api-notes.md §7)", () => {
  it("pins the documented routing number", () => {
    expect(SEEDED_BANK.routing_number).toBe("021000021");
  });

  it("carries BOTH documented account numbers, preferred first", () => {
    expect(SEEDED_BANK.account_numbers).toEqual(["987654321", "123456789"]);
    expect(SEEDED_BANK.account_numbers[0]).toBe(
      SEEDED_BANK.preferred_account_number,
    );
  });

  it("encodes preferred/blocked semantics as data", () => {
    expect(SEEDED_BANK.preferred_account_number).toBe("987654321");
    expect(SEEDED_BANK.blocked_account_number).toBe("123456789");
    expect(SEEDED_BANK.preferred_account_number).not.toBe(
      SEEDED_BANK.blocked_account_number,
    );
  });

  it("canary list covers the routing number and every account number", () => {
    expect(SEEDED_BANK_CANARY_VALUES).toContain(SEEDED_BANK.routing_number);
    for (const acct of SEEDED_BANK.account_numbers) {
      expect(SEEDED_BANK_CANARY_VALUES).toContain(acct);
    }
    expect(SEEDED_BANK_CANARY_VALUES).toHaveLength(3);
  });
});
