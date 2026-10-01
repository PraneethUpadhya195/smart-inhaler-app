# Stage 00 — Repository and Contract Audit

## Status: COMPLETE

## Date: 2026-09-30

## Objective
Understand the current mobile repository, identify stale ML assumptions, align the data schema with the PRISM ARCHITECTURE.md and ML.md contracts, and establish the actual starting point for the real ML pipeline integration.

## What Was Done

### Schema Alignment (Session Document)
- Replaced the old flat session schema (`quality: int`, `errors: string[]`, `label: "Correct"|"Incorrect"`) with the PRISM schema defined in ARCHITECTURE.md §10
- New schema uses nested objects: `event_classification`, `quality_assessment`, `technique_flags`
- Removed `global_score` (0-1 float percentage) after verifying against ML.md that the ML pipeline does NOT produce a continuous quality score — it produces frame-level classifications (Drug/Inhale/Exhale/Noise) and an anomaly distance score
- Kept `deviation_score` and `deviation_flag` (aligns with the anomaly scoring pipeline in ML.md)
- Kept `composite_label` for simulation display purposes (GOOD/POOR/etc.) — noted as simulation-only, not validated clinical labels

### Files Modified
- `services/simulationService.js` — Complete rewrite to generate data matching the PRISM schema with 5 realistic clinical scenarios
- `services/sessionService.js` — Updated `startBleSession` to write new schema fields
- `services/bleService.js` — Updated callback to pass new schema fields instead of old `quality`/`errors`/`label`
- `utils/formatters.js` — Removed `formatError`/`formatScore`, added `formatMs`, `formatCompositeLabel`, `formatDeviationFlag`, `deriveIssues`
- `components/ResultBadge.js` — Now handles 5 composite labels with distinct colors
- `components/SessionCard.js` — Reads from nested `quality_assessment` object
- `screens/DashboardScreen.js` — Shows composite label, inhale duration, coordination delay
- `screens/SessionDetailScreen.js` — Full rewrite with 4 cards: Quality Assessment, Event Classification, Technique Issues, Device info
- `screens/DeviceScreen.js` — Interrupted session payload uses new schema
- `App.js` — Added warning suppressions for InteractionManager and navigation state serialization
- `README.md` — Complete rewrite with architecture, schema docs, setup instructions

### Files Created
- `components/IssueList.js` — Replaces ErrorList, derives issues from structured technique flags

### Files Deleted
- `components/ErrorList.js` — Replaced by IssueList.js

### ML Handoff Artifacts Identified
The following were identified as needed and have since been added to `assets/ml/`:
- `inhaler_cnn.onnx` — ONNX model (opset 17, ~1.15 MB)
- `v2_validation/inference_contract_v2.json` — Full pipeline contract
- `v2_validation/v2_baseline.json` — Global baseline (318 events, 18 sessions)
- `v2_validation/v2_feature_schema.json` — 4 V2 anomaly features
- `v2_validation/golden/` — Conformance test vectors

## Key Decisions

1. **No global_score**: The ML model produces frame-level class predictions, not a continuous quality percentage. The `global_score` was a fabricated concept that had no basis in the ML pipeline. Removed from all files.

2. **Keep composite labels for simulation**: Labels like "Good", "Poor", "Inconsistent" are used in the simulation UI for development purposes. These will need to be revisited before production/clinical use per §2.4 of the implementation plan.

3. **deviation_score and deviation_flag retained**: These map directly to the anomaly scoring pipeline (robust z-scores, `mean_abs_z`/`rms_z`) documented in ML.md Stages 3-8.

4. **technique_flags are simulation-generated**: `insufficient_inhale`, `late_actuation`, `missed_dose` are derived from simulated data using invented rules. The real pipeline will replace these with values derived from actual CNN event classification.

5. **Firestore clearing required**: Old sessions with the stale schema must be deleted from Firebase. The app auto-seeds new data with the correct schema on fresh start.

## Files Changed

| File | Change |
|---|---|
| `services/simulationService.js` | Complete rewrite — 5 clinical scenarios, PRISM schema |
| `services/sessionService.js` | BLE session init uses new schema fields |
| `services/bleService.js` | Callback passes new schema fields |
| `utils/formatters.js` | New helpers for ms, labels, deviation, issues |
| `components/ResultBadge.js` | 5 composite labels with colors |
| `components/SessionCard.js` | Reads nested quality_assessment |
| `components/IssueList.js` | **Created** — replaces ErrorList |
| `components/ErrorList.js` | **Deleted** |
| `screens/DashboardScreen.js` | New schema consumption |
| `screens/SessionDetailScreen.js` | Full rewrite — 4-card layout |
| `screens/DeviceScreen.js` | Interrupted session uses new schema |
| `App.js` | Warning suppressions added |
| `README.md` | Complete rewrite |

## Acceptance Criteria Met

- [x] Current implementation inspected and documented
- [x] Stale ML assumptions identified (old flat schema, fake quality score)
- [x] Schema aligned with ARCHITECTURE.md §10
- [x] Schema validated against ML.md (no global_score, anomaly is SCORE_ONLY)
- [x] Authoritative contracts identified (inference_contract_v2.json, v2_baseline.json, v2_feature_schema.json)
- [x] ML handoff artifacts added to `assets/ml/`
- [x] App compiles and runs with new schema
- [x] Existing simulation mode preserved
- [x] Files likely to change in future stages identified

## Known Issues / Notes for Next Stage

1. **Firestore must be cleared** before running with new schema — old documents cause `updateDoc()` errors with `undefined` fields.
2. **Simulation labels are not clinical labels** — "Good", "Poor", etc. are placeholders. The real pipeline produces `SCORE_ONLY` anomaly scores.
3. **technique_flags are fabricated** — real values will come from the CNN event classification pipeline.
4. **No DSP, no ONNX, no real inference** — all session data is still mock-generated by simulationService.js. Stage 1 begins the real pipeline domain model.
5. The `prism_mobile_implementation_plan.md` has been incorporated into `plan.md` as the canonical execution document.
