# api-notes.md — M0 API truth (Wave 0d exit artifact)

Consolidated from the five M0 probes (`spike/notes/{transport,customer,paykey-charge,c-timing,refusal}.md`),
all run live against `https://sandbox.straddle.io` on 2026-07-07. Evidence captures live in
`spike/captures/` (local only, gitignored; response bodies only — auth headers never written by
construction). Per docs/spec.md §2, this file is authoritative for paths, headers, enums, and
timings; nothing here is guessed.

Legend: **OBSERVED** = live HTTP evidence in a capture. **SDK-SOURCE** = verified by reading
`@straddlecom/straddle@0.3.0` source/types, not exercised live. **DOCS** = docs.straddle.com.
**UNVERIFIED** = none of the above — do not build on it.

---

## 1. Transport & auth

**DECISION: use the official SDK — `@straddlecom/straddle@0.3.0`, pinned exact** — constructed as:

```ts
new Straddle({
  apiKey: process.env.STRADDLE_API_KEY,
  baseURL: "https://sandbox.straddle.io",  // ALWAYS explicit — see below
  maxRetries: 0,                            // we own retries → retry.scheduled has real delay_ms
  logLevel: "off",                          // option overrides STRADDLE_LOG env; debug logs bodies
  fetch: instrumentedFetch,                 // one api.exchange per HTTP attempt; redacts before emit
})
```

Justification: the SDK provides typed params/responses for every resource we touch and typed
error classes (`.status`, `.error` = parsed body, `.headers`); its only gaps are telemetry and
retry observability, and both are closed by the injected `fetch` (sees every attempt; the single
choke point where redaction runs) plus `maxRetries: 0` (backoff moves into our wrapper so
`retry.scheduled` events carry real `delay_ms`). Raw `fetch` would buy nothing but hand-written
types. Fallback if the SDK misbehaves: the client's generic `get/post/put/patch(path, opts)`
verbs, plus everything in this file.

- **Base URL:** `https://sandbox.straddle.io` (OBSERVED working). The SDK's *default* sandbox
  environment is `https://sandbox.straddle.com` (also OBSERVED working) and it reads a
  `STRADDLE_BASE_URL` env var when `baseURL` is omitted — so `client.ts` must always pass
  `baseURL` explicitly, never rely on `environment: 'sandbox'`.
- **Auth scheme:** HTTP bearer token — the standard `authorization` request header with
  `Bearer` + the sandbox secret key (SDK builds it from `apiKey`). OBSERVED working live.
- **Invalid key (OBSERVED):** HTTP **401 with a completely empty body** (0 bytes, no JSON, no
  `content-type`). The SDK throws `AuthenticationError` with `err.error === undefined` and
  `err.message === "401 status code (no body)"`. There is no error body to display — see §12.
- **SDK error classes:** by status — 400 `BadRequestError`, 401 `AuthenticationError`,
  403 `PermissionDeniedError`, 404 `NotFoundError`, 409 `ConflictError`,
  422 `UnprocessableEntityError`, 429 `RateLimitError`, ≥500 `InternalServerError`, plus
  `APIConnectionError`/`APIConnectionTimeoutError`. **`err.name` is `"Error"`** — match on
  `instanceof` or `.status`, never `.name`.
- **SDK logging:** `logLevel` default `'warn'` or `STRADDLE_LOG` env; `'debug'` logs full headers
  AND bodies. Always construct with `logLevel: 'off'` (the option overrides the env var).
- Raw `Response` access exists on every call: `.asResponse()` / `.withResponse()`.
- Observed latency through this dev container's proxy: ~500–1450 ms per write, ~180–900 ms per GET.
- **Dev-container note (this environment only):** Node's global fetch (and the SDK) reaches the
  sandbox only with `NODE_USE_ENV_PROXY=1` and `NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`
  set; curl works as-is. Every spike script and the dev server must run with those env vars here.

## 2. Endpoints

All endpoints require bearer auth; writes require `Content-Type: application/json`.
"Idem" = send the `Idempotency-Key` header (recommended `<run_id>-<step>`). No endpoint needs
`Straddle-Account-Id` with a direct account key (OBSERVED; it is for platform keys).

| Purpose | Method + path | Extra headers | Status |
| --- | --- | --- | --- |
| Health / auth ping | GET `/v1/customers` (list; no dedicated health endpoint exists) | — | OBSERVED 200 / 401-empty |
| Create customer | POST `/v1/customers` | Idem | OBSERVED 201 |
| Get customer | GET `/v1/customers/{id}` | — | OBSERVED 200 |
| Identity review | GET `/v1/customers/{id}/review` | — | OBSERVED 200 (works for every status) |
| Manual review decision | PATCH `/v1/customers/{id}/review` body `{status:'verified'\|'rejected'}` | Idem | SDK-SOURCE, not exercised |
| Refresh review | PUT `/v1/customers/{id}/refresh_review` | Idem | SDK-SOURCE, not exercised |
| Create paykey | POST `/v1/bridge/bank_account` (there is **no** POST `/v1/paykeys`) | Idem | OBSERVED 201 |
| Get paykey | GET `/v1/paykeys/{id}` | — | SDK-SOURCE, not exercised (engine keeps the token from create) |
| Create charge | POST `/v1/charges` | Idem | OBSERVED 201 |
| Get charge (poll) | GET `/v1/charges/{id}` | — | OBSERVED 200 |
| Cancel / hold / release charge | PUT `/v1/charges/{id}/cancel\|hold\|release` | Idem | SDK-SOURCE, not exercised |

Never call: GET `/v1/customers/{id}/unmasked`, `/v1/charges/{id}/unmask`, `paykeys.reveal/unmasked`
(they return raw PII / unmasked values; exist for compliance use only).

## 3. Headers

- **Idempotency header: exact name `Idempotency-Key`.** OBSERVED **enforced server-side**: two
  POST `/v1/customers` with identical key + identical body both returned 201 with the **same
  customer id** — transparent replay, no 409. Same-key-different-body behavior UNVERIFIED.
  **SDK gotcha:** the Stainless per-request `idempotencyKey` option is **inert** in v0.3.0
  (`idempotencyHeader` never assigned) — send `Idempotency-Key` explicitly as the typed header
  param inside create/update params.
  **Value validation (OBSERVED at the Wave 4 live gate, 2026-07-07):** a 43-char key
  (`run-…-e-84b1-paykey-refusal`) was rejected with 400 `/bad_request`
  `items:[{detail:"The Idempotency-Key header value is not valid."}]` while 35–37-char keys were
  accepted — there is an undocumented length (or format) cap around ~40 chars. The engine sends a
  UUID (36 chars) per create; exact cap UNVERIFIED.
- Other optional typed header params on create/update: `Request-Id`, `Correlation-Id`,
  `Straddle-Account-Id` (platform-only; not needed).
- **No `X-RateLimit-*` headers on any observed response. No `Retry-After` observed** (a 429 was
  never provoked — its presence on 429 is UNVERIFIED). The retry loop honors `retry-after-ms` /
  `retry-after` if present but must not depend on them.
- **No request-id response header.** The only request identifier is `meta.api_request_id` in the
  JSON body (absent on the body-less 401, where `cf-ray` is the only trace id). Response headers
  are Cloudflare-minimal.
- The SDK sends `X-Stainless-*` telemetry request headers, including `X-Stainless-Retry-Count`
  (0-based attempt number).

## 4. Response envelopes (exact field names)

**Single resource (OBSERVED on customer, paykey, and charge create + GET):**

```json
{ "data": { ... }, "meta": { "api_request_id": "…", "api_request_timestamp": "…" }, "response_type": "object" }
```

**List (OBSERVED):**

```json
{ "data": [ ... ],
  "meta": { "page_number", "page_size", "total_pages", "max_page_size", "sort_by", "sort_order",
            "total_items", "api_request_id", "api_request_timestamp" },
  "response_type": "array" }
```

Observed: `max_page_size: 1000`, default `sort_by: "name"`, `sort_order: "asc"`. The SDK's
`.list()` page wrapper exposes `.data`/`.meta` but drops `response_type`.

**Error (OBSERVED on 400, 404, 422):** the error is under a top-level **`error`** key — NOT
`data` (contradicts the SDK docstring):

```json
{ "error": { "status": 404, "type": "/not_found", "title": "Not Found",
             "detail": "…optional…", "items": [ {"reference": "…", "detail": "…"} ] },
  "meta": { "api_request_id": "…", "api_request_timestamp": "…" },
  "response_type": "error" }
```

`response_type` enum (SDK-SOURCE): `object | array | error | none`.

**Two validation shapes exist (OBSERVED) — handle both as non-retryable validation failures:**

| | 400 `/bad_request` | 422 `/validation_error` |
| --- | --- | --- |
| `error.title` | "Bad Request" | "Validation Failed" |
| `error.items[].reference` | PascalCase dotted (`Device.IpAddress`) | lowercase (`name`, `currency`) |
| Seen on | empty create body | missing fields, `currency: "usd"`, and the Scenario E refusal (§10) |

Match `reference` case-insensitively.

**Timestamp formats (contract-critical, OBSERVED):**

- `meta.api_request_timestamp` and POST-response `created_at`/`updated_at`: 7-digit fractional
  seconds + `Z` (e.g. `2026-07-07T06:21:43.8306543Z`).
- **GET customer/review responses truncate `created_at`/`updated_at` to `2026-07-07T06:21:44` —
  second precision, no fractional part, NO timezone suffix.** Zod's default
  `z.string().datetime()` rejects this form; shared schemas need a lenient validator.
- Charge `status_history[].changed_at` keeps 7-digit precision even on GET.

Resource IDs are bare UUIDv7-style strings everywhere — no `cus_`/`pk_`/`chg_` prefixes.
`external_id` is echoed back verbatim on customers, paykeys, and charges, so the
`external_id = run_id` convention works.

GET `/v1/charges/{id}` returns fields absent from SDK `ChargeV1` types: `trace_ids` (`{}`),
`has_refund`, `is_resubmit`, `has_resubmit`, plus `payment_rail: "ach"`,
`paykey_details {id, customer_id, label}`, `customer_details {id, name, email, phone,
customer_type}` (unmasked PII), `effective_at`, `processed_at` — **DTOs must tolerate unknown
fields, never parse strictly.**

## 5. Sandbox outcomes

Forcing field on all three resources: **`config.sandbox_outcome`** in the create body. Sibling
`config.processing_method`: `inline | background | skip`, server default `"inline"` (echoed back;
`background`/`skip` UNVERIFIED).

| Resource | Enum | Observed |
| --- | --- | --- |
| Customer | `standard \| verified \| rejected \| review` | verified/review/rejected each force `data.status` to exactly that value, synchronously in the 201 |
| Paykey (bridge) | `standard \| active \| rejected \| review` | `active` observed, synchronous |
| Charge | `standard \| paid \| on_hold_daily_limit \| cancelled_for_fraud_risk \| cancelled_for_balance_check \| failed_insufficient_funds \| reversed_insufficient_funds \| failed_customer_dispute \| reversed_customer_dispute \| failed_closed_bank_account \| reversed_closed_bank_account` | paid, failed_insufficient_funds, reversed_insufficient_funds, reversed_customer_dispute observed |

DOCS return-code mapping: insufficient funds → **R01**, closed account → **R02**, dispute →
**R05** (R01 and R05 placement OBSERVED; R02 UNVERIFIED, assumed same slot).

**Scenario mapping (A–E):**

| Scenario | Customer outcome | Paykey outcome | Charge outcome |
| --- | --- | --- | --- |
| A happy path | `verified` | `active` | `paid` |
| B failed + R01 | `verified` | `active` | `failed_insufficient_funds` |
| C reversal | `verified` | `active` | `reversed_insufficient_funds` — **see §9: never surfaces paid/reversed live** |
| D cancelled + reason | `verified` | `active` | `cancelled_for_fraud_risk` or `cancelled_for_balance_check` (timing UNMEASURED) |
| E rejected identity | `rejected` | *(attempt is refused — §10)* | *(unreachable)* |

**Hard rules (OBSERVED, destructive-state):** never use `*_customer_dispute` outcomes in
repeatable scenarios — an R05 return permanently (≥6 h) blocks both the paykey and the underlying
routing+account pair (§7). R01 returns do **not** poison. `sandbox_outcome` forcing does not
bypass business rules (a rejected customer's paykey create is refused even with
`sandbox_outcome: "active"`).

## 6. Customer identity & review

- **Settle timing: SYNCHRONOUS.** With default `processing_method: "inline"`, the 201 create
  response already carries the forced terminal `data.status`. Zero polling for the customer step.
  Measured create latency (via this proxy): 680–1440 ms; review GET 178–253 ms — customer +
  review evidence costs ~1–2 s per scenario.
- Customer `status` enum: `pending | review | verified | inactive | rejected` (SDK-SOURCE;
  verified/review/rejected OBSERVED live; pending/inactive never observed with inline processing).
  Lives at `data.status` on customers and `data.customer_details.status` in review responses.
- GET `/v1/customers/{id}/review` returns 200 for customers in **all** statuses. Response `data`:
  `customer_details` (full customer) + `identity_details`:

```text
identity_details: {
  review_id, decision: 'accept'|'reject'|'review',
  messages: { "<code>": "<human description>", ... },
  breakdown: { email|phone|fraud (+typed: address, synthetic, kyc, business_*):
               { decision, codes[], risk_score, correlation_score?, correlation? } },
  network_alerts: { decision, codes[], alerts[] },
  watch_list: { decision, codes[], matches[] },
  reputation: { decision, codes[], risk_score, insights: {...} },
  created_at, updated_at }
```

- **CRITICAL SANDBOX QUIRK (OBSERVED on both 0b and the Scenario-E path):**
  `identity_details.decision` is **`"accept"` even for a `rejected` customer** — the review
  payload is canned synthetic data and does not mirror the forced outcome. **The authoritative
  verification status is the customer's `status`, never `identity_details.decision`.**
- Scores are per-module 0–1 floats (`risk_score` observed 0.01–0.452, `correlation_score` 0.99);
  **no top-level risk/correlation score exists.** Reason codes are I-prefixed strings (`I121`,
  `I553`, …) in `breakdown.<module>.codes[]`, with descriptions in the `messages` dict.
- **`IdentityReviewSummary` mapping (consolidation decision — build to this):**
  - `verification_status` ← customer `status`
  - `risk_score` ← `identity_details.breakdown.fraud.risk_score` (fallback:
    `reputation.risk_score`; omit if absent)
  - `correlation_score` ← `identity_details.breakdown.email.correlation_score` (fallback:
    `phone`; omit if absent)
  - `reason_codes` ← union of all `breakdown.<module>.codes[]` (equivalently: keys of
    `identity_details.messages`)
- Required create fields (OBSERVED via validation errors + working create): `name`, `type`
  (`individual | business`), `email`, `phone` (E.164), `device.ip_address` (`"0.0.0.0"` accepted
  = offline registration). Working body shape: `{name, email, phone, type, device:{ip_address},
  config:{sandbox_outcome}, external_id, metadata}`.
- Server masks response PII: `device.ip_address` comes back as `**.**.**.**`.

## 7. Paykey

- **Path: POST `/v1/bridge/bank_account`** (SDK `client.bridge.link.bankAccount`). The paykeys
  resource has NO direct create. No headers needed beyond auth (+ optional `Idempotency-Key`).
- Body: `{ customer_id, routing_number, account_number, account_type ('checking'|'savings'),
  config:{sandbox_outcome?, processing_method?}, external_id?, metadata? }`.
- Settles **synchronously** to `status: "active"` with `sandbox_outcome: "active"` (~750 ms).
- **SEEDED_BANK constants (DOCS examples, accepted live — record verbatim in
  `shared/src/constants.ts`):**
  - `routing_number: "021000021"` → resolves to `institution_name: "JPMORGAN CHASE BANK, NA"`
  - `account_number: "123456789"` (primary docs example) — **currently R05-blocked on this
    sandbox key** (§9): bridge create returns 422 "This bank account has been blocked due to
    return code R05 (Disputed)…". Unknown if the block expires.
  - `account_number: "987654321"` (second docs example) — **verified working; prefer this one.**
  - Other routing/account values UNVERIFIED.
- Response `data` (OBSERVED): `id` (bare UUID), **`paykey`** — the token, format
  `<8hex>.<2digit>.<64hex>`, **unmasked only in this create response** (masked in charge
  responses; treat as a credential, §11) — `customer_id`, `external_id`,
  `label` (`"JPMORGAN CHASE BANK, NA - *6789"`), `institution_name`, `source: "bank_account"`,
  `status`, `status_details {message, reason, source, changed_at, code?}`,
  `bank_data { routing_number (UNMASKED), account_number (masked "*****6789"), account_type }`,
  `config`, `created_at`, `updated_at`. `balance` absent on bank_account paykeys — which is why
  `config.balance_check: "required"` on charges always fails (§8).
- Paykey `status` enum: `pending | active | inactive | rejected | review` (SDK-SOURCE; `active`
  OBSERVED).
- **Engine rule (OBSERVED, from R05 poisoning):** create a fresh customer + paykey per scenario
  run; never reuse paykeys across runs — a dispute return blocks the paykey (watchtower
  `invalid_paykey` failure on all later charges).

## 8. Charges

**Required create fields (SDK-SOURCE, confirmed sufficient live):**

| Field | Fact |
| --- | --- |
| `paykey` | the **token** from the bridge create response, not the paykey id |
| `amount` | **integer cents** (`10000` = $100.00) |
| `currency` | exactly `"USD"` — lowercase `"usd"` rejected with 422 `/validation_error` |
| `description` | free text |
| `consent_type` | `internet \| signed` |
| `device.ip_address` | required (as on customers) |
| `external_id` | **must be unique across all charges** — run_id works |
| `payment_date` | `YYYY-MM-DD` |
| `config.balance_check` | **required field**; enum `required \| enabled \| disabled` |

Optional: `config.sandbox_outcome`, `metadata`.

**THE BALANCE-CHECK TRAP (OBSERVED):** `config.balance_check: "required"` makes Watchtower fail
**every** charge on a bank_account paykey (which has no balance) in ~7–12 s — including
`sandbox_outcome: "paid"` — with `reason: "insufficient_funds"`, `source: "watchtower"`, no
`code`, message "Unable to retrieve balance information…". **Scenario charges must send
`config.balance_check: "disabled"`** (`"enabled"` is also OBSERVED safe, but `"disabled"` is the
pinned choice).

**Charge `status` enum:** `created | scheduled | failed | cancelled | on_hold | pending | paid | reversed`.

**Where return codes / reason details live (exact nesting):**

- `data.status` — current status.
- `data.status_details = { message, reason, source, code?, changed_at }` — current-status detail.
  - `reason` enum (SDK-SOURCE, 20 values — and NOT closed, see below): `insufficient_funds |
    closed_bank_account | invalid_bank_account | invalid_routing | disputed | payment_stopped |
    owner_deceased | frozen_bank_account | risk_review | fraudulent | duplicate_entry |
    invalid_paykey | payment_blocked | amount_too_large | too_many_attempts |
    internal_system_error | user_request | ok | other_network_return | payout_refused`.
  - `source` enum: `watchtower | bank_decline | customer_dispute | user_action | system`.
  - **`code` is the ACH return-code slot** — OBSERVED `"R01"` (bank_decline) and `"R05"`; the key
    is **absent (not null)** when inapplicable, and **watchtower failures carry no code** while
    sharing `reason: "insufficient_funds"` with bank declines — **Scenario B's evaluator must key
    on `source: "bank_decline"` + `code`, never on `reason` alone.**
- `data.status_history[]` — same shape plus `status`, ordered oldest→newest. **Event-level, not
  status-change-level** (OBSERVED: three consecutive `pending` entries with different progress
  messages) — transition derivation must dedupe consecutive identical statuses. Missed
  intermediate statuses are recoverable from history. The terminal history entry mirrors
  `status_details`.
- The `reason` value `invalid_paykey` (watchtower, carries the blocking R-code in `code`) was
  OBSERVED live but is in the SDK enum — treat the enum as extensible anyway; never crash on an
  unknown `reason`/`status` string.
- Propagation lag exists: a GET 13 ms after a terminal `changed_at` still returned the prior
  status — `status_history[].changed_at` is the authoritative transition time, not poll wall-clock.

**Server-side masking in charge responses (OBSERVED):** `data.paykey` masked
(`255***.02.******78f`), `device.ip_address` masked; `customer_details.{name,email,phone}` are
UNMASKED PII on GET.

**Measured lifecycle (balance_check disabled, all times server `changed_at`):**
`created → scheduled` +2.6–9.2 s → `pending` at the next sandbox processor minute-tick
(observed :32 past each minute; worst ~60 s; `processed_at` set here) → terminal at
`effective_at = processed_at + 60 s` exactly. **Total created→terminal ≈ 117–119 s (~2 min) for
`paid` and `failed_*` outcomes.**

## 9. Scenario C timing — and the headline M0 finding

**OBSERVED (3 full runs — reversed_insufficient_funds ×2, reversed_customer_dispute ×1; both
`balance_check` settings; both seeded accounts; fresh and reused paykeys; 5 s polling; event-level
`status_history` checked; re-fetched up to 5.5 h later): `reversed_*` charge outcomes NEVER
surface `paid` or `reversed`.** The lifecycle is
`created → scheduled → pending(×3 history events) → failed`, with the reversal's R-code on the
**`failed`** terminal. This directly contradicts Straddle's own sandbox guide
(docs.straddle.com/guides/resources/sandbox-paybybank.md), which promises `paid` then, "minutes
later", `reversed`. **Scenario C's required paid→reversed ordered observation is currently
impossible against the live sandbox** — see §12 item 1 for the forced spec decision.

Measured sequence (run 1, `reversed_insufficient_funds`, representative of all three):

| status (history event) | +elapsed | Δ prev | reason / source / code |
| --- | --- | --- | --- |
| created | +0.0 s | — | ok / system |
| scheduled | +2.6 s | 2.6 s | ok / system |
| pending — "originated to network" | +49.3 s | 46.7 s | ok / system (== `processed_at`) |
| pending — "posted to the customer's bank" | +109.2 s | 59.9 s | ok / system (== `effective_at`) |
| pending — "received from the customers bank" | +110.0 s | 0.8 s | ok / system |
| **failed** | **+351.0 s** | **240.9 s** | insufficient_funds / bank_decline / **R01** |

- **created → paid:** unobservable on reversed_* charges. For `sandbox_outcome: "paid"` it is
  **~117 s** (terminal lands at the same instant as the "received" event).
- **paid → reversed window:** **UNOBSERVABLE.** The measured analog: the reversal-style terminal
  lands a **deterministic 240.9–242.9 s after the "received" pending event** (~4 min simulated
  reversal window) across all three runs. Total created→terminal 331–351 s (~5 m 50 s).
- The only observable difference between `failed_insufficient_funds` and
  `reversed_insufficient_funds` is timing (~2 s vs ~241 s after "received") — identical terminal
  status/reason/source/code. An evaluator cannot distinguish them by terminal payload alone.
- **Pre-paid status (fast-latch trigger): `pending`.** Latch fast mode on the first `pending`
  observation (optionally: pending with `effective_at` in the past).
- **Recommended PollPolicy numbers:** `baseMinMs 15000` / `baseMaxMs 30000` (fine vs the ~60 s
  minute-tick cadence), **`fastMs 5000`** (oversamples the ~241 s window ~48×; even a real
  paid→reversed flip per the docs could not plausibly be missed, and `status_history` recovers
  missed intermediates anyway), `hardTimeoutMs 600000` (comfortably above the 351 s worst case).
  Process-wide 250 ms rate floor stands.

**Destructive sandbox state discovered (OBSERVED):** after an R05 (`reversed_customer_dispute`)
return settled, (a) the same paykey watchtower-fails all new charges in ~7 s with
`reason: "invalid_paykey"`, `code: "R05"`; (b) POST `/v1/bridge/bank_account` with the same
routing+account returns 422: creating new paykeys with account `123456789` is blocked (still
blocked ≥6 h later). Account `987654321` works. R01 returns do not poison. Rules in §5/§7.

## 10. Scenario E refusal

- **Refused action: `create_paykey`.** POST `/v1/bridge/bank_account` for a customer with
  `status: "rejected"` returns **HTTP 422** (SDK `UnprocessableEntityError`). `create_charge` is
  **structurally unreachable** as a refusal point — a charge requires the paykey token, and no
  paykey can exist for a rejected customer. Spec resolution: `api_refusal.afterAction =
  "create_paykey"`, `ApiRefusal.attempted_action = "create_paykey"`, `http_status = 422`. Keep
  `"create_charge"` in the enum for stability; no A–E scenario produces it.
- **Deterministic (OBSERVED 3×):** with `config.sandbox_outcome: "active"` (twice, fresh
  `Idempotency-Key` + `external_id`) and with no `config` at all — byte-identical `error` objects,
  208–440 ms. Sandbox forcing does not bypass the check. Immediate throw; no poller involvement.
- **Error body (verbatim):**

```json
{ "error": { "status": 422, "type": "/validation_error", "title": "Validation Failed",
             "detail": "Cannot create paykey as customer is rejected." },
  "meta": { "api_request_id": "…", "api_request_timestamp": "…" },
  "response_type": "error" }
```

- **The refusal is NOT self-describing** — same 422 / `/validation_error` / "Validation Failed"
  as generic field-validation errors; no refusal code exists. Distinguishers (OBSERVED):
  `error.items` is **absent** (generic validation 422s have `items: [{reference, detail}]`) and
  `error.detail` is a single business-rule sentence. **Evaluator assertion recipe:** caught error
  from the paykey-create step with `status === 422` AND `error.items` absent AND `error.detail`
  matches `/customer is rejected/i`. 422 is non-retryable — the client wrapper must throw
  immediately (Scenario E depends on it).
- Scenario E cost: ~2 s, 3 requests (create rejected customer → GET review → refused paykey
  attempt). The rejected gate asserts customer `status === "rejected"` (never
  `identity_details.decision`, per the §6 quirk). The refusal body contains no PII/secret echo,
  but is still redacted like any response body.

## 11. Redaction field inventory

**Field names to mask by name at any nesting depth, in arrays, requests AND responses**
(server pre-masks many response fields; mask again as defense in depth):

- `account_number`, `routing_number` — bridge create request (both raw), paykey
  `bank_data` (account masked to last-4 by the server, **routing returned UNMASKED**)
- `tan` — POST `/v1/bridge/tan` (unused by us; mask anyway)
- **`paykey`** — the token; a credential-like value. UNMASKED in the bridge create response;
  Straddle masks it in charge responses. Not in the spec's original inventory — must join it.
- `ssn`, `ein`, `dob` — `compliance_profile.*` (if ever sent)
- `ip_address` — `device.ip_address` (raw in our requests; server-masked in responses)
- PII fields: `name`, `email`, `phone` (customer create/GET, charge GET `customer_details`),
  `address.{address1,address2,city,state,zip}`,
  `compliance_profile.{legal_business_name,website,representatives[].{name,email,phone}}`
- `metadata.*` (arbitrary user kv)

Safe to keep: `label`, `institution_name` (public bank name + last-4), `external_id` (= run_id).

**Key-like / auth material:** the `authorization` request header (any casing) and the API key
value itself — in headers, URLs, query params, JSON bodies, and error echoes. The instrumented
fetch never serializes request headers into events at all — it emits only method, path, status,
latency, attempt, and redacted bodies. The 401 has an empty body, so no key echo was observed
anywhere; redact for it regardless.

**Canary inputs (per spec §8):** `STRADDLE_API_KEY` from the environment + the §7 SEEDED_BANK
constants (`021000021`, `123456789`, `987654321`) from `shared/src/constants.ts`.

## 12. Deviations from spec assumptions

1. **Spec §2/§6/§16 — Scenario C ("must observe `paid` and later `reversed`") is currently
   impossible live** (§9): `reversed_*` outcomes terminate as `failed` with the reversal R-code
   after a deterministic ~4-minute post-settlement delay, never surfacing `paid` or `reversed` —
   contradicting Straddle's own sandbox docs. Spec must decide: (i) accept
   `failed` + expected-R-code + the ~241 s reversal-window delay as C's live evidence (documented
   deviation), and/or (ii) keep the `ordered_statuses ["paid","reversed"]` contract and demo C
   via the mock client/replay. Recommend both: contract unchanged, mock-driven demo, live C
   downgraded to the timing-evidence assertion, re-checked with one charge before Wave 2 exit
   (webhook-only signaling of the reversal is not ruled out — this project polls).
2. **Spec §6 PollPolicy — `fastMs` "finalized from M0's paid→reversed window":** that window is
   unobservable; `fastMs 5000` stands, justified by the measured ~241 s analog instead (§9).
3. **Spec §5 `IdentityReviewSummary`** assumes flat `risk_score`/`correlation_score` — real shape
   nests per-module scores under `identity_details.breakdown`; use the §6 mapping.
4. **Scenario E "rejected review" gate:** sandbox `identity_details.decision` is `"accept"` even
   for rejected customers — the gate must key on customer `status === "rejected"` (§6 quirk).
5. **Spec §5/§6 `api_refusal` "M0 picks":** resolved to `create_paykey` (§10). Design §6.2's
   evidence-row copy "charge refused: 4xx" must read "paykey refused: 422".
6. **Spec §9 `/api/health` `error_body?` and design §6.4 invalid-key screen:** the 401 has an
   **empty body** — there is no error body to show verbatim; render the status line / SDK message
   (`401 status code (no body)`) instead.
7. **Spec §6 "Retry-After honored":** keep honoring it if present, but no `Retry-After` (or
   `X-RateLimit-*`) header was observed on any response — the retry policy cannot depend on it.
8. **Spec §6 scenario flow step 3:** customer review settles **synchronously** (inline
   processing) — the generic poller is not needed for customers, only charges.
9. **Spec §6 scenario flow step 5:** charge create **requires `config.balance_check`**, and
   `"required"` breaks every scenario on balance-less bank_account paykeys — pin
   `config.balance_check: "disabled"` in scenario definitions (§8 trap).
10. **Spec §5 `RequiredObservation` B `returnCode`:** return codes live at
    `data.status_details.code`, are absent (not null) when inapplicable, and watchtower failures
    share `reason` with bank declines but carry no code — extraction keys on `source` (§8).
11. **Spec §5 SEEDED_BANK as static constants:** seeded accounts are **mutable sandbox state** —
    `123456789` is R05-blocked on this key. Constants must carry both account numbers with
    `987654321` preferred, and scenarios must avoid R05-producing outcomes (§5/§9).
12. **Spec §6 scenario flow steps 2–4 (fresh resources per run) is mandatory, not stylistic** —
    dispute returns poison reused paykeys (§9).
13. **Error envelope:** errors live under a top-level `error` key (not `data`) — affects
    `ApiRefusal.error_body` capture and redaction paths (§4).
14. **Validation failures arrive in two shapes** (400 `/bad_request` PascalCase refs; 422
    `/validation_error` lowercase refs) — both non-retryable; match references case-insensitively
    (§4).
15. **Timestamps:** GET customer/review resource timestamps are second-precision with no offset;
    `api_request_timestamp` has 7-digit fractional seconds — shared Zod schemas must use lenient
    datetime validation, never the default `z.string().datetime()` (§4).
16. **SDK default sandbox host is `sandbox.straddle.com`**, not the pinned
    `sandbox.straddle.io` (both work) — always pass `baseURL` explicitly (§1).
17. **DTOs must tolerate unknown response fields** — GET charges return fields absent from SDK
    types (§4).
18. **R02 (ClosedBankAccount) ALSO poisons the seeded account — extends §12 item 2 / spec §18.2**
    which documented only R05 and asserted "R01 returns do not poison." A settled
    `failed_closed_bank_account` (R02) blocks new paykey creation on that routing+account with 422
    "…blocked due to return code R02 (ClosedBankAccount)…". As a result **both** documented seeded
    accounts are now blocked (`123456789`=R05, `987654321`=R02). VERIFIED escape: **arbitrary
    (never-seeded) account numbers create working paykeys** — the outcome is forced by
    `sandbox_outcome`, account-independent. Recommendation (a code change, not this docs PR):
    generate a random per-run account number with routing `021000021` instead of the shared
    `SEEDED_BANK.preferred_account_number`; this sidesteps R02/R05 poisoning AND unblocks the live
    A–E suite, which otherwise 422s on paykey create until the block expires. See §P14. (Duration of
    the R02 block UNVERIFIED; R05 persisted ≥6 h.)
19. **Manual `PUT /cancel` yields a real `cancelled` status** — spec §18.8's "no observed sandbox
    path yields `cancelled`" holds only for `sandbox_outcome` forcing; the cancel *action verb*
    produces a genuine terminal `cancelled` (reason `user_request`, source `user_action`). Enables a
    true-`cancelled` teaching scenario and could strengthen Scenario D. See §P11.
20. **Charge action endpoints verified live** (hold/release/cancel), not just SDK-source — see §P11.
    Notable: release resumes to `created` (not `paid`); release on a not-held charge is a 200
    no-op; any action on a terminal charge → 422; two mutations in quick succession on one charge
    can return a transient **500 "Concurrency error for AggregateEventFields"** (retryable).
21. **Payouts are available on this sandbox key** — POST `/v1/payouts` → 201 (spec treated payouts
    as an unprobed P2 lane). No `config.balance_check` and no `consent_type` (charges-only);
    `sandbox_outcome`/`status`/`source` enums identical to charges. Payout lifecycle timing
    UNMEASURED. See §P13.
22. **Inbound webhooks are Svix / Standard Webhooks and dashboard-configured** — there is no
    webhook-management API on `sandbox.straddle.io` (all guesses return a router HTML 404). Signing
    uses headers `webhook-id` / `webhook-timestamp` / `webhook-signature` (HMAC-SHA256 over
    `id.timestamp.rawBody`, `whsec_`-prefixed base64 secret). Charge reversals are delivered via the
    generic `charge.event.v1`, not a dedicated event. Live delivery/verification is UNVERIFIED
    without dashboard endpoint config + a public tunnel. See §P12; resolves spec §18.1's
    "webhook-only reversal" question only partially (path exists; sandbox emission unconfirmed).

## 13. 15-minute Run All budget arithmetic

Measured per-scenario worst cases (concurrent web execution; each scenario ≈ 3 creates + polls):

| Scenario | Path | Measured / estimated wall time |
| --- | --- | --- |
| A | customer(sync ~1.5 s) + paykey(sync ~0.8 s) + charge → `paid` | **~2.0 min** (117–119 s charge + ~2.5 s setup) |
| B | same + charge → `failed` R01 | **~2.0 min** |
| C | same + charge → reversal-style terminal | **~5.9 min** (331–351 s observed; deterministic) |
| D | same + charge → `cancelled_*` | **UNMEASURED** — bounded: watchtower-style early cancel ≈ 10 s, full-lifecycle worst ≈ C's ~6 min; assume ≤ 6 min until probed |
| E | rejected customer + refused paykey | **~2 s** (3 requests, no polling) |

Concurrent Run All is dominated by the slowest scenario: **worst case ≈ 6 minutes** (C, or D if
it were reversal-shaped) — comfortably inside the PRD's ~15-minute budget with >2× headroom, even
adding a minute of jitter for missed minute-ticks and poll granularity. Request volume: ~15
creates + (worst case, C at `fastMs` 5 s from first `pending`) ≈ 60 polls for C + ~10–20 each for
A/B/D on the 15–30 s base cadence ≈ **~130 requests total across a full Run All** — trivial under
the 250 ms process-wide rate floor (which caps at 4 req/s). If the sandbox's documented
paid→reversed behavior ever materializes, C grows by the reversal window (~4 min analog) to
~10 min — still inside budget.

Serial CLI execution (P1) would sum to ~16 min worst case — over budget; concurrency is
load-bearing, as the spec already assumes.

---

## P2 API truth refresh (2026-07-08)

Second live pass for the P2 lanes (charge actions, F/G/I scenarios, webhooks, payouts). Same
legend and discipline as above; all live evidence in `spike/captures/` (gitignored). Per-topic
scratch notes in `spike/notes/p2-*.md`. New deviations are folded into §12 (items 18–22). SDK facts
are read from `@straddlecom/straddle@0.3.0` types/source (the package is installed); everything
marked OBSERVED was exercised against `sandbox.straddle.io` this pass.

### P11. Charge action endpoints (hold / release / cancel) — OBSERVED

All three are **PUT** (confirmed from SDK source AND exercised live). Body is
`{ "reason"?: string | null }` — **optional** (empty `{}` accepted). `Idempotency-Key` accepted
(UUID). The user-supplied `reason` is echoed verbatim into `status_details.message`.

| Action | Path | From-state → result |
| --- | --- | --- |
| hold | `PUT /v1/charges/{id}/hold` | `created`/`scheduled` → **`on_hold`** (reason `user_request`, source `user_action`) — 200 |
| release | `PUT /v1/charges/{id}/release` | `on_hold` → **`created`** (RESUMES the pipeline, NOT straight to `paid`) — 200 |
| release | `PUT /v1/charges/{id}/release` | `created` (not held) → **200 no-op** (status unchanged) — not an error |
| cancel | `PUT /v1/charges/{id}/cancel` | `created` → **`cancelled`** (reason `user_request`, source `user_action`) — 200 |
| cancel | `PUT /v1/charges/{id}/cancel` | `on_hold` → **`cancelled`** (history `created → on_hold → cancelled`) — 200 |
| any | hold/release/cancel | on a **terminal** charge → **422** `"Unable to change status of a cancelled payment."` |

- **Two ways to reach `on_hold`:** (a) the manual `hold` action above, and (b) the
  `sandbox_outcome: "on_hold_daily_limit"` charge, which lands an **automatic** `on_hold` (reason
  `amount_too_large`, source `watchtower`, no code, message *"Held for sandbox simulation of amount
  being above daily limit."*). `release` works on the watchtower-held charge too (→ `created`).
- **Transient 500 concurrency error:** firing two mutations back-to-back on the same charge
  (cancel immediately after hold) returned **`500` `{error:{... detail:"Concurrency error for
  AggregateEventFields - <id>"}}`**. It is a race, not a rule — the retry succeeded (`on_hold →
  cancelled`). The §6 error model already treats 5xx as retryable; the H runner should also space
  successive actions on one charge.
- **Manual cancel = a real `cancelled` terminal** (deviation §12.19). This is the only observed way
  to reach charge status `cancelled` (no `sandbox_outcome` does — spec §18.8).
- Scenario **H** shape: create (`paid`, `balance_check: "disabled"`) → `hold` → observe `on_hold` →
  `release` → `paid` (or `cancel` → `cancelled`). Fast (no long poll needed to demonstrate the
  hold/release transitions). **GO** for mock + live.

### P12. Webhooks — Svix / Standard Webhooks; dashboard-configured

- **No webhook-management API on the sandbox host.** `GET /v1/webhooks`, `/v1/webhook_endpoints`,
  `/v1/event_subscriptions`, `/v1/subscriptions`, `/v1/notifications`, `/v1/events`, `/v1/endpoints`
  all return a **router-level HTML 404** (not the JSON `error` envelope that a real resource-404
  returns), i.e. those routes do not exist on the API. The SDK client (`@straddlecom/straddle`) has
  **no webhooks resource** either. Endpoint registration is **dashboard-only** (Developers →
  Webhooks: add a URL you control, select event types, receive a `whsec_` signing secret). Docs
  mention custom API management workflows, but no such endpoint is reachable on this key
  (UNVERIFIED / likely platform-tier).
- **Signing (VERIFIED from docs.straddle.com/webhooks/security/manual):** this is the **Standard
  Webhooks / Svix** scheme. Headers on every delivery: **`webhook-id`**, **`webhook-timestamp`**,
  **`webhook-signature`**. Algorithm **HMAC-SHA256** over the exact string
  `` `${webhook-id}.${webhook-timestamp}.${rawBody}` `` — the **raw** request body, un-reserialized.
  The secret is `whsec_<base64>`; key bytes = base64-decode the part after `whsec_`
  (`Buffer.from(secret.split('_')[1], "base64")`). `webhook-signature` is a space-delimited list of
  `v1,<base64sig>` entries. Reject if `webhook-timestamp` is more than ~5 min from now (replay
  guard). **Never accept an unsigned live webhook** (spec P2-3 risk).
- **Event types (VERIFIED list, all `.v1`-suffixed):** `charge.created.v1`, `charge.event.v1`,
  `payout.created.v1`, `payout.event.v1`, `customer.created.v1`, `customer.event.v1`,
  `paykey.created.v1`, `paykey.event.v1`; plus platform/embed: `account.created.v1`,
  `account.event.v1`, `linked_bank_account.created.v1`, `linked_bank_account.event.v1`,
  `representative.created.v1`, `representative.event.v1`, `capability_request.created.v1`,
  `capability_request.event.v1`. **Charge reversals arrive under the generic `charge.event.v1`**
  ("successful processing, failures, fraud detections, settlement status"), NOT a dedicated
  reversal event.
- **Polling alternative:** Straddle exposes a **Svix per-endpoint poller URL**
  `https://api.us.svix.com/api/v1/app/{app_id}/poller/{poll_id}` (bearer), returning
  `{ "data": [], "iterator": "…", "done": false }`. This is Svix, not `straddle.io`. Not usable
  without a configured endpoint.
- **Source IPs (allowlist, US region, VERIFIED):** `44.228.126.217`, `50.112.21.217`,
  `52.24.126.164`, `54.148.139.208`, `2600:1f24:64:8000::/56` (full list at the docs
  `webhooks-ips.json`; sandbox vs prod not differentiated).
- **Payload envelope — UNVERIFIED.** The docs show no sample body; the Standard Webhooks convention
  is a body carrying the event `type` plus the resource data. Capture a real delivery (Svix
  debugger or a tunnelled endpoint) before building a strict parser; build tolerant.
- **§18.1 open question (reversal webhook-only?) — PARTIALLY resolved.** A reversal *would* be
  delivered via `charge.event.v1` if the sandbox fires one; whether the sandbox actually emits a
  `reversed` status over webhook that polling (`GET charge`) never surfaces is **UNVERIFIED** —
  it needs a live delivery to a configured endpoint (dashboard + public tunnel), unavailable here.
  Polling stays authoritative (spec P2 principle).
- **Go/no-go:** webhook **contract + receiver + correlation + fixtures/replay: GO** (fully testable
  offline with synthetic signed payloads). **Live delivery gate: BLOCKED** here — requires
  dashboard endpoint config + a public tunnel. Implement fixture/mock-first behind an explicit
  "unsigned-fixture" flag; keep live acceptance signature-gated.
- **Redaction impact:** webhook bodies carry charge/payout/customer/paykey resource data → the
  full §11 inventory applies (paykey token, account/routing, `device.ip_address`, PII). Add the
  `whsec_` secret and the three `webhook-*` headers (+ raw signature) to redaction/canary. The
  **raw body must be retained for signature verification, then redacted before capture** — the one
  ordering subtlety for the receiver.

### P13. Payouts — available; GO

- **POST `/v1/payouts` → 201** on this sandbox key (status `created`). Payout capability is present
  (spec had this UNPROBED). `GET /v1/payouts` (list) → 405 (create-only there).
- **Full surface** (SDK-confirmed; create OBSERVED): `POST /v1/payouts`, `GET /v1/payouts/{id}`,
  `PUT /v1/payouts/{id}/{cancel,hold,release}`, `PUT /v1/payouts/{id}` (update), plus a `resubmit`
  method. Never call `GET /v1/payouts/{id}/unmask` (raw PII).
- **Create body (differs from charges):** `{ amount (cents), currency: "USD", description,
  device:{ip_address}, external_id (unique), paykey (token), payment_date: "YYYY-MM-DD",
  config?:{sandbox_outcome?}, metadata? }`. **No `config.balance_check`** and **no `consent_type`**
  (both charges-only) — the §8 balance-check trap does not apply to payouts.
- `config.sandbox_outcome` enum is **identical to charges** ("Payment will simulate processing if
  not Standard"); `status` enum identical (`created|scheduled|failed|cancelled|on_hold|pending|
  paid|reversed`); `status_details.source` identical. A payout is money OUT — the charge `reason`
  enum's `payout_refused` is the payout-side decline.
- **Response shape mirrors `ChargeV1`** (OBSERVED): `data` keys `amount, config, created_at,
  currency, description, device, external_id, funding_ids[], has_resubmit, id, is_refund,
  is_resubmit, paykey, payment_date, status, status_details, status_history, trace_ids, updated_at`.
  `paykey` is **masked in the response** (like charges), `device` masked. No `customer_details` PII
  block in the create response.
- **Timing UNVERIFIED** — a payout was not polled to terminal; likely mirrors charges (~117 s for
  `paid`) but not measured. Measure before putting payouts in any timed budget.
- **Redaction impact:** same field inventory as charges (§11) — no NEW sensitive field names. DTOs
  must tolerate payout-only keys `funding_ids`, `is_refund`, `is_resubmit`, `has_resubmit`
  (non-sensitive). Add payout create/response bodies to redaction fixtures for the `paykey`/`device`
  masking paths.
- **Go/no-go:** **GO** (P2-4). Smallest useful path: create(`paid`) → poll → report, mock-first; UI
  its own evidence card / wire tab, never on the charge rail.

### P14. F/G/I scenario decisions + new charge outcomes — OBSERVED

New `sandbox_outcome` behaviors measured this pass (all `balance_check: "disabled"`):

| sandbox_outcome | terminal | reason / source / code | timing | poisons account? |
| --- | --- | --- | --- | --- |
| `failed_closed_bank_account` | `failed` | `closed_bank_account` / `bank_decline` / **`R02`** | ~117 s (like B) | **YES (R02)** |
| `reversed_closed_bank_account` | `failed` | `closed_bank_account` / `bank_decline` / **`R02`** | ~332 s; `created→scheduled→pending×3→failed`; **never** `paid`/`reversed` (same §18.1 deviation) | **YES (R02)** |
| `on_hold_daily_limit` | `on_hold` (non-terminal) | `amount_too_large` / `watchtower` / (no code) | immediate | no |
| `standard` | (stuck) `scheduled` | `ok` / `system` | still `scheduled` >6 min, never reached `pending` — does not accelerate (awaits real ACH timing); terminal UNVERIFIED | n/a |

- **R02 poisoning (deviation §12.18, the headline of this pass).** After
  `failed_closed_bank_account` settled, POST `/v1/bridge/bank_account` for the same routing+account
  returned **422** *"This bank account has been blocked due to return code R02 (ClosedBankAccount).
  Creating new paykeys with this bank account is not allowed."* So **R02 poisons like R05** —
  spec §18.2 only knew R05. Both seeded accounts are now blocked on this key
  (`123456789`=R05, `987654321`=R02). **The escape hatch is VERIFIED:** paykeys created with
  arbitrary never-seeded account numbers (e.g. `44xxxx1122`, `77xxxx0011`) + routing `021000021`
  come back `active` and charge normally — because the outcome is forced by `sandbox_outcome`,
  account-independent (docs confirm; observed). **Engine recommendation (code change, not this
  docs PR):** generate a **random per-run account number** (routing `021000021`) rather than the
  shared `SEEDED_BANK.preferred_account_number`. This both (a) makes closed-bank-account scenarios
  repeatable and (b) unblocks the live A–E suite, which will otherwise 422 on paykey create now
  that `987654321` is R02-blocked. Flag to the integrator; `SEEDED_BANK`/redaction-canary handling
  of the seeded values stays as-is for the canary list.
- **Recommended mapping** (final letters are the P2-2 contract PR's call):
  - **F = `failed_closed_bank_account`** → `failed` + **R02**. Teaching value: a second ACH decline
    code beyond B's R01; fast (~2 min). **GO** mock + live — must use a fresh random account.
  - **G = `reversed_closed_bank_account`** → reversal-shaped R02; same live deviation as C (mock/
    replay demonstrate `paid→reversed`; **live** asserts `failed` + R02 + the ~241 s reversal-window
    delay). **GO** mock/replay + live-as-deviation — fresh random account.
  - **I = manual-cancellation** → a real terminal `cancelled` via `PUT /v1/charges/{id}/cancel`
    (deviation §12.19). Clean, fast, teaches the action verbs and the true `cancelled` status that
    no `sandbox_outcome` reaches. **RECOMMENDED** over `standard` (which is not demo-friendly:
    stuck `scheduled`, no acceleration).
  - **H = hold/release** — see §P11.
- All new live scenarios keep the §18.1/§18.8 pattern: the mock/replay demonstrate the intended
  contract; live asserts what the sandbox actually did, documented as a deviation where they differ.

---

## Brand calibration (design.md D0)

Pending — to be filled by the D0 step before Wave 4 styling (sample `--brand-*` values from
straddle.com and the dashboard; record hexes + capture date here). Until then the design.md
fallback tokens ship.
