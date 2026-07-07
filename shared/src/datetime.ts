import { z } from "zod";

/**
 * Lenient ISO-8601 datetime validation (spec §5 / api-notes.md §12 item 15).
 *
 * Live Straddle timestamps vary in precision and offset presence:
 *   - `meta.api_request_timestamp` and POST-response `created_at`/`updated_at`:
 *     7-digit fractional seconds + `Z`, e.g. `2026-07-07T06:21:43.8306543Z`
 *   - GET customer/review `created_at`/`updated_at`: second precision, no
 *     fractional part, NO timezone suffix, e.g. `2026-07-07T06:21:44`
 *
 * Zod's default `z.string().datetime()` rejects the second form (no offset)
 * and, without options, the first (7 fractional digits). Every datetime field
 * in shared contracts MUST use this validator instead — never the default.
 *
 * Accepted: `YYYY-MM-DDTHH:MM:SS`, optionally `.1–9 fractional digits`,
 * optionally `Z` or `±HH:MM` offset. Calendar/clock bounds are enforced at the
 * field level (month 01–12, day 01–31, hour 00–23, minute/second 00–59).
 */
const LENIENT_DATETIME_RE =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;

export const LenientDatetimeSchema = z
  .string()
  .regex(
    LENIENT_DATETIME_RE,
    "expected ISO-8601 datetime (fractional seconds and timezone offset both optional)",
  );

export type LenientDatetime = z.infer<typeof LenientDatetimeSchema>;
