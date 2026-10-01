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
