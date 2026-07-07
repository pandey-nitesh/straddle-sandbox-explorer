# straddle-sandbox-explorer

Local Vite + React and Node.js explorer for Straddle's sandbox ACH lifecycle (scenarios A–E): live state transitions, JSONL recordings, and a schema-validated report. See `docs/spec.md` (architecture) and `docs/design.md` (UI). API facts are recorded in `api-notes.md` (M0 exit artifact) — never guessed.

Setup, commands, and artifact locations will be documented here as the waves land (spec §13).

## Deviations from spec

Live-sandbox findings from the M0 spike that contradict the original spec assumptions. Authoritative detail: `api-notes.md` §12; resolutions: `docs/spec.md` §18.

- **Scenario C (`paid` → `reversed`) is unobservable live.** `reversed_*` sandbox outcomes terminate as `failed` with the reversal R-code a deterministic ~241 s after the last `pending` event, never surfacing `paid` or `reversed` (contradicts Straddle's own sandbox guide). The paid→reversed contract is demonstrated via the mock client and replay; live Scenario C asserts the deviation evidence (`failed` + expected R-code + reversal-window delay). Re-checked before Wave 2 exit.
- **Scenario E's refusal point is `create_paykey`** (deterministic 422 for rejected customers), not `create_charge`, which is structurally unreachable.
- **Customer review settles synchronously** in the 201 create response — no polling for customers.
- **The invalid-key 401 has an empty body** — the invalid-key screen renders the status line, not a verbatim error body.
- **Sandbox state is mutable:** an R05 dispute return permanently blocks the paykey and the seeded bank account `123456789` for new paykeys; `SEEDED_BANK` carries the spare `987654321` (preferred) and scenarios avoid `*_customer_dispute` outcomes.
- **`config.balance_check` is required on charge creation** and pinned to `"disabled"` in scenario definitions.
- **No `Retry-After`/`X-RateLimit-*` headers observed** — retries honor `Retry-After` if present but never depend on it.
- Error envelopes live under a top-level `error` key; validation failures arrive in two shapes (400 PascalCase refs / 422 lowercase refs); resource timestamps vary in precision, so shared schemas validate datetimes leniently.

*Unofficial developer demo — not affiliated with Straddle Payments Inc.*
