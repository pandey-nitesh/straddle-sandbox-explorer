# straddle-sandbox-explorer

Local Vite + React and Node.js explorer for Straddle's sandbox ACH lifecycle (scenarios A–E): live state transitions, JSONL recordings, and a schema-validated report. See `docs/spec.md` (architecture) and `docs/design.md` (UI). API facts are recorded in `api-notes.md` (M0 exit artifact) — never guessed.

Setup, commands, and artifact locations will be documented here as the waves land (spec §13).

## Commands

- `npm run dev` — tsx-watch server on `:8787` plus Vite on `:5173` (`/api` proxied to `8787`). Orchestrated by `scripts/dev.ts`, a tiny dependency-free spawner (no `concurrently`).
- `npm start` — builds `web/dist` if absent, then serves API + static bundle single-origin on `:8787` (`scripts/start.ts`).
- `MOCK_MODE=1 npm start` (or `npm run dev`) — same server wired to the scripted mock Straddle client instead of the live sandbox (no API key needed); the mock replays the M0-measured timings, including Scenario C's contract-shape `paid → reversed`.
- `NODE_USE_ENV_PROXY=1 npx tsx scripts/qa-screenshots.ts` — Wave 4 QA driver: boots mock/missing-key/invalid-key servers over the built bundle and captures the design §11 screenshot set into `web/qa-screenshots/` (gitignored) with Playwright. The mock server runs on a 30×-scaled clock so C's ~6-minute lifecycle lands in ~12 s.

## Web workspace decisions (Wave 4)

- `web/tsconfig.json` uses `moduleResolution: "bundler"` (extending `tsconfig.base.json`): Vite bundles `web/`, so NodeNext `.js` relative-import extensions are not used there.
- Fonts are self-hosted via `@fontsource/inter` (400/500/600) and `@fontsource/jetbrains-mono` (400/600) with `font-display: swap` — equivalent self-hosting to design.md §11's `web/public/fonts` (the woff2 files are bundled locally into `web/dist/assets`; no external font request at runtime; verified in the smoke test and the built CSS).
- Tailwind v4 with `@tailwindcss/vite`: design.md §11's `tailwind.config` token mapping is realized as the v4 CSS-first equivalent — an `@theme inline` block in `web/src/styles/app.css` pointing utilities at the custom properties in `web/src/styles/tokens.css`, so D0 calibration stays a one-file change and components never hard-code hexes.
- D0 brand calibration has not happened: the `--brand-*` tokens ship the documented teal/slate fallbacks from design.md §3.

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
- **Wave 2 adapter uses direct `fetch` behind the `StraddleClient` boundary.** M0 selected the SDK, but the runtime adapter currently calls the M0-confirmed endpoints directly so retry timing and `api.exchange` telemetry stay under local control. The SDK remains pinned and isolated as a future swap target.

*Unofficial developer demo — not affiliated with Straddle Payments Inc.*
