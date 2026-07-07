# design.md — Straddle Sandbox Explorer

Visual design specification for the single-screen Explorer UI. Companion to PRD v4 (§FR-1/FR-2, UX) and Technical Design v2 (§10). This document is the input to `web/` styling: tokens, type, layout, components, motion, and copy.

## 1. Design stance

The Explorer should read as **native to Straddle's ecosystem** — specifically as a cousin of their *dashboard*, not their marketing site. Straddle's public surfaces split into two registers: a Framer marketing site with big display headlines and animated product cards, and a working dashboard (documented at guide.straddle.com) that is a calm, light, status-forward operations tool — customer tabs, green pass checkmarks, payment statuses at a glance, return codes like R29 surfaced plainly. A sandbox lifecycle explorer belongs to the second register. The goal for the meeting: the VP should feel like they're looking at a tool their own team could have shipped, while it visibly isn't a clone of anything they did ship.

**Asset rules (non-negotiable):** do not copy Straddle's logo, logotype SVGs, or marketing imagery. The header wordmark is set in type ("Straddle Sandbox Explorer", with "Straddle" in brand weight). A footer line reads "Unofficial developer demo — not affiliated with Straddle Payments Inc." Straddle's *vocabulary* is used exactly (Pay by Bank, Bridge, paykey, Watchtower, sandbox outcomes, return codes) because API fluency is the product; their *assets* are not.

## 2. What is verified vs. what needs calibration

This spec follows the repo's M0 discipline: observed facts are stated as facts; unverifiable values are **CALIBRATE** placeholders resolved in a 15-minute step, never invented and shipped as if true.

**Verified (from straddle.com content, guide.straddle.com, and Straddle's published Bridge packages):**

- **Voice:** sentence case everywhere; short declarative headlines ("Full stack. Single purpose.", "Any bank, any time", "Compliant by default"); developer-directed, confident-plain, with occasional dry warmth ("Bank accounts work, too!"). No exclamation-free corporate mush, no title case.
- **Code as a first-class visual.** The straddle.com hero region renders a numbered code snippet as a centerpiece; the developer is the audience and the code *is* the imagery.
- **The evidence-row motif.** Straddle renders identity verification as a card of labeled check rows — "SSN is not deceased · PII", "Selfie passes liveness check · Liveness" — each fact paired with a category tag and a pass indicator. Their dashboard guide confirms the idiom: "Green checkmarks mean checks passed."
- **Light, pragmatic dashboard idiom** in their actual product surface (tabs, status chips, at-a-glance lists).
- **Their engineers build on the Tailwind palette.** The published Bridge widget packages style their own console-log labels with Tailwind's exact `teal-500 #14b8a6` (client-side logs) and `purple-500 #a855f7` (server-side logs) — a small but authentic fingerprint of internal taste, and a distinction (client vs. server) this product happens to share.

**Not verifiable from here (D0 calibration targets):** the marketing site's exact palette hexes, the brand typeface(s), and the dashboard's precise neutrals. The fetched site strips CSS, and asset/CDN fetches were blocked.

### D0 — Brand calibration (15 minutes, before Wave 4 styling)

The builder has a dashboard account (the API key came from somewhere). With browser devtools:

1. Open **straddle.com**: sample the primary CTA background, link/accent color, hero background, and headline `font-family` from computed styles. Record hexes and stacks.
2. Open **dashboard.straddle.com** (sandbox): sample the app background, card surface, border, body text color, and the success/failure status chip colors.
3. Write the values into the `--brand-*` tokens in §3 and note them in `api-notes.md` under a "Brand calibration" heading with a capture date.
4. If dashboard and marketing values disagree, **the dashboard wins** (per §1 stance).

Every `--brand-*` token below ships with a stated fallback so the app is presentable even if D0 is skipped; the fallbacks are chosen from the verified Tailwind fingerprint, not from guessed "Straddle colors."

## 3. Design tokens

Two layers, deliberately separated: the **brand layer** (calibratable, swappable in one file) and the **semantic status layer** (fixed by the PRD's payment semantics, brand-independent, never overridden by calibration). Tokens live in `web/src/styles/tokens.css` and are mapped into `tailwind.config` — components reference tokens, never raw hexes.

```css
:root {
  /* ---- Brand layer — D0 CALIBRATE; fallbacks shown ---- */
  --brand-accent:        #14b8a6;  /* CALIBRATE: primary CTA/link. Fallback: the
                                      teal Straddle's own tooling uses */
  --brand-accent-strong: #0f766e;  /* CALIBRATE: hover/active (teal-700 fallback) */
  --brand-ink:           #0f172a;  /* CALIBRATE: headline/body ink (slate-900) */

  /* ---- Surfaces (light theme; §8 for rationale) ---- */
  --surface-app:     #f8fafc;      /* slate-50 */
  --surface-card:    #ffffff;
  --surface-inset:   #f1f5f9;      /* slate-100: JSON blocks, console */
  --border:          #e2e8f0;      /* slate-200 */
  --border-strong:   #cbd5e1;      /* slate-300: selected/focused cards */
  --text-primary:    var(--brand-ink);
  --text-secondary:  #475569;      /* slate-600 */
  --text-muted:      #94a3b8;      /* slate-400: timestamps, seq numbers */

  /* ---- Semantic status layer — FIXED, encodes PRD FR-2. Do not calibrate. ---- */
  --status-inflight:    #64748b;   /* slate-500 · created/scheduled/pending/on_hold */
  --status-paid:        #16a34a;   /* green-600 · TERMINAL paid only */
  --status-provisional: #d97706;   /* amber-600 · paid while watching for reversal */
  --status-failed:      #dc2626;   /* red-600  · failed and reversed */
  --status-cancelled:   #64748b;   /* slate-500, hollow treatment (§6.3) */
  --status-pass:        var(--status-paid);
  --status-fail:        var(--status-failed);

  /* ---- Exchange-log provenance accents (verified Straddle fingerprint) ---- */
  --wire-client: #14b8a6;          /* teal-500 · our requests — matches Straddle's
                                      own client-log label color */
  --wire-server: #a855f7;          /* purple-500 · Straddle's responses — matches
                                      their server-log label color */

  /* ---- Shape, space, elevation ---- */
  --radius-card: 12px;  --radius-chip: 9999px;  --radius-inset: 8px;
  --space-unit: 4px;                     /* 4-pt grid; components use ×2..×8 */
  --shadow-card: 0 1px 2px rgb(15 23 42 / 0.06), 0 1px 3px rgb(15 23 42 / 0.10);
}
```

Rules: green appears **nowhere** except terminal success and passed assertions — not in buttons, not in decoration — so that when Scenario A lands, the single green node means something. The brand accent carries all interactive affordances (buttons, links, focus rings, the selected scenario row) precisely so it *cannot* be confused with a payment status.

## 4. Typography

**Roles (faces are D0-calibratable; fallbacks pinned):**

- **UI/body:** `Inter` (self-hosted, weights 400/500/600), fallback `system-ui`. CALIBRATE against the dashboard's stack; Inter is the fallback because it disappears into the fintech-dashboard register this product imitates.
- **Data/code:** `JetBrains Mono` (400/600), fallback `ui-monospace`. This face works hard here — it is the voice of everything the API actually said: statuses, enums, return codes, IDs, amounts, JSON, timestamps. The rule that gives the UI its character: **anything quoted from the wire is set in mono, verbatim, lowercase as the API returns it** (`reversed_insufficient_funds`, `R01`, `chg_…`). Prose describes; mono testifies.

**Scale (rem):** page title 1.125/600 · pane headers 0.8125/600, uppercase, +0.06em tracking, `--text-muted` · body 0.875/400 · data mono 0.8125 · chips & timestamps 0.75 · JSON 0.75/1.6. No display sizes anywhere — this is an instrument, not a landing page; restraint *is* the register (and per the marketing-site voice, all labels sentence case).

## 5. Layout

Implements TDD §10's single screen. Desktop-only (PRD non-goal), designed for a 13″ laptop mirrored to a projector — sizes err legible-from-a-meeting-room.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Straddle Sandbox Explorer   [sandbox]              [Run all]  header │
├────────────────┬──────────────────────────────┬──────────────────────┤
│ SCENARIOS      │ LIFECYCLE                    │ WIRE                 │
│ ┌────────────┐ │  ● created        14:02:11   │ POST /v1/customers   │
│ │ A Happy    │ │  │ +0:00                     │ 201 · 182ms          │
│ │   [paid]   │ │  ● pending        14:03:07   │ ──────────────────   │
│ ├────────────┤ │  │ +0:56                     │ POST /v1/charges     │
│ │ C Reversal │ │  ◍ paid — provisional…       │ 201 · 210ms          │
│ │   [watch]  │ │  │    watching for reversal  │ ──────────────────   │
│ │  ...       │ │  ● reversed  R01  14:06:12   │ GET /v1/charges/{id} │
│ └────────────┘ │                              │ 200 · 95ms           │
├────────────────┴──────────────────────────────┴──────────────────────┤
│ suite: 3/5 passed · report.json ↓                    summary strip   │
└──────────────────────────────────────────────────────────────────────┘
```

Columns 280px / flex / 380px, gap 16px, page padding 24px, panes are `--surface-card` cards on `--surface-app`. Header 56px: type-set wordmark, a `[sandbox]` chip (accent outline — a quiet echo of the hard-coded base-URL guard), Run all as the sole primary button. The center pane is the demo's stage and gets the visual weight; left and right panes stay quiet.

## 6. Components

### 6.1 Scenario row (left pane)

Card per scenario A–E: line 1 — letter badge (mono, 600) + name + status chip right-aligned; line 2 — one-line purpose in `--text-secondary`; line 3 — forced outcome in mono-muted (`sandbox_outcome: reversed_insufficient_funds`). Selected row: `--border-strong` + 3px accent left edge. Hover reveals a ghost **Run** button; running rows swap it for a live elapsed timer (mono). Chips (radius-chip, 0.75rem): *idle* outline-muted · *running* `--status-inflight` fill, white text · *passed/failed* pass/fail fill · *watching* `--status-provisional` fill — the chip mirrors the timeline's provisional state so Scenario C is visibly special even from the list.

### 6.2 Lifecycle timeline (center pane)

Vertical rail (2px `--border`), one node per **observed** transition — the UI never draws expected-but-unobserved states, because the entire product claim is "this is what the API actually did."

Node anatomy: 12px dot on the rail · status name in mono 600 colored by the semantic layer · wall-clock time right-aligned muted · `+m:ss` elapsed-since-previous under the name · return/reason code as a small `--status-failed`-tinted mono chip (`R01`) on terminal nodes. The in-flight bottom node shows a live ticking `+m:ss`.

**The provisional-paid node is the signature element of the whole design.** When a reversal-expecting scenario reaches `paid`: half-filled amber dot (`◍`), label `paid — provisional`, sub-line `watching for reversal…`, and a slow 2s opacity pulse on the dot. It must be impossible to read as success. When `reversed` lands, the pulse stops, the amber node **stays** (both transitions permanently visible per FR-2), and the red terminal node completes the story: settled money un-settling, on screen. Everything else in this spec is quiet so this one moment can be loud.

Terminal treatments: `paid` (non-reversal) filled green + ✓ · `failed`/`reversed` filled red + code chip · `cancelled` hollow slate ring (gray-and-empty reads "deliberately stopped" vs. red's "went wrong") with the captured reason underneath in `--text-secondary`.

For Scenario E the pane renders the **evidence-row card** instead of a rail — a direct quote of Straddle's own verification-results pattern: labeled fact rows with category tags and pass indicators (`customer status: rejected · Identity ✓` / `charge refused: 4xx · API ✓`), each row being one satisfied RequiredObservation, followed by the verbatim refusal body as a JSON block. Assertion results for all scenarios reuse this row pattern in the summary strip drill-down.

### 6.3 Wire log (right pane)

Chronological exchanges for the selected scenario. Entry header: method (mono 600) + path (mono, truncated middle) + status-code chip (2xx `--status-pass` tint / 4xx-5xx `--status-fail` tint) + latency muted. A 3px left edge in `--wire-client` teal on requests and `--wire-server` purple on responses — the provenance accent borrowed knowingly from Straddle's own Bridge logging palette; if their engineers notice, that's the point, and if nobody does it still does its job. Bodies expand to `--surface-inset` JSON blocks with muted line numbers — the numbered-snippet motif from their own homepage. Retry attempts render as indented sub-entries labeled `attempt 2 · backoff 1.4s`, making the client's 429/5xx behavior visible per acceptance criterion 7. Error bodies are never summarized, recolored, or prettified beyond formatting: verbatim JSON, exactly as testimony.

### 6.4 Startup states (full-screen, replacing the app per FR-8)

Centered single card, max-width 420px. *Missing key:* title "Add your sandbox API key"; body walks `dashboard.straddle.com → API keys` and `cp .env.example .env`; the shell command in an inset mono block with a copy button. *Invalid key:* title "Straddle rejected this key"; the auth error body verbatim in a JSON block; hint text to regenerate. *Checking:* wordmark + small spinner. Errors explain and instruct; they never apologize and never stack-trace.

### 6.5 Buttons, summary strip, toasts

One primary button style (accent fill, white text, radius 8px, 500) used only for Run all / Run / Download report.json; everything else is ghost or text style — a demo tool has no business having five button variants. Summary strip: mono suite line (`3/5 passed · 11:42 elapsed`) + report download; expands to per-scenario assertion rows (§6.2 pattern). P1 toasts (bottom-right, 4s, status-colored edge) announce transitions on unselected scenarios: `C · paid — provisional`.

## 7. Motion

Three animations total, each carrying information: (1) timeline node entry — 200ms fade + 4px rise, the heartbeat of "live"; (2) the provisional-paid pulse — 2s ease opacity 1→0.55→1, anxiety with a purpose, stops at terminal; (3) chip color cross-fades at 150ms. Nothing else moves. `prefers-reduced-motion`: entries appear instantly and the pulse becomes a static half-filled dot — the state stays legible because color+shape+label already carry it.

## 8. Theme decision: light

Light theme, no dark mode. Three reasons: it matches Straddle's actual product surface (the dashboard idiom, §2) rather than their marketing site; meeting rooms and projectors wash out dark UIs; and status colors hold AA contrast more reliably on light surfaces. Dark mode is out of scope, not a token-system limitation — the two-layer tokens would support it later.

## 9. Copy rules

Straddle's verified voice, applied: sentence case for every label and button; short declaratives; plain verbs ("Run all", "Download report.json" — never "Submit" or "Export now"). Two vocabularies, never blended: **theirs** (mono, verbatim: statuses, enums, codes, IDs — never renamed, recased, or "friendlified") and **ours** (prose: "watching for reversal…", "waiting for the sandbox processor — it runs about once a minute"). Empty states instruct: "No runs yet. Run scenario C to watch a payment settle and then un-settle." Failures state what happened and what to do, in the interface's voice.

## 10. Accessibility

AA contrast for all text including on-chip text (the token choices above pass on their assigned surfaces; re-verify after D0 calibration). Status is never color-alone: every status pairs color with the mono label, and shape differs at the extremes (filled / half-filled / hollow / ✓ / code chip). Visible 2px accent focus rings on all interactives; the scenario list is arrow-key navigable; the live timeline region is `aria-live="polite"` so transitions are announced.

## 11. Implementation notes

- `web/src/styles/tokens.css` is the single source; `tailwind.config` maps tokens to utilities (`colors: { accent: 'var(--brand-accent)', status: { paid: 'var(--status-paid)', … } }`). Components never hard-code hexes — D0 calibration must be a one-file change.
- Self-host Inter and JetBrains Mono (both OFL) in `web/public/fonts` with `font-display: swap`; no Google Fonts request from a demo that might run on conference-room Wi-Fi.
- Chip, node, and evidence-row variants key off the shared `RunEvent`/status types — the semantic layer in CSS mirrors the discriminated unions in `shared/`, one vocabulary end to end.
- Playwright visual checks (Wave 4 QA): one screenshot per timeline state including provisional-paid mid-pulse, the E evidence card, and both startup states.

## 12. Open items

1. **D0 calibration** (§2) — fill `--brand-*`, record in api-notes.md. Until then the teal-fallback identity ships coherently.
2. Whether Straddle's dashboard uses a serif or display face anywhere that matters — check during D0; adopt only if it survives the §4 restraint rule.
3. If M0 reveals additional observable statuses (e.g. `on_hold` variants), extend the semantic layer explicitly — new statuses get deliberate colors, never a default.
