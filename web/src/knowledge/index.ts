import type { KnowledgeEntry, OutcomeEntry } from "./types";
import {
  CHARGE_STATUSES,
  CUSTOMER_STATUSES,
  PAYKEY_STATUSES,
} from "./statuses";
import { RETURN_CODES } from "./returnCodes";
import { ALL_OUTCOMES } from "./outcomes";
import { matchEndpoint } from "./endpoints";

export type {
  EndpointEntry,
  KnowledgeCategory,
  KnowledgeEntry,
  OutcomeEntry,
} from "./types";
export {
  CHARGE_STATUSES,
  CUSTOMER_STATUSES,
  PAYKEY_STATUSES,
} from "./statuses";
export { RETURN_CODES } from "./returnCodes";
export {
  ALL_OUTCOMES,
  CHARGE_OUTCOMES,
  CUSTOMER_OUTCOMES,
  PAYKEY_OUTCOMES,
} from "./outcomes";
export { ENDPOINTS, matchEndpoint } from "./endpoints";
export { fieldNotesFor, type FieldNote } from "./fields";
export {
  DEVIATIONS,
  deviationById,
  timelineDeviationsFor,
  type DeviationNote,
  type TimelineDeviations,
} from "./deviations";

/** Charge-status note for timeline nodes (terminal annotations only at A1). */
export function statusNote(status: string): KnowledgeEntry | undefined {
  return CHARGE_STATUSES.find((e) => e.term === status);
}

export function customerStatusNote(status: string): KnowledgeEntry | undefined {
  return CUSTOMER_STATUSES.find((e) => e.term === status);
}

export function paykeyStatusNote(status: string): KnowledgeEntry | undefined {
  return PAYKEY_STATUSES.find((e) => e.term === status);
}

/** ACH return-code note for terminal code chips (R01, R05, …). */
export function returnCodeNote(code: string): KnowledgeEntry | undefined {
  return RETURN_CODES.find((e) => e.term === code);
}

/**
 * Sandbox-outcome note for the mono `sandbox_outcome:` lines. Outcome terms
 * collide across resources ("rejected" exists on customers and paykeys), so
 * the resource is part of the key; scenario rows show the charge outcome
 * except E, which shows the customer outcome.
 */
export function outcomeNote(
  resource: OutcomeEntry["resource"],
  outcome: string,
): OutcomeEntry | undefined {
  return ALL_OUTCOMES.find(
    (e) => e.resource === resource && e.term === outcome,
  );
}

/** "What this call does" note for a wire-log exchange. */
export function endpointNote(
  method: string,
  path: string,
): KnowledgeEntry | undefined {
  return matchEndpoint(method, path);
}
