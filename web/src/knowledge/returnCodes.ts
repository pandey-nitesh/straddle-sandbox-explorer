import type { KnowledgeEntry } from "./types";

/**
 * ACH return-code explanations, curated from api-notes.md §5 (outcome → code
 * mapping), §8 (where codes live), and §9 (the R05 poisoning finding).
 *
 * Codes land at status_details.code on the terminal charge status; the key is
 * absent — not null — when inapplicable, and watchtower failures never carry
 * one. Evaluators key on status_details.source === "bank_decline" + code.
 */
export const RETURN_CODES: readonly KnowledgeEntry[] = [
  {
    id: "return-code-r01",
    term: "R01",
    category: "return-code",
    short:
      "Insufficient funds — the customer's account could not cover the debit.",
    detail:
      "The most common ACH return. In the sandbox it lands at status_details.code on the failed terminal, with source bank_decline. R01 returns do not poison sandbox state — safe to repeat.",
    source: "api-notes §5, §8",
  },
  {
    id: "return-code-r02",
    term: "R02",
    category: "return-code",
    short: "Account closed — the bank account no longer exists.",
    detail:
      "Mapped from the *_closed_bank_account outcomes per Straddle's docs; the placement was not observed live during M0 (unverified, assumed to share the status_details.code slot).",
    source: "api-notes §5",
  },
  {
    id: "return-code-r05",
    term: "R05",
    category: "return-code",
    short:
      "Unauthorized debit — the customer disputed the charge with their bank.",
    detail:
      "On this sandbox an R05 return permanently poisons state: it blocks the paykey and the underlying routing + account pair for new paykey creation (observed still blocked 6+ hours later). The *_customer_dispute outcomes that produce it are never used in repeatable scenarios.",
    source: "api-notes §5, §9",
  },
];
