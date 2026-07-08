/**
 * Learning-layer knowledge types (spec §19). Content is hand-curated from
 * api-notes.md — the M0 "API truth" artifact — and every entry cites the
 * section it came from, so drift is auditable (CLAUDE.md: API facts are never
 * guessed). Web-only by design: the CLI and report are acceptance artifacts,
 * not teaching surfaces, and prose in shared/ would sit under the spec §14
 * contract freeze for no benefit.
 */

export type KnowledgeCategory =
  | "charge-status"
  | "customer-status"
  | "paykey-status"
  | "return-code"
  | "sandbox-outcome"
  | "endpoint"
  | "webhook";

export interface KnowledgeEntry {
  /** Stable id; doubles as the Reference overlay anchor unless overridden. */
  id: string;
  /** The verbatim wire term this explains (rendered mono, design §4). */
  term: string;
  category: KnowledgeCategory;
  /** One-or-two-sentence prose explanation, our voice (design §9). */
  short: string;
  /** Longer prose for the Reference overlay / expanded notes. */
  detail?: string;
  /** Reference overlay anchor; defaults to `id`. */
  refAnchor?: string;
  /** api-notes.md citation, e.g. "api-notes §8". Required — drift guard. */
  source: string;
}

export interface OutcomeEntry extends KnowledgeEntry {
  category: "sandbox-outcome";
  resource: "customer" | "paykey" | "charge";
  /** Terminal status this outcome forces, where known. */
  expectedTerminal?: string;
  /** ACH return code that lands at status_details.code, where applicable. */
  returnCode?: string;
  /** Measured timing in prose, e.g. "~117 s from create to terminal". */
  timing?: string;
  /** "poisons" marks outcomes that permanently damage sandbox state. */
  danger: "safe" | "poisons";
}

export interface EndpointEntry extends KnowledgeEntry {
  category: "endpoint";
  method: string;
  /** Path pattern; `{x}` segments match any value ("/v1/charges/{id}"). */
  pattern: string;
}
