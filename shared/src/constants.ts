/**
 * Seeded sandbox bank constants — recorded VERBATIM from api-notes.md §7
 * (Straddle docs examples, accepted live). These are the ONLY account/routing
 * values the engine ever sends, which is what makes the check-secrets canary
 * mechanism sound (spec §8): the scanner's canary list is exactly
 * `STRADDLE_API_KEY` from the environment plus these static values.
 *
 * Seeded accounts are MUTABLE sandbox state (api-notes §12 item 11):
 * "123456789" is currently R05-blocked on this sandbox key (dispute returns
 * poison the routing+account pair for >= 6 h). Scenarios must use the
 * preferred account and must never use `*_customer_dispute` outcomes.
 */
export const SEEDED_BANK = {
  /** Resolves to institution_name "JPMORGAN CHASE BANK, NA". */
  routing_number: "021000021",
  /**
   * Both documented account numbers, preferred FIRST:
   * - "987654321": verified working live — always use this one.
   * - "123456789": primary docs example, currently R05-blocked on this
   *   sandbox key; kept so redaction + canary coverage includes it.
   */
  account_numbers: ["987654321", "123456789"],
  preferred_account_number: "987654321",
  blocked_account_number: "123456789",
} as const;

/**
 * Flat canary list for scripts/check-secrets.ts: every seeded bank value that
 * must never survive redaction into logs, reports, recordings, or web/dist.
 */
export const SEEDED_BANK_CANARY_VALUES: readonly string[] = [
  SEEDED_BANK.routing_number,
  ...SEEDED_BANK.account_numbers,
];
