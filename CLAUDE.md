# Straddle Sandbox Explorer

@docs/spec.md is the source of truth for this project — architecture, contracts, wave plan, and acceptance criteria all live there. Read it before making design decisions; do not duplicate its content here.

@docs/design.md is the source of truth for all visual design decisions — tokens, typography, layout, components, motion, and copy for `web/`. Consult it before any UI/styling work.

## Working rules

- If implementation must deviate from the spec, update `docs/spec.md` (and note it in README "Deviations from spec") rather than letting code and spec drift.
- API facts (paths, headers, enums, timings) are decided by the M0 spike and recorded in `api-notes.md` — never guessed.
- Secrets and captures never enter git: `spike/`, `runs/`, `report.json`, and `.env` stay untracked; redaction happens server-side before capture.
