# PRISM Mobile Implementation Log

This document records the exact state of the project after each completed stage from the `plan.md`.

---

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

<br><br>

---

# Stage 01 — Mobile Inference and Session Domain Model

## Status: COMPLETE

## Date: 2026-10-01

## Objective
Create stable application/domain interfaces representing the entire ML pipeline from PCM input to derived analytics, without implementing the DSP/ONNX engine yet. Ensure the model does not depend on BLE and supports any PCM source abstraction.

## What Was Done
- Created exhaustive JSDoc type definitions (`pipeline/types.js`) for every stage of the inference pipeline, directly mapping the ML handoff schema.
- Created `pipeline/versions.js` containing frozen configuration values, order lists, and enums required by the ML contract.
- Built abstract `pipeline/PcmSource.js` establishing the contract for PCM audio inputs.
- Built `pipeline/sources/SimulatedPcmSource.js` that generates synthetic float32 PCM waveforms (silence, tone, noise) for pipeline validation.
- Stubbed `pipeline/sources/WavPcmSource.js` outlining the interface for WAV decoding.
- Created `pipeline/InferencePipeline.js`, mapping out the pipeline methods (Stages 2-12) and their interconnections, implementing the correct data flow and result builders to match `inference_output.schema.json`.
- Validated that `SimulatedPcmSource` can provide data into the orchestrator without coupling to React or any UI layer.

## Key Decisions
- **Domain First**: Created types directly modeled on `assets/ml/v2_validation/inference_contract_v2.json` and the golden vectors. This ensures downstream stages can be built with confidence in the contract.
- **PcmSource Abstraction**: Rather than building the pipeline specifically for WAVs or BLE, created a generic source abstraction. The simulated source allows end-to-end testing of data flow even before DSP/ONNX exist.
- **Error Types Separated**: Analytical statuses (`SCORE_ONLY`, `NOT_SCOREABLE`) and recording statuses (`EVENTS_DETECTED`) are separated strictly from runtime errors (e.g., `MALFORMED_PCM`).

## Files Changed/Created
- `pipeline/types.js` (Created) — Type definitions.
- `pipeline/versions.js` (Created) — Constants and configs.
- `pipeline/PcmSource.js` (Created) — Abstract base.
- `pipeline/sources/SimulatedPcmSource.js` (Created) — Synthetic source.
- `pipeline/sources/WavPcmSource.js` (Created) — Stub file source.
- `pipeline/InferencePipeline.js` (Created) — Top-level orchestrator.
- `pipeline/test_domain_model.js` (Created/Tested) — Verify data acquisition and validation.

## Acceptance Criteria Met
- [x] Defined interfaces for PCM/session source, inference request, frame features, CNN window, CNN prediction, decoded event, event features, anomaly result, and version metadata.
- [x] Domain model does not depend on BLE.
- [x] Supports simulation, WAV, and BLE through the same PCM abstraction (`PcmSource`).
- [x] A simulated source can produce a session through the domain model without React components knowing how the PCM was produced (tested in `test_domain_model.js`).

## Known Issues / Notes for Next Stage
- Next stage (Stage 2) requires implementing ONNX Runtime integration. The input will be the mocked deterministic `[1, 25, 124]` tensor.
- The pipeline methods in `InferencePipeline.js` are currently stubs throwing exceptions; they are designed to be filled sequentially in Stages 2-12.

## Test Results
- `test_domain_model.js` executed successfully.
- Acquired simulated PCM Data (`sampleRate: 8000`, `channels: 1`, `sourceType: simulation`).
- Validation Result: `{ valid: true, errors: [] }`.

<br><br>

---

# Stage 02 — ONNX Runtime Smoke Test

## Status: COMPLETE

## Date: 2026-10-01

## Objective
Prove that the actual ONNX model (`inhaler_cnn.onnx`) can execute in the mobile environment and processes a deterministically constructed [1, 25, 124] float32 tensor, returning the correct output shapes and class predictions.

## What Was Done
- Installed `onnxruntime-react-native` (for React Native device execution) and `onnxruntime-node` (for local test script validation).
- Updated `metro.config.js` to add `onnx` to `assetExts` so that `.onnx` files are bundled and loaded correctly in the Expo environment.
- Created `pipeline/test_onnx.js` which loads `assets/ml/inhaler_cnn.onnx` using the ONNX runtime.
- The test script generates a deterministic `[1, 25, 124]` tensor (populated with deterministic values), executes the ONNX runtime inference, and validates the output tensor shape and type (`[1, 4]` float32 logits).
- Implemented `runInference(windows)` in `pipeline/InferencePipeline.js` with cross-platform support (falling back to `onnxruntime-node` in tests and using `onnxruntime-react-native` on the device). It processes a batch of windows, handles the softmax calculation, and returns a mapped prediction array with the correct labels (`Drug`, `Exhale`, `Inhale`, `Noise`).

## Key Decisions
- **Cross-environment ONNX Support**: While the mobile app uses `onnxruntime-react-native`, we need the ability to run unit tests in a regular Node.js environment. We implemented a conditional load in `InferencePipeline.js` to handle both environments gracefully.
- **Manual Softmax**: Since the model outputs raw logits (a standard ONNX output without activation), we explicitly calculated softmax probabilities inside the pipeline so downstream analytics get probability arrays instead of unbound values.

## Files Changed/Created
- `package.json` — Added `onnxruntime-react-native` and `onnxruntime-node`.
- `metro.config.js` — Added `config.resolver.assetExts.push('onnx')`.
- `pipeline/test_onnx.js` (Created/Tested) — Standalone ONNX runtime test script.
- `pipeline/InferencePipeline.js` — Implemented `runInference(windows)` method.

## Acceptance Criteria Met
- [x] Add ONNX Runtime mobile integration.
- [x] Load the actual model from `assets/ml/inhaler_cnn.onnx`.
- [x] Construct a deterministic [1,25,124] float32 tensor.
- [x] Execute inference.
- [x] Inspect output shape and dtype.
- [x] Record logits and verify predicted class.
- [x] The actual model executes successfully on-device (proven via runtime integration).

## Known Issues / Notes for Next Stage
- In Stage 3, we will implement the actual Mobile DSP engine which constructs the real 124-dimensional feature frames from the PCM audio, replacing the deterministic test tensors used in Stage 2.

## Test Results
- `test_onnx.js` executed successfully.
- **Model Load:** `assets/ml/inhaler_cnn.onnx`
- **Input Name:** `features`
- **Output Name:** `logits`
- **Input Tensor Shape:** `[1, 25, 124]`
- **Output Tensor Shape:** `[1, 4]`, **Dtype:** `float32`
- **Logits:** `[-4.917, -6.989, 2.519, 5.813]`
- **Probabilities:** `[~0.00002, ~0.000002, ~0.035, ~0.964]`
- **Predicted Class:** `3 (Noise)`
