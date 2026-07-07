import { z } from "zod";
import { LenientDatetimeSchema } from "./datetime.js";
import { ScenarioIdSchema } from "./scenario.js";

/**
 * Report contracts (spec §5). `ReportSchema` is the final acceptance
 * contract: both the CLI writer and the HTTP `/api/report` handler serialize
 * through `ReportSchema.parse`.
 */

export const StatusTransitionSchema = z.object({
  from: z.string().nullable(), // null for the first observation
  to: z.string(),
  at: LenientDatetimeSchema, // authoritative time is status_history[].changed_at (api-notes §8)
  return_code: z.string().optional(),
  reason: z.string().optional(),
});
export type StatusTransition = z.infer<typeof StatusTransitionSchema>;

/**
 * Field mapping from the live review payload (api-notes.md §6 — build to this):
 *   verification_status ← customer `status` (never `identity_details.decision`,
 *     which is canned "accept" even for rejected customers)
 *   risk_score          ← identity_details.breakdown.fraud.risk_score
 *                         (fallback reputation.risk_score; omit if absent)
 *   correlation_score   ← identity_details.breakdown.email.correlation_score
 *                         (fallback phone; omit if absent)
 *   reason_codes        ← union of all breakdown.<module>.codes[]
 */
export const IdentityReviewSummarySchema = z.object({
  verification_status: z.string(),
  risk_score: z.number().optional(),
  correlation_score: z.number().optional(),
  reason_codes: z.array(z.string()).default([]),
});
export type IdentityReviewSummary = z.infer<typeof IdentityReviewSummarySchema>;

export const ApiRefusalSchema = z.object({
  attempted_action: z.enum(["create_paykey", "create_charge"]), // M0 resolved: create_paykey (api-notes §10)
  http_status: z.number(), // observed 422 for Scenario E
  error_body: z.unknown(), // Straddle's body, verbatim post-redaction
});
export type ApiRefusal = z.infer<typeof ApiRefusalSchema>;

export const ScenarioResultStatusSchema = z.enum([
  "passed",
  "failed",
  "partial", // run interrupted before run.completed (spec §5 suite semantics)
]);
export type ScenarioResultStatus = z.infer<typeof ScenarioResultStatusSchema>;

export const ReportScenarioSchema = z.object({
  id: ScenarioIdSchema,
  name: z.string(),
  status: ScenarioResultStatusSchema,
  resource_ids: z.record(z.string(), z.string()),
  transitions: z.array(StatusTransitionSchema),
  final_status: z.string().optional(),
  return_code: z.string().optional(),
  reason_code: z.string().optional(),
  identity_review: IdentityReviewSummarySchema.optional(),
  refusal: ApiRefusalSchema.optional(),
  recording_path: z.string(),
  duration_ms: z.number(),
  diagnostics: z.array(z.string()),
});
export type ReportScenario = z.infer<typeof ReportScenarioSchema>;

export const ReportSchema = z.object({
  generated_at: LenientDatetimeSchema,
  suite: z.object({
    // passed iff all of A–E covered and passed; failed if any covered scenario
    // failed; partial if fewer than the five required scenarios are covered.
    status: z.enum(["passed", "failed", "partial"]),
    duration_ms: z.number(),
    covered_scenarios: z.array(ScenarioIdSchema),
  }),
  scenarios: z.array(ReportScenarioSchema),
});
export type Report = z.infer<typeof ReportSchema>;
