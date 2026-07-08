import { describe, expect, it } from "vitest";
import { SEEDED_BANK } from "@sse/shared";
import { toCurl } from "./curl";

const PLACEHOLDER_AUTH = "-H 'Authorization: Bearer $STRADDLE_API_KEY'";

describe("toCurl", () => {
  it("builds a well-formed POST command with placeholder auth, idempotency, and the redacted body", () => {
    const cmd = toCurl({
      method: "POST",
      path: "/v1/charges",
      requestBody: {
        amount: 1000,
        external_id: "run-x",
        config: { sandbox_outcome: "paid" },
      },
    });

    expect(cmd).toContain("curl -X POST 'https://sandbox.straddle.io/v1/charges'");
    expect(cmd).toContain(PLACEHOLDER_AUTH);
    // Idempotency-Key is synthesized (headers never enter captures) on creates.
    expect(cmd).toContain("-H 'Idempotency-Key: $(uuidgen)'");
    expect(cmd).toContain("-H 'Content-Type: application/json'");
    expect(cmd).toContain(
      `-d '${JSON.stringify({
        amount: 1000,
        external_id: "run-x",
        config: { sandbox_outcome: "paid" },
      })}'`,
    );
  });

  it("builds a GET command with no body and no idempotency header", () => {
    const cmd = toCurl({ method: "GET", path: "/v1/charges/chg_1" });

    expect(cmd).toContain("curl -X GET 'https://sandbox.straddle.io/v1/charges/chg_1'");
    expect(cmd).toContain(PLACEHOLDER_AUTH);
    expect(cmd).not.toContain("Idempotency-Key");
    expect(cmd).not.toContain("-d ");
    expect(cmd).not.toContain("Content-Type");
  });

  it("POSIX-escapes single quotes in a redacted body so the command stays valid", () => {
    const cmd = toCurl({
      method: "POST",
      path: "/v1/customers",
      requestBody: { name: "O'Brien" },
    });
    // Embedded quote closes, escapes, and reopens: O'\''Brien.
    expect(cmd).toContain("O'\\''Brien");
    expect(cmd).toContain(PLACEHOLDER_AUTH);
  });

  describe("secret safety (structural: only the placeholder auth is ever emitted)", () => {
    it("emits the placeholder and never a literal key on normal redacted input", () => {
      const cmd = toCurl({
        method: "POST",
        path: "/v1/bridge/bank_account",
        requestBody: { paykey: "[REDACTED]", type: "bank_account" },
      });

      expect(cmd).toContain("$STRADDLE_API_KEY");
      expect(cmd).not.toContain("Bearer sk_");
      expect(cmd).not.toMatch(/sk_[A-Za-z0-9]/);
    });

    it("never fabricates auth even if a seeded account number leaked into the body", () => {
      // A redaction MISS upstream would be the redactor's bug, not cURL's: the
      // generator cannot invent auth it was not given — auth is a constant.
      const leaked = SEEDED_BANK.preferred_account_number;
      const cmd = toCurl({
        method: "POST",
        path: "/v1/bridge/bank_account",
        requestBody: { account_number: leaked },
      });

      // The only auth line is the placeholder — no real key, ever.
      expect(cmd).toContain("Bearer $STRADDLE_API_KEY");
      expect(cmd).not.toContain("Bearer sk_");
      expect(cmd).not.toMatch(/Authorization: Bearer (?!\$STRADDLE_API_KEY)/);
    });
  });
});
