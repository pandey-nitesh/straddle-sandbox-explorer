import { z } from "zod";

/**
 * Scenario contracts (spec §5).
 *
 * The full planned scenario set a–i, so P2 scenarios are not a breaking schema
 * change. The runnable set is gated by the scenario REGISTRY
 * (server/src/engine/scenarios.ts), not by this type.
 */
export const ScenarioIdSchema = z.enum([
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
]);
export type ScenarioId = z.infer<typeof ScenarioIdSchema>;

/**
 * The four observation kinds. Kept in lockstep with the literals inside
 * `RequiredObservationSchema` below (discriminated unions need literal
 * discriminators; a unit test asserts they match).
 */
export const RequiredObservationKindSchema = z.enum([
  "terminal_status",
  "ordered_statuses",
  "customer_review",
  "api_refusal",
]);
export type RequiredObservationKind = z.infer<
  typeof RequiredObservationKindSchema
>;

/**
 * Required observations are structured, not strings — the evaluator's input
 * must be able to express ordering (C), code requirements (B), and E's
 * two-part gate without ad-hoc parsing (spec §5).
 *
 * `api_refusal.afterAction` was resolved to "create_paykey" by M0
 * (api-notes.md §10); "create_charge" stays in the enum for stability but no
 * A–E scenario produces it.
 */
export const RequiredObservationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("terminal_status"),
    status: z.string(),
    returnCode: z.string().optional(), // B: "R01" — lives at status_details.code (api-notes §8)
    requireReasonDetail: z.boolean().optional(), // D
  }),
  z.object({
    kind: z.literal("ordered_statuses"),
    statuses: z.array(z.string()).min(2), // C: ["paid","reversed"]
  }),
  z.object({
    kind: z.literal("customer_review"),
    status: z.string(), // E: "rejected" — keys on customer status, never identity_details.decision (api-notes §6)
  }),
  z.object({
    kind: z.literal("api_refusal"),
    afterAction: z.enum(["create_paykey", "create_charge"]), // E: M0 picked "create_paykey"
  }),
]);
export type RequiredObservation = z.infer<typeof RequiredObservationSchema>;

export const ScenarioDefSchema = z.object({
  id: ScenarioIdSchema,
  label: z.string(),
  purpose: z.string(),
  flow: z.array(z.string()).min(1).optional(),
  outcomes: z.object({
    customer: z.string().optional(),
    paykey: z.string().optional(),
    charge: z.string().optional(),
  }),
  requiredObservations: z.array(RequiredObservationSchema).min(1),
});
export type ScenarioDef = z.infer<typeof ScenarioDefSchema>;

/**
 * DERIVED, not stored — one source of truth (spec §5). A scenario expects a
 * reversal iff one of its ordered-status observations includes "reversed".
 */
export const expectsReversal = (def: ScenarioDef): boolean =>
  def.requiredObservations.some(
    (o) => o.kind === "ordered_statuses" && o.statuses.includes("reversed"),
  );
