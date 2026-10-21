# Claude Implementation Log — PRISM Smart Inhaler App

> **Purpose.** This is the chronological record of work done by Claude Code sessions in this repository. Each session should be able to continue from this file alone (see `CLAUDE.md`).
>
> **Append-only.** Existing entries are never edited, reordered or deleted. When new evidence contradicts an entry, a new entry is appended that says so.
>
> **Relationship to `IMPLEMENTATION_LOG.md`.** That file is the pre-existing stage log (Stages 00–15) and is left untouched. This log is separate.
>
> **Evidence labels used in entries:**
> - **V** — verified by running code in this session;
> - **R** — read in code, not executed;
> - **U** — expected from code/API behaviour but not verified, because it needs a device, Metro bundling or Firebase.

---

# Entry 1 — 2026-10-06: Pipeline ↔ App Compatibility Audit (functionality first)

## Objective
Determine whether the app agrees with the current PRISM research pipeline, and where it does not: what the app computes, outputs, stores and displays. Functionality takes priority over UI. This entry is an audit only: no existing file was modified.

## Scope and method
- **App:** `smart-inhaler-app`, branch `ml-integration` @ `dccebb5` ("Stage 15"), clean working tree.
- **Research:** `../PRISM smart inhaler`, branch `anomaly-detection` @ `35713e8`. The authority is `results/v2_validation/inference_contract_v2.json` (`prism-inference-v2.0`, status `DRAFT_NOT_FROZEN`) and its reference implementation `src/prism_inference.py`.
- **Read:** every tracked source file in `pipeline/`, `services/`, `context/`, `screens/`, `components/`, `utils/`, plus `App.js`, `README.md`, `IMPLEMENTATION_LOG.md`, `package.json`, `metro.config.js` and `generate_dsp_constants.py`.
- **Run (V):**
  1. The app's tests: `node pipeline/test_harness.js` and the individual `pipeline/test_*.js` files, in a scratch clone with `fft.js@4.0.4` and `onnxruntime-node@1.30.0` (the lockfile versions), on Node 24.11.1.
  2. The app's `InferencePipeline.run()`, `SessionAggregator`, `generateMockSession()` and input-error paths on reference recordings (`tools/pipeline_compat/js_run.mjs integration`).
  3. The app's pipeline stages on all 361 reference recordings, compared stage by stage with the Python reference (`tools/pipeline_compat/`; see its README).
- **Not run:** Metro bundling, an Android/iOS build, Firebase and BLE. Findings that depend on them are marked **U**.

## Verdict
1. **Assets: identical.** `assets/ml/` matches the research outputs byte for byte: model, baseline, contract, schemas, golden vectors (one file differs only in line endings).
2. **Detector and events: agree.** On all 361 reference recordings (§C), the app's DSP, detector, event grouping and scoreability reproduce the research pipeline: 0 of 270,241 window labels differ; event counts, start times, confidences and not-scoreable reasons agree. Two numerical defects remain, each with a verified fix:
   - **ZCR (F7):** the ZCR frame feature uses a different zero-sign rule and differs on real 16-bit audio. It changed no detector label here.
   - **Event segment (F14):** event segments differ by one sample in 129 of 364 events, because window times are computed with a different floating-point formula. This puts 125 events' features outside tolerance and moves 11 scores by more than 0.01 (max 0.045). Reproducing the reference's time formula fixes it (verified in a scratch copy).
3. **End-to-end path: broken.** The app cannot currently produce a correct contract result from audio. As written:
   - `run()` rejects every WAV;
   - the result builders drop event times, window counts, feature values, `mean_rms` and not-scoreable reasons;
   - the simulation path throws;
   - first-launch seeding calls a function that does not exist;
   - the on-device (React Native) path depends on Node's `fs` (expected to fail on a device; not verified, F5).
4. **Output and data model: not contract-conformant.** The app's result object is a camelCase variant with missing and extra fields. Sessions in Firestore and the UI mix the new pipeline schema with the legacy GOOD/POOR / technique-flag schema. The BLE path is still entirely legacy and simulated.

## A. What agrees (verified, V)

| Check | Result |
|---|---|
| `assets/ml/inhaler_cnn.onnx` vs research `results/inhaler_cnn.onnx` | identical (SHA-256 `2e4e72d3…3725`) |
| `assets/ml/v2_validation/` vs research `results/v2_validation/` (32 files) | identical; `acceptance_gate_preregistration.json` differs only in CRLF/LF |
| Constants in `pipeline/versions.js` (window 25/2, 8 kHz, feature order, statuses, reasons, thresholds 0.5 / 0.2 / 0.008 s, contract id, baseline id) | match the contract |
| DSP constants (`generate_dsp_constants.py`: Slaney mel 128 bands 50–4000 Hz, DCT-II ortho, Savitzky–Golay orders 1/2 with `interp` edges, periodic Hann) | match librosa 0.11.0 as used by the research extractor |
| Reference recording `rec2018-01-22_17h41m49.809s` through the app stages | 1 event, 0.688–2.232 s, confidence 0.9337988 (Python 0.9337995), `anomaly_score` 0.5554652 (Python 0.5554650), z-scores within 3.3×10⁻⁷ |
| Golden synthetic cases `digital_silence_2s`, `white_noise_3s_minus20dBFS` through `run()` (with `channels` supplied) | `NO_INHALATION_DETECTED`, 0 events: same as expected |
| Golden `short_event_not_scoreable` through `run()` (with `channels` supplied) | statuses `SCORE_ONLY` / `NOT_SCOREABLE`, durations 1.768 / 0.2 s: same as expected (but the reasons are lost; F2) |
| `npm test` (`pipeline/test_harness.js`) | passes (7 stages). It tests stages in isolation with hand-built inputs and never calls `run()` or the golden vectors, so it cannot detect F1–F3, F8–F9 or F14 |
| Other `pipeline/test_*.js` | pass, except `test_dsp_parity.js`, which crashes: `pipeline/parity_data.json` is not in the repository (ENOENT) |

## B. Defects (functionality first; most severe first)

| ID | Sev | Finding | Evidence | Where | Fix direction |
|---|---|---|---|---|---|
| F1 | P0 | `WavPcmSource.acquire()` returns no `channels`, `sourceId` or `recordedAt`. `PcmSource.validate` therefore rejects every WAV: `run()` returns `INPUT_ERROR` "channels must be 1 (mono), got undefined" | V | `pipeline/sources/WavPcmSource.js:91`, `pipeline/PcmSource.js:66` | Return `channels: 1, sourceType, sourceId, recordedAt` |
| F2 | P0 | The result builders read fields that the stages do not produce. Through `run()`, every event has `startTime`, `endTime`, `windowCount`, `featureValues` and `meanRms` undefined, and NOT_SCOREABLE events have `notScoreableReasons` undefined. The mismatches:<br>• decoded events carry `startS` / `endS` / `windowPredictions`;<br>• `FeatureExtractor` returns `features` / `mean_rms`;<br>• `checkScoreability` returns `reasons` | V | `pipeline/InferencePipeline.js:288-318, 562-603`; `pipeline/FeatureExtractor.js:57` | Map the fields consistently; emit a named object for features and z |
| F3 | P0 | **Simulation is broken.**<br>• `generateMockSession()` passes a plain object to `run()`, which calls `source.acquire()`, so it throws `TypeError: source.acquire is not a function`.<br>• `DashboardScreen.handleSimulate` and `bleService.subscribeToInhalationEvents` call it without `await`, so they receive a Promise and spread it into the session (an empty document), with an unhandled rejection.<br>• It also replaces the detector with hard-coded "Inhale" windows and fake probabilities `[0.1, 0.1, 0.8, 0]` | V (TypeError, Promise); U (Firestore effect) | `services/simulationService.js:41-53`, `screens/DashboardScreen.js:30`, `services/bleService.js:139` | Wrap the samples in a `PcmSource`, `await` the calls, and label simulated outputs or remove the mocked detector |
| F4 | P0 | `sessionService.seedSampleData` calls `generateSeedSessions()`, but `simulationService` does not export it. For a fresh user (empty collection) initialisation throws, and `App.js` shows "Configuration Error / Failed to connect to Firebase" | R (missing export confirmed); U (runtime) | `services/sessionService.js:12,122` | Restore a seed function, or remove seeding |
| F5 | P0 | `FeatureExtractor` and `BaselineStore` read their JSON with Node's `fs` (`import fs from 'fs'`), and the model path is cwd-relative. React Native has no `fs`: Metro is expected to fail to resolve `fs`, or the constructors throw | R; U (Metro not run) | `pipeline/FeatureExtractor.js:1,15`, `pipeline/BaselineStore.js:1,25` | Import the JSON statically (Metro supports `.json`), or inject the parsed objects |
| F6 | P1 | **On-device ONNX loading.**<br>• `InferenceSession.create(require('../assets/ml/inhaler_cnn.onnx'))` passes a Metro asset id; onnxruntime-react-native expects a file path or bytes.<br>• `await import('onnxruntime-node')` is inside app code, so Metro may try to bundle it.<br>• onnxruntime-react-native needs a native build, but the README says Expo Go | R; U | `pipeline/InferencePipeline.js:162-183`, `package.json` | Resolve the asset to a local URI (expo-asset/FileSystem) or bytes; keep Node-only code out of the bundle; use a dev build |
| F7 | P1 | **ZCR frame feature mismatch (column 123).** The app counts a sample of exactly 0 as negative (`cur > 0` vs `<= 0`); librosa counts 0 as positive (`signbit`, after zeroing \|x\| ≤ 1e-10). Real 16-bit recordings contain many exact zeros (16,691 of 96,000 samples in `rec2018-01-22_17h41m49.809s`), so ZCR differs in most frames, by up to 77 of 2048 crossings (0.038). Reimplementing the app rule in Python reproduces its error exactly; the librosa rule gives 0 differences on that recording. The app also zero-pads where librosa edge-pads (no effect on that recording). Effect on detector labels and events: see §C | V | `pipeline/dsp.js:268-290` | `neg(v) = v < -1e-10`; crossing iff `neg(cur) !== neg(prev)`; pad with edge values |
| F14 | P1 | **Window times use a different floating-point formula from the reference,** so the event segment `[floor(start·8000), ceil(end·8000))` differs by one sample (at the end) in 129 of 364 reference events. As a result, 125 events have features and 128 events have `mean_rms` beyond tolerance, 52 z-scores differ by more than 0.01, and 11 scores by more than 0.01 (max 0.045). See §C | V | `pipeline/InferencePipeline.js:135-144` (`startTime` / `endTime`) | Compute `start = windowIndex·(2·64/8000)` and `end = Math.min(start + 25·64/8000, nSamples/8000)`, exactly as `post_event.generate_window_predictions` does. Verified: bit-identical times; all scores within 4.1×10⁻⁵ |
| F15 | P3 | `spectral_rolloff` accumulates in float64; librosa accumulates in float32. One frame's rolloff bin flipped in 1 of 364 events (feature 1.05×10⁻³ relative, z difference 0.005, within score tolerance) | V | `pipeline/FeatureExtractor.js:145-155`, `pipeline/dsp.js:116-127` | Accumulate with `Math.fround` to mirror float32, or accept and document |
| F8 | P1 | **The output does not conform to `inference_output.schema.json`.**<br>• Keys are camelCase (`recordingStatus`, `nEvents`, …) where the schema uses snake_case, and there is an extra `versions` key.<br>• `detector_model_sha256` is missing (`MODEL_SHA256` exists but is neither emitted nor checked).<br>• z-scores are a `Float64Array`, which JSON-serialises to `{"0":…,"3":…}`.<br>• `error` holds free text instead of the enum codes.<br>• There is no `amplitude_out_of_range` check (input 1.5 is accepted) and no `detector_feature_extraction_failed` path.<br>• `input_domain` is hard-coded `"unknown"` and `baseline_domain_validated` is always false.<br>• The window `endTime` is not capped at the recording duration (the contract uses `min(start + 0.2, duration)`) | V | `pipeline/InferencePipeline.js:489-621`, `pipeline/PcmSource.js` | Add an adapter that emits the exact schema object; validate against `inference_output.schema.json`; run the 9 golden cases in `npm test` |
| F9 | P1 | `SessionAggregator` reads snake_case `rec.input.recorded_at` / `recording_id`, but the pipeline emits camelCase. Result: `recordingId` / `recordedAt` are undefined, `sessionTimestamp` is the time of aggregation, and the chronological sort uses undefined `startTime` | V | `pipeline/SessionAggregator.js:26-63` | Align on one schema (the contract's) |
| F10 | P1 | **Persistence will fail.** Sessions are written to Firestore as returned. Firestore rejects `undefined` values (F2) and custom objects such as `Float64Array` / `Float32Array` (F8) | U (Firebase not run) | `services/sessionService.js:56`, `context/AppContext.js:48` | Convert to plain arrays/objects; store the contract output (research `ARCHITECTURE.md` §10) |
| F11 | P1 | **The BLE path is legacy and simulated.** `bleService`, `DeviceScreen`, and `startBleSession` / `completeBleSession` / `interruptBleSession` use the old schema (`duration`, `event_classification`, `quality_assessment`, `technique_flags`). The event is not awaited (F3). There is no BLE PCM source, packet parsing or reassembly (research `ARCHITECTURE.md` §5) | R | `services/bleService.js`, `screens/DeviceScreen.js:57-120`, `services/sessionService.js:71-110` | After hardware: add a `BlePcmSource` (int16 = s24 >> 8, 8 kHz, pre/post-trigger audio) feeding the same pipeline |
| F12 | P2 | `BaselineStore` checks only that fields are present. The contract requires refusing to score unless the baseline passes these checks:<br>• contract version and baseline id;<br>• V2 feature order;<br>• finiteness, MAD > 0;<br>• scale = 1.4826·MAD.<br>Feature order is assumed, not checked | R | `pipeline/BaselineStore.js:34-60` | Add the checks from `prism_inference.FrozenBaseline` |
| F13 | P3 | **Performance (desktop only; phone unmeasured).** ONNX is called once per window, 739 calls for a 12 s clip. On desktop Node 24, for `rec2018-01-22_17h41m49.809s` after model load, the stages took:<br>• DSP: 151 ms;<br>• ONNX: 348 ms per-window, against 303 ms for one batched `[739,25,124]` call (identical logits, max diff 0); a second run gave 473 ms against 251 ms, so desktop timings are noisy;<br>• event features: 39 ms.<br>All 361 recordings (including WAV parsing) took 486 s, concurrently with the Python run. Per-call overhead through the React Native bridge may be larger | V (desktop) | `pipeline/InferencePipeline.js:192-233`, `pipeline/dsp.js` | Measure on a device first; batching is a safe change (identical output) |

**Contract semantics in data and UI** (UI work is later, but these conflict with the research display rules, research `ARCHITECTURE.md` §9.4):

| ID | Finding | Evidence | Where |
|---|---|---|---|
| S1 | The Dashboard shows "Mean Z-Score" (actually the mean `anomaly_score`), and SessionDetail shows the anomaly score per event. While the contract is `DRAFT_NOT_FROZEN` these are internal/experimental, not user-facing | R | `screens/DashboardScreen.js:126`, `screens/SessionDetailScreen.js:71-114` |
| S2 | Legacy forbidden outputs remain:<br>• GOOD / POOR / GOOD_BUT_INCONSISTENT / ABNORMAL / MISSED_DOSE labels (`ResultBadge`, `formatters.formatCompositeLabel`, README);<br>• technique issue texts such as "Inhalation too short (< 1.0s)", "Late actuation (> 0.5s delay)", "No pre-inhalation exhale" (`formatters.deriveIssues`, `IssueList`);<br>• `deviation_flag` bands.<br>The History list (`SessionCard`) still reads `quality_assessment.composite_label` and `duration`, so pipeline sessions show "—". `ResultBadge` has no entry for the pipeline statuses either, so the Dashboard and Detail "Result" shows "—" | R | `components/ResultBadge.js:38`, `components/SessionCard.js:15`, `utils/formatters.js:47-97` |
| S3 | "Today's Doses" counts every processed recording, including `NO_INHALATIONS` and `HAS_ERRORS`, as a completed dose. A received recording is not validated evidence of a dose | R | `utils/formatters.js:102-116` |
| S4 | Session statuses `SCORED` / `HAS_ERRORS` / `EVENTS_DETECTED_NOT_SCOREABLE` / `NO_INHALATIONS` and session min/max/mean scores are app-level constructs that the contract does not define. They are acceptable internally if documented, but not as clinical summaries | R | `pipeline/SessionAggregator.js` |
| S5 | Simulated sessions use mocked detector outputs (F3) and synthetic audio. Their scores have no meaning against the reference baseline, so they must be visibly labelled as simulation everywhere they appear | R | `services/simulationService.js` |

**Documentation and tests:**

| ID | Finding |
|---|---|
| D1 | **`README.md` describes the pre-pipeline simulation app:** the GOOD/POOR schema, technique flags, "evaluates technique quality", Expo SDK 54 / RN 0.81 (`package.json` has Expo ~57 / RN 0.86.3), and Expo Go (incompatible with onnxruntime-react-native, U) |
| D2 | **`IMPLEMENTATION_LOG.md` claims that the repository does not support:**<br>• Stage 04 parity cannot be reproduced (`parity_data.json` is not committed).<br>• Stage 07 "176 windows of logits" — `wav_parity_reference.json` holds only the first and last window.<br>• Stage 14 "React components updated seamlessly" — simulation throws (F3).<br>• Stage 11 calls the baseline "personalized" / "clinical norm"; it is the global reference-dataset baseline.<br>• Stage 15 "permanent regression harness" — it tests neither `run()` nor the golden vectors |
| D3 | **Referenced documents are missing.** `plan.md` (the "canonical execution document"), `ML.md` and `ARCHITECTURE.md` are git-ignored and absent from the working tree |
| D4 | **Node version.** The app's `.js` files use ESM without `"type": "module"`. The tests ran on Node 24 through syntax detection, with warnings; the README's "Node 18+" was not tested |

## C. Dataset-wide parity (361 reference recordings; V)
**Method.**
- **App side:** the app's stage methods were run on every WAV in `../PRISM smart inhaler/data` (`tools/pipeline_compat/js_run.mjs dataset`).
- **Reference side:** the research reference `prism_inference.analyze_recording`, which reproduces the Stage 1 events exactly (research Entry 10, G6b), plus the raw detector logits (`py_ref.py`).
- **Comparison:** `compare.py`, using the contract's golden tolerances.
- **Frame features** were compared on 6 recordings: the 5 golden dataset recordings and `rec2018-01-22_17h41m49.809s`.

| Stage | Result | Within tolerance? |
|---|---|---|
| Frame / window counts | 361/361 and 361/361 equal | yes |
| Frame features: MFCC, deltas, centroid, flatness, rolloff | max \|Δ\|: MFCC 1.23×10⁻⁴, delta 3.7×10⁻⁵, delta² 4.0×10⁻⁵, centroid 6×10⁻⁸, flatness 3×10⁻⁶, rolloff 0. Max per-dimension MAE 2.1×10⁻⁵ | yes (README target MAE < 0.001) |
| Frame feature ZCR (col 123) | 726–1,134 of 1,501 frames differ per recording; up to 77/2048 crossings (0.038); per-dimension MAE 0.0016–0.0064 | **no** (F7) |
| Detector logits and labels | max \|Δ logit\| 0.00137. **0 of 270,241 window labels differ**: the ZCR mismatch changed no label on this dataset | yes |
| Recording status | 39 `NO_INHALATION_DETECTED` + 322 `EVENTS_DETECTED` in both; 0 mismatches | yes |
| Events | 364 = 364; 0 count mismatches; window counts identical; start times within 1.8×10⁻¹⁵ s; confidence within 5.1×10⁻⁵ | yes |
| End times | 1 event differs by 0.008 s: the golden boundary case `rec2018-01-23_10h52m57.816s`. The app does not cap the last window's end at the duration (F8). Its reasons still match | **no** (1 event) |
| Scoreability | reasons identical for all 364 events; scored 318 = 318 | yes |
| Event features / `mean_rms` | 125 / 128 events beyond 1e-4 relative (max 4.7% / 3.7%) | **no** (F14) |
| z / `anomaly_score` (318 scored) | 52 events with a z difference > 0.01 (max 0.18); 11 scores > 0.01 (max 0.045) | **no** (F14) |

**Root cause of the feature and score mismatches: F14 (V).** The contract slices the event segment as `waveform[floor(start_time·8000) : ceil(end_time·8000)]`.
- **The two implementations compute window times differently.** The reference computes `start = i·(2·64/8000)` and `end = min(start + 25·64/8000, duration)`. The app computes them from frame timestamps (`frame·64/8000 + 0.008`).
- **The values agree to about 10⁻¹⁵ s, but that is enough to change the segment.** `end_time·8000` is mathematically an integer, so float noise moves `ceil` by one sample. For example, the reference has `4.632000000000001·8000 = 37056.00000000001`, which gives `ceil` 37057; the app's value gives 37056.
- **The segment-length change explains the whole mismatch:**
  - in the 234 events where both give the same integer segment, 0 are out of tolerance;
  - 130 events differ in their computed bounds. In 129 of them the reference's segment is one sample longer at the end, and all 129 are out of tolerance. The 130th is the uncapped end time (F8), which clamping to the recording length cancels; it is within tolerance.
- **Why one sample matters so much:** it adds a 1-sample `mean_rms` frame or an extra STFT frame, which shifts the event statistics.

**The fix, checked in a scratch copy (V; the app repository was not modified).** Recomputing window times exactly as the reference does, then rerunning the 129 affected recordings, gave:
- all 152 events with **bit-identical** start and end times;
- `mean_rms` within 1.4×10⁻⁷;
- scores within 4.1×10⁻⁵;
- z within 0.005.

One feature remains just outside tolerance (F15): `spectral_rolloff_std` in `rec2018-02-02_10h48m38.792s`, at 1.05×10⁻³ relative.
- **Cause:** in 1 of 238 frames, the 85% rolloff bin flips between librosa's float32 cumulative sum and the app's float64 sum.
- **Effect:** its z differs by 0.005, within the score tolerance.

**Implication for the research contract (R1; for the PRISM research owner).**
- **The segment rule depends on floating-point rounding.** Integer sample bounds are derived from float times, and the golden tolerance for times (1e-9 s) does not guarantee identical segments.
- **Every re-implementation must therefore reproduce the reference's float formula bit-for-bit**, or the contract must define segments in integer samples.
- **A definition change alters the reference itself.** In 35% of events (129/364) the reference's float path adds one sample at the end. Changing the definition would change those reference features and would need a new `baseline_id`. That is a research decision. This finding should also be recorded in `../PRISM smart inhaler/PRISM_RESEARCH_LOG.md`.

## D. Recommended order of work (functionality first)
1. **Wiring and timing (F1, F2, F9, F14, plus the end-time cap in F8).** These are small mechanical fixes. Acceptance: `tools/pipeline_compat` shows `run()` output equal to the Python contract output on the 361 recordings, within the golden tolerances.
2. **ZCR (F7, optionally F15).** Change the zero-sign rule and use edge padding. Acceptance: frame-feature MAE < 0.001 on every dimension for the 6 checked recordings.
3. **Contract output (F8, F12).** Emit the exact `inference_output.schema.json` object and validate it. Add the 9 golden cases to `npm test` with the contract tolerances. Commit the missing parity fixture, or regenerate it with `test_dsp_reference.py`.
4. **On-device runtime (F5, F6, F13).** Remove `fs`, load the model on React Native, batch ONNX calls, and verify on a dev build.
5. **Simulation and seeding (F3, F4, S5).**
6. **Persistence (F10)** of the contract output, per research `ARCHITECTURE.md` §10.
7. **BLE path (F11)**, after hardware is available.
8. **UI (S1–S4)** and documentation (D1–D3).

## Files changed
- `CLAUDE.md` — new (instructions for Claude sessions in this repository).
- `claude_implementation.md` — new (this log).
- `tools/pipeline_compat/` — new (`README.md`, `js_run.mjs`, `py_ref.py`, `compare.py`, `timing.mjs`, `js_fixcheck.mjs`): the reproducible comparison, timing and fix check used in this entry.
- No existing file was modified. Nothing was committed.

## Tests
- `node pipeline/test_harness.js`: passes.
- `pipeline/test_dsp_parity.js`: fails, because `parity_data.json` is missing.
- Other `pipeline/test_*.js`: pass.

These ran in a scratch clone with `fft.js@4.0.4` and `onnxruntime-node@1.30.0`.

## Open issues / next step
- **Next step:** fix F1–F3, F7–F9 and F14 (functional), then rerun `tools/pipeline_compat` and the golden cases.
- **Unverified items:** the items marked U need a device dev build, Metro bundling and a Firebase project.
- **Research side (R1):** the contract's float-derived segment bounds should be recorded in the PRISM research log. Whether to redefine segments in integer samples is the research owner's decision; it would require a new baseline.
- **Not covered by this audit:** UI/UX quality, accessibility, Firestore security rules and cost, and hardware/BLE (no hardware available).

---

# Entry 2 — 2026-10-07: Pipeline repair (F1–F15 functional core, F3/F4/F9/F10/F11 app layer)

## Objective
Fix the app so `InferencePipeline.run()` implements `prism-inference-v2.0` exactly (user brief: inference v2 only, SCORE_ONLY, no threshold, no personalization). Research repo was at `dd16db3` (Stage 9 added `prism-assessment-v1.0` on top of the unchanged v2 contract); the user chose **inference v2 only** — the Stage 9 assessment layer (tail probability, WITHIN/OUTSIDE, STABLE/BORDERLINE) is NOT implemented. `assets/ml/` re-verified identical to research `results/` (only `acceptance_gate_preregistration.json` differs in EOL).

## What was changed (commits on `ml-integration`, not pushed)
- `64b726b` docs: commits Entry 1 files (CLAUDE.md, this log, tools/pipeline_compat).
- `cd91c8e` F1, F2, F8, F12, F14, F5 (JSON): canonical snake_case output built in `run()` (exact key order, plain JSON, enum error codes in `check_input` order incl. `amplitude_out_of_range`, `detector_feature_extraction_failed`; `input_domain` from the source; `baseline_domain_validated = input_domain == reference_dataset`; `detector_model_sha256` = verified SHA-256 of model bytes). New: `pipeline/contract.js` (checkInput, validateOutput, numpy round-half-even), `sha256.js`, `wav.js` (bytes → PCM, no fs, multi-channel averaged), `OnnxDetector.js` (injected detector), `contractAssets.js` (JSON via `import … with {type:"json"}` — verified to bundle with Metro), `runtime/node.js`. Window times = reference formula; grouping/usability/softmax mirror post_event/prism_inference. `BaselineStore` validates contract_version, baseline_id, V2 order, finiteness, MAD>0, scale=1.4826·MAD. Three old tests now use `createNodePipeline()`.
- `c692125` F7, F15: librosa ZCR (edge pad, signbit after |y|≤1e-10). Rolloff: root cause was numpy's complex64 `abs` (SIMD `larger*sqrt(fma(r,r,1))` in float32, not correctly rounded); `dsp.frameSpectrum` emulates it (bit-identical on 589,143/589,143 magnitudes) + float32 cumsum/threshold.
- `bb4a90e` F3, F4, F9, F10, F11, F6(code): SessionAggregator on canonical outputs (session_status SCORE_ONLY / NOT_SCOREABLE / NO_INHALATION_DETECTED / INPUT_ERROR / PROCESSING_ERROR; outputs kept verbatim; score summary only as internal `diagnostics`); `services/sessionRecord.js` (record schema `prism-app-session-v1`, `assertFirestoreSafe`); simulation = real CNN on synthetic audio, marked `simulated:true` (result: NO_INHALATION_DETECTED); seeding removed; BLE emits no fake events; `pipeline/runtime/reactNative.js` + `services/inferenceService.js`.

## Results (V = run in this session)
- V `npm test` (test_harness + new test_contract): 446 checks pass, 9/9 golden cases incl. 5 dataset WAVs (read from `../PRISM smart inhaler/data`, SHA-checked; set `PRISM_REQUIRE_DATASET=1` to fail when absent), Ajv validation against `inference_output.schema.json`. All `pipeline/test_*.js` pass except `test_dsp_parity.js` (pre-existing: `parity_data.json` missing).
- V 361-recording `run()` parity (`tools/pipeline_compat/py_e2e.py` → `e2e_run.mjs --shard i/4` → `e2e_compare.py`): 0/270,241 label differences (max logit diff 1.0e-5); 322 EVENTS_DETECTED + 39 NO_INHALATION_DETECTED in both; 364/364 events with bit-identical start/end; 318/318 scored; 0 status/reason/window-count mismatches; feature values ≤2.2e-7 rel, mean_rms ≤1.5e-7, z ≤2.3e-6, anomaly_score ≤8.8e-7; ZCR/rolloff frame features identical on 7 dumped recordings. Run time ≈ 2.5 min with 4 shards.
- V `runSimulatedSession(createNodePipeline)` → NO_INHALATION_DETECTED; failing pipeline → PROCESSING_ERROR.

## Not done / open (next session, in this order)
1. **UI is NOT updated yet** (S1–S4): Dashboard/History/Detail/ResultBadge/SessionCard/formatters still read the old fields (`status`, `nEvents`, `aggregateScores`, `eventId`, `quality_assessment`) → they will show "—"/0 for new records; "Mean Z-Score", anomaly score per event, GOOD/POOR labels, `deriveIssues`, deviation flags and "Today's Doses" still present. Must switch to `session_status`, `n_events`, `events[].start_time/status/not_scoreable_reasons`, show `simulated`/`legacy` labels, hide anomaly_score/mean_rms/confidence (ARCHITECTURE §9.4), replace dose count with recordings-by-state.
2. **Metro bundle of the full app not run** (only a JSON-import probe). Needs a local, uncommitted `firebase/config.js`; check that `onnxruntime-node`/`fs` are absent from the bundle. Add `expo-asset`, `expo-file-system` to package.json and `"onnxruntime-react-native"` to app.json plugins (not done).
3. **Android (U, unverified)**: no device/AVD; JDK 24 only, no NDK. User will connect a phone; needs JDK 17 + NDK + `npx expo prebuild` / `expo run:android`. ORT RN 1.24.3 uses a legacy NativeModule `install()` (JSI) — compatibility with RN 0.86 bridgeless is unknown. Then measure F13 (per-window ONNX vs batched) on device.
4. README (D1) still describes the old app; IssueList/ProgressBar legacy components remain.

## Files changed
See the three fix commits above (`git show --stat`). Tooling added: `tools/pipeline_compat/{py_e2e.py,e2e_run.mjs,e2e_compare.py,make_zcr_fixture.py}`, fixture `pipeline/zcr_reference.json`, devDependency `ajv`.

## Tests
`npm test` → pass (446 checks, 0 skipped). Full 361 parity as above.

---

# Entry 3 — 2026-10-08: Stage 10 (V3 personal reference) ↔ App Compatibility Audit (read-only)

## Objective
Check whether the app is compatible with research **Stage 10**. That is the V3 personal reference, `prism-personal-reference-v3.0-draft`, committed and frozen in `../PRISM smart inhaler` at `3c8f64f` (research Entry 15). This entry is an audit only.
- **Integration is out of scope:** the research owner froze V3 and said not to integrate it into the app.
- **No app code was changed.**

## What Stage 10 requires (R, research `src/personal_reference.py`, `results/personal_reference/README.md`)
- **Separate channel:** V3 is a personal channel next to the Stage 9 population channel (`prism-assessment-v1.0`), which stays unchanged.
- **Inputs, per recording in time order, for one (user_id, device_id):**
  - `recorded_at` (ISO 8601);
  - for each event, its scoreability and the four V2 z-values in the Stage 9 coordinates.
- **Sitting:** recordings at most 25 min apart. A sitting qualifies with ≥ 10 scoreable events.
- **Output:** a continuous `personal_deviation`, or `POPULATION_ONLY` during `WARMUP`, plus the baseline state.
- **State:** JSON per (user, device), with a hash-chained audit log.
- **Status:** implemented and mechanically verified on proxy/synthetic data; NOT validated on real longitudinal user data.

## Results
Evidence labels: **V** verified in this session, **R** read, **U** unverified.

**Method.**
- The app's `InferencePipeline.run()` was run on all 361 reference WAVs: `tools/pipeline_compat/e2e_run.mjs`, 4 shards, about 130 s per shard, Node 24.11.1.
- Its outputs were fed into the frozen research V3 code, imported unchanged, by a scratch script that is not committed. The results were compared with the research Stage 9 / Stage 10 outputs.

**A. Numerically compatible.**

| Check | Result | |
|---|---|---|
| Coordinates: app `assets/ml/v2_validation/v2_baseline.json` against the Stage 9 reference baseline | centre and scale bit-identical. The app's `feature_z_scores` are already in V3's coordinates | V |
| App `run()` against Stage 9 deployment outputs | 361 recordings, 364 = 364 events, 0 scoreability mismatches. Over 318 scored events, max \|Δz\| = 2.3×10⁻⁶ | V |
| App outputs replayed through V3 (frozen 9-of-10 and 8-of-10 configs, one pseudo-user, file-name timestamps) | identical to the research replay (`real_corpus_replay_events.csv`) in sitting, status and assessment. `WARMUP` throughout: 8 of 23 sittings qualify, B = 0 | V |
| Test-only adaptive config (2 of 2, s_min 1; not a V3 config), so that the 8 real qualifying sittings can adapt: app z against Stage 9 z | 5 updates; gate decisions identical; B within 2.1×10⁻⁷; personal deviations within 8.4×10⁻⁷ (259 values) | V |

**B. Gaps that block any future integration.**

| ID | Gap | Evidence |
|---|---|---|
| G1 | **No Stage 9 population channel in the app.** The app implements inference v2 only (Entry 2, user choice). Stage 10's design relies on the frozen Stage 9 channel (`WITHIN` / `OUTSIDE_REFERENCE_RANGE`) to keep reporting deviations that the personal baseline absorbs (noise, microphone, device). V3's `observe_population_output()` rejects the app output ("not a Stage 9 assessment output"). The lower-level `observe_recording(z, scoreable, recorded_at)` accepts the app's z-values | V |
| G2 | **No JS/React Native implementation of V3.** V3 exists only in Python | R |
| G3 | **Audit chain and `state_id` are not reproducible in JS.** They are SHA-256 of Python `json.dumps` text, and number formatting differs: Python `[1.0,1e-07,1e+16]` against JS `[1,1e-7,10000000000000000]`. A port needs a Python-compatible canonical serialiser to verify or extend a Python-written state | V |
| G4 | **`recorded_at` is not guaranteed.** `run()` emits `recorded_at = null` unless the source supplies it: all 361 tool outputs had `null`. `SimulatedPcmSource` uses `new Date()` (UTC `Z`).<br>V3 rejects mixing time-zone-aware and naive timestamps (V). **Research-side defect (frozen V3, not fixed):** V3 accepts `null` on the first recording of a stream, then rejects every later recording until the sitting is closed, and logs a sitting with null times. Any integration must reject `null` before calling V3 | V |
| G5 | **Device identity.** `buildSessionRecord` defaults `device_id` to `null` (simulation, WAV). V3 requires a non-empty `device_id` (V). The `(uid, deviceId)` key maps naturally onto `users/{uid}/devices/{deviceId}` (R) | V / R |
| G6 | **Persistence.**<br>• A V3 state with an open sitting is not Firestore-safe: `open_sitting.events[0]` is an array inside an array (app `assertFirestoreSafe`, V). A closed state passed (21.6 KB).<br>• The state grows about 1.6 KB per qualifying sitting (V), so a single document reaches Firestore's 1 MiB limit after roughly 650 qualifying sittings (the limit is from Firestore documentation, U).<br>• This needs a storage design, e.g. state as a JSON string and the audit in a subcollection | V / U |
| G7 | **Sitting definition.** V3 needs ≥ 10 scoreable events per sitting. Real use gives one or two inhalations per dose, so an integrated V3 would stay in `WARMUP` indefinitely. This is a documented research limitation | R |
| G8 | **No real input exists yet.** There is no BLE/microphone audio source (F11). The only live path is simulation on synthetic audio (`simulated: true`), which must never feed a personal state | R |
| G9 | **Display.** V3 outputs are research/diagnostic only (research `ARCHITECTURE.md` §9.4): continuous, no labels, no technique or normal/abnormal claims. App UI items S1–S4 (Entry 1) are still open | R |

**C. No conflict today.**
- The app contains no personal-baseline code, no V3/Stage 9 assets and no claims about personalization in the new pipeline.
- Legacy "personalized" wording remains in `IMPLEMENTATION_LOG.md` (Entry 1, D2).

## Verdict
- **Numerically compatible:** the app's contract outputs are a valid input to V3, as shown by the identical replay and agreement to within 2.1×10⁻⁷.
- **Not integration-ready.** G1–G8 must be resolved first: a Stage 9 layer, a JS port with canonical hashing, guaranteed timestamps and device IDs, a storage design, and a realistic sitting definition. Integration is also frozen by the research owner.

## Files changed
- `claude_implementation.md`: this entry, appended.
- No other file in either repository was changed. Nothing was committed.

## Tests
`npm test` → **446 checks passed, 0 failed, 0 golden cases skipped** (V). The working tree was clean before this entry.

## Open issues / next step
- **Research owner:**
  - record the V3 null-`recorded_at` defect (G4) in the research log;
  - decide the deployment sitting definition (G7).
- **App, only if integration is later approved:**
  - Stage 9 assessment layer (G1);
  - V3 JS port with Python-compatible canonical JSON and golden replay vectors (G2–G3);
  - enforce non-null ISO `recorded_at` and a `device_id` for every real recording (G4–G5);
  - personal-state storage design (G6);
  - exclude simulated sessions (G8).

---

# Entry 4 — 2026-10-09: Android ONNX Runtime registration fix and on-device pipeline verification

## Objective
Task brief: `prompt.md` (untracked). Two goals:
1. Fix the Android crash `[runtime not ready]: TypeError: Cannot read property 'install' of null` at JS start-up.
2. Prove that the PRISM inference v2 pipeline runs end to end on a real phone and matches the references.

Environment:
- Expo SDK 57.0.27, RN 0.86.3 (bridgeless / New Architecture), Hermes;
- onnxruntime-react-native 1.24.3;
- phone: OnePlus Nord CE 2 (IV2201), Android 13, arm64-v8a;
- Node 24.11.1, JDK 17.

## Root cause (V = verified in this session, R = read in code)
1. **Expo autolinking drops the package on Android (V).** onnxruntime-react-native 1.24.3 ships `unimodule.json` (platforms ios + android) and no `react-native.config.js`.
   - Expo's RN-config resolver (`expo-modules-autolinking/build/reactNativeConfig/androidResolver.js`) returns `null` for a package that has no RN config, has an Expo-module config that supports Android, and has a gradle file. So `npx expo-modules-autolinking react-native-config --platform android` did not list the package.
   - Expo-modules autolinking (`resolve --platform android`) includes the package's gradle project but registers nothing: `modules: [], packages: []`.
   - Net effect: the native libraries were built and packaged, but `OnnxruntimePackage` was missing from `PackageList.java`. So `NativeModules.Onnxruntime === null`, and the package's `binding.js` calls `Module.install()` at import time.
   - The import chain is `index.js → … → services/inferenceService → pipeline/runtime/reactNative.js → onnxruntime-react-native`, so the app crashed during JS initialisation.
2. **Upstream confirms it (V):** microsoft/onnxruntime#28266 (2026-04-30), "Add react-native.config.js … to fix autolinking". It adds exactly this Android `packageImportPath`/`packageInstance`, but it is not in any npm release (latest is 1.24.3).
3. **The New Architecture is not the cause (R, then V on device).**
   - `OnnxruntimeModule` is a legacy bridge module. Its synchronous `install()` loads `libonnxruntimejsi.so` and installs the JSI `OrtApi` using `getJavaScriptContextHolder()` and `getCatalystInstance().getJSCallInvokerHolder()`.
   - RN 0.86 bridgeless keeps a `BridgelessCatalystInstance` shim for this, because `UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE` is `false` in `ReactAndroid/build.gradle.kts`.
   - On the device, logcat shows the shim warning and then a successful load of `libonnxruntimejsi.so`. The TurboModule interop layer serves the legacy module.
4. **The earlier local `if (false)` patch (V).**
   - Pristine 1.24.3 `android/build.gradle` uses `org.gradle.util.VersionNumber`, which is missing in the Gradle 9.3.1 used here.
   - The local edit to `if (false)` was not reproducible (it lived only in `node_modules`).
   - It is replaced by upstream main's condition (`major == 0 && minor < 71`), which is false for RN 0.86 and therefore equivalent here. It is now kept as a patch-package patch.

## What was changed
- `react-native.config.js` (new): a project-level autolinking override for `onnxruntime-react-native`. It sets Android `packageImportPath: import ai.onnxruntime.reactnative.OnnxruntimePackage;` and `packageInstance: new OnnxruntimePackage()`, the same values as upstream #28266.
  - No manual `MainApplication` registration and no `node_modules` edit.
  - iOS autolinking is unchanged (still listed).
- `patches/onnxruntime-react-native+1.24.3.patch` (new): the `VersionNumber` fix only (`--include build.gradle$`).
- `package.json`:
  - `postinstall: patch-package`;
  - devDependency `patch-package ^8.0.1`;
  - direct dependencies `expo-asset ~57.0.19` and `expo-file-system ~57.0.7`. `pipeline/runtime/reactNative.js` imports these, and they were previously only transitive (Entry 2, open item 2). `npx expo install` chose the versions already installed.
  - `package-lock.json` was updated accordingly.
- `app.json`: `npx expo install` reformatted the user's uncommitted edit and appended an `expo-asset` plugin entry. The entry was removed again (it does nothing without options). The content is otherwise the user's.
- `index.js`: `if (__DEV__) require('./tools/device_conformance/appRunner').runIfRequested();` This does nothing unless a request file is present.
- `tools/device_conformance/` (new): `appRunner.js` (on device), `run_device_conformance.mjs` (host), `README.md`.
- Not changed: pipeline code, model, baseline, contract, schemas, golden vectors (`assets/ml/`), UI, `android/` sources (git-ignored, generated).

## Results (all V unless marked)
- **Before the fix** (installed pre-fix build, 15:22): logcat has `E ReactNativeJS: [runtime not ready]: TypeError: Cannot read property 'install' of null`, 3 occurrences.
- **Autolinking:**
  - after the fix, `react-native-config --platform android` lists `onnxruntime-react-native` with the package import and instance;
  - `android/app/build/generated/autolinking/.../PackageList.java` contains `new ai.onnxruntime.reactnative.OnnxruntimePackage()`.
- **Reproducibility:**
  - `npm ci` reinstalled everything, and `postinstall` re-applied the patch (checked in `build.gradle`).
  - `npx expo prebuild --clean --platform android --no-install` could not delete the real `android/`: `EBUSY`, a lock held by a process outside this session, which was not killed. Prebuild did not modify `android/`; it was compared with a backup.
  - So `prebuild --clean` was run in a scratch copy of the project (same `node_modules` via a junction). There, `gradlew :app:generateAutolinkingPackageList` produced `PackageList.java` containing `OnnxruntimePackage`.
  - The fresh prebuild output differs from the real `android/` only in `gradle.properties` (`reactNativeArchitectures=arm64-v8a`, the user's setting) and `local.properties`.
- **Build:** `JAVA_HOME=jdk-17; android\gradlew.bat -p android installDebug` → BUILD SUCCESSFUL, installed on IV2201. The APK contains `lib/arm64-v8a/libonnxruntime.so` and `libonnxruntimejsi.so`.
- **After the fix:**
  - launch logcat has 0 × `install' of null`, 0 × `OrtApi is not initialized` and 0 × `FATAL EXCEPTION`;
  - logcat shows `nativeloader: Load …libonnxruntimejsi.so … ok`, then `Running "main"`.
  - The same holds for both conformance-run logs.
- **Metro bundle:** the app bundle (`index.bundle?platform=android&dev=true`) does not contain `pipeline/runtime/node.js` or `onnxruntime-node`. The only matches are comments and the runtime-guarded `process.getBuiltinModule("node:fs")` in `WavPcmSource`.
- **On-device inference:**
  - Command: `node tools/device_conformance/run_device_conformance.mjs --extra 400 --out <dir> --timeout-s 3600`.
  - Cases: 371 = 9 golden + 6 invalid/domain + 356 further dataset recordings, i.e. all 361 reference WAVs.
  - **17,331 checks passed, 0 failed.**
  - Runtime:
    - ORT JS 1.24.3, native ORT 1.30.0 (resolved by the package's `latest.integration`), Hermes;
    - model `features` float32 `[batch_size, 25, 124]` → `logits` float32 `[batch_size, 4]`;
    - SHA-256 `2e4e72d3…3725` verified on the device from the bundled asset (expo-asset → expo-file-system bytes);
    - load time 1.46 s.
  - Device vs Node `run()` (onnxruntime-node 1.30.0), all 371 cases:
    - statuses, errors, reasons, event counts, window counts and times identical (Δt = 0);
    - `feature_values`, `mean_rms`, z and `anomaly_score` bit-identical (Δ = 0);
    - `detector_confidence` max Δ 1.8e-7.
  - Device vs golden expected (Python reference), 9 cases:
    - confidence ≤ 1.1e-7;
    - features ≤ 1.1e-7 relative;
    - `mean_rms` ≤ 1.4e-7 relative;
    - z ≤ 8.6e-7;
    - score ≤ 3.3e-7.
    - All within the contract tolerances.
  - Dataset totals on the device: 322 `EVENTS_DETECTED` + 39 `NO_INHALATION_DETECTED`, 364 events, 318 scored, 46 not scoreable (short_duration 32, close_neighbor 25, recording_boundary 1).
    - These equal the Python reference totals in Entry 2.
    - Device vs Python per event for all 361 is transitive: device = Node here, and Node = Python in Entry 2.
  - All device outputs pass Ajv `inference_output.schema.json` and `validateOutput`.
  - `baseline_domain_validated`: `true` for `reference_dataset`, `false` for `prism_hardware`.
- **Invalid audio and errors:**
  - Undecodable bytes and an empty file: `run()` throws `WavDecodeError`, and the session is `PROCESSING_ERROR` with `recordings: []`.
  - `empty_audio`, `nonfinite_audio`, `amplitude_out_of_range`, `unsupported_sample_rate`, `shorter_than_one_detector_window` → `INPUT_ERROR` with the contract codes.
  - A tampered model raises `ModelLoadError` (SHA mismatch).
  - Invalid bytes passed to ORT surface as a JS `Error: No graph was found in the protobuf.` (no native crash).
  - A failing pipeline factory gives `runSimulatedSession` → `PROCESSING_ERROR` with 0 recordings.
- **Session layer:** for every case, the record built by `SessionAggregator` + `buildSessionRecord` (`prism-app-session-v1`, `simulated:false`):
  - holds the canonical output verbatim (`recordings[0]`);
  - has the matching `session_status` (`NO_INHALATION_DETECTED` stays distinct from `SCORE_ONLY` / `NOT_SCOREABLE`);
  - has no legacy fields;
  - passes `assertFirestoreSafe`.
  - The app's Simulate path on the device → `NO_INHALATION_DETECTED`, `simulated: true`.
- **Performance (debug build, dev bundle, one ONNX call per window, F13):**
  - per 12 s recording: median 6.1 s (3.3–8.0 s);
  - 361 recordings in 36.9 min.
  - Release build not measured.

## Files changed
- New: `react-native.config.js`, `patches/onnxruntime-react-native+1.24.3.patch`, `tools/device_conformance/{appRunner.js,run_device_conformance.mjs,README.md}`.
- Modified: `package.json`, `package-lock.json`, `index.js`, `app.json` (see above), `claude_implementation.md` (this entry).
- Nothing was committed or pushed.

## Tests
`npm test`:
- before the changes: 446 passed, 0 failed, 0 skipped;
- after the changes (and after `npm ci`): 446 passed, 0 failed, 0 skipped.

## Open issues / next step
1. **UI does not consume the canonical session record (R; Entry 2 item 1, S1–S4 still open).** These screens read fields that `prism-app-session-v1` does not have, so new sessions show "—"/0:
   - `DashboardScreen` (`status`, `nEvents`, `aggregateScores`, "Mean Z-Score");
   - `SessionDetailScreen` (`nEvents`, `aggregateScores`, `ev.eventId`, `notScoreableReasons`);
   - `SessionCard` (`quality_assessment`);
   - `IssueList` / `formatters` (legacy technique issues).

   **Conflict for the user:** `prompt.md` defines user-facing NORMAL/ANOMALY meanings, but `CLAUDE.md` §4 forbids NORMAL/ANOMALY outputs while the contract is `DRAFT_NOT_FROZEN`. This needs a decision before UI work.
2. **Firestore persistence not verified on the device (U).** The phone had no DNS (`auth/network-request-failed`, `Unable to resolve host identitytoolkit.googleapis.com`), so the app showed its "Configuration Error" screen after start-up. The pipeline is unaffected.
3. **Native ORT version is not pinned.** The package resolves `onnxruntime-android:latest.integration` (1.30.0 today). A future build may pick up a newer native ORT. Consider pinning it in the patch (it matches the onnxruntime-node 1.30.0 used for parity).
4. **`install()` relies on RN's deprecated bridgeless `CatalystInstance` shim.** Upstream main also uses it. An RN release that removes the shim will break `install()`; the fix then is `getReactApplicationContext().getJSCallInvokerHolder()`.
5. **Remove `react-native.config.js` and the patch** once an onnxruntime-react-native release contains #28266 and the gradle fix. Note: upstream's new `app.plugin.js` also adds `OnnxruntimePackage` to `MainApplication`; together with autolinking that would register the module twice. Check this when upgrading.
6. `prompt.md` names the package `com.matiks.app`. That is a different app on the phone; this project is `com.anonymous.smart_inhaler_app`.
7. Expo CLI with `CI=1` does not watch files: restart Metro after editing app code before a device run.
8. iOS was not built or verified.

---

# Entry 5 — 2026-10-10: Offline-first session storage, Firestore sync and UI on the canonical session record

## Objective
Implement the fixes from the read-only audit earlier in this session (reported in chat, not logged separately). That audit found:
- the app was online-first: start-up, saving and listing sessions all waited for Firebase;
- no local session store, no queue, no retry, and random Firestore document IDs;
- the UI read legacy fields (so it showed "—"/0) and still showed forbidden values.

Constraints (user brief):
- no change to the pipeline, model, baseline, `assets/ml/`, the contract or the ONNX Runtime Android fix;
- no SQLite;
- the session schema is kept;
- no clinical, quality or technique output;
- no scores, z, RMS, confidence, thresholds, GOOD/POOR, technique issues or dose counter on screen;
- nothing committed or pushed.

Evidence labels: **V** = verified by running in this session, **R** = read in code, **U** = not verified.

## What was changed
**Storage and sync (new):**
- `services/localSessionStore.js`: AsyncStorage-shaped storage (injected), one key per session, `@PRISM:session:<session_id>`.
  - Each key holds an envelope `{format: "prism-local-session-v1", saved_at, record, sync}`.
  - `record` is the `buildSessionRecord()` output, stored verbatim. `sync` (`pending`/`synced`, attempts, last_error, synced_at, synced_user_id) is kept outside the record.
  - Writes are serialized. Identical re-saves are no-ops; a different record under an existing ID is refused.
  - Corrupt or foreign entries are skipped and reported, never overwritten or deleted.
  - A synced entry is never downgraded by a late failure.
- `services/syncService.js`:
  - `saveSession(record)` stores the session locally, then requests a sync without waiting for it.
  - Sync is single-flight: a request during a pass schedules one more pass.
  - A session is marked synced only when the upload promise resolves (server confirmation). Failures and timeouts stay pending with `last_error`.
  - A pass waits up to 20 s per upload, then stops (probably offline). The write Firestore still holds is not re-sent while it is held. If it is confirmed later, the session is marked synced and the next pass starts.
  - After a rejected write, an optional server read (`sessionExistsRemotely`, `getDocFromServer`) confirms a document that an earlier unconfirmed attempt committed. This covers security rules that refuse overwrites.
  - `mergeSessionLists(local, remote)` merges by `session_id` (legacy documents by document ID). The phone's copy wins.
  - Exports `withTimeout`.
- `services/appServices.js`: the app instances (AsyncStorage + Firestore + `ensureSignedIn`). The Node tests build their own instances with fakes.

**Firebase:**
- `services/sessionService.addSession` now uses `setDoc(doc(users/{uid}/sessions, session_id), {...record, timestamp: serverTimestamp()})` instead of `addDoc`. The signature is kept; it returns the session_id.
- New `sessionExistsRemotely()`. `getSessions()` is unchanged.
- `services/authService.js`:
  - the `users/{uid}` profile write is no longer awaited (Firestore resolves writes only after server confirmation);
  - new `ensureSignedIn()` (single-flight, returns `null` instead of throwing) and `isFirebaseConfigured()`;
  - `signInAnonymously()` is kept.
- `firebase/firebaseConfig.js`: placeholder credentials (`YOUR_…`/empty) or a Firebase init exception leave `db`/`auth` null, with `firebaseInitError` set. The app then runs locally with cloud sync off. A missing `config.js` still fails the build (static import).

**Start-up and context:**
- `App.js`:
  - loads local sessions, then renders the navigator;
  - requests a sync, then runs in the background: `ensureSignedIn()` → `initUser` → remote history merge → device auto-reconnect;
  - the fatal "Configuration Error" screen was removed.
- `context/AppContext.js`:
  - `loadSessions(uid?)` reads local first, then (with a UID) merges `getSessions()` with a 20 s timeout. It never throws.
  - `addNewSession(record)` saves locally through the sync service and returns the session_id. It no longer needs a `userId` or waits for Firestore.
  - New context values: `syncStatus`, `syncNow`, `requestSync`, `localStoreError`. Existing exports are kept.
  - Subscribes to sync status (it picks up a UID obtained by a later pass). AppState `active` triggers a sync.
- `screens/DeviceScreen.js`: the Firestore device writes (`saveDevice`, `markDeviceInactive`) are no longer awaited and are skipped without a user (audit defect 7). The AsyncStorage last-device save is still awaited.

**UI:**
- New `utils/sessionView.js`, a whitelist view model:
  - `describeSession()` returns status label and description, source, simulated/legacy, saved/recorded time, sync state (with last error), counts (recordings, events, not scoreable), events (number, start/end, duration, Scoreable/Not scoreable, reasons as measurement conditions with the contract's 0.5 s / 0.2 s / boundary rules), and input/processing errors;
  - `describeSyncStatus()` produces the Dashboard sync line.
- `ResultBadge` shows the session states, plus LEGACY. GOOD/POOR/ABNORMAL/MISSED_DOSE were removed.
- `StatusTag`: new WAV source and Synced / Not synced tags.
- `SessionCard`, `SessionDetailScreen` and `DashboardScreen` render through `describeSession`.
- Removed from the screens:
  - Mean Z-Score;
  - mean/max score and per-event anomaly score;
  - model confidence %;
  - the `deviationColor` thresholds;
  - the IssueList import;
  - "Today's Doses 0/4".
- Dashboard:
  - "Cloud Sync" card with the status line and a **Sync now** button;
  - "Last Session" card;
  - button renamed "Run Simulated Session", with a hint saying it is real on-device analysis of synthetic audio (no "mock").
- `utils/formatters.js`: removed `formatCompositeLabel`, `formatDeviationFlag`, `deriveIssues` and `getTodayCompletedCount`; added `formatTime`.
- `screens/SettingsScreen.js`: removed the "Personalization" placeholders ("Daily Dose Target 4 doses", "Inhalation Duration Goal 5 seconds", "Minimum Quality Score 70%": invented thresholds and a quality %). The account text now says sessions are stored on the phone. The UID shows "Not signed in (offline or Firebase not configured)" instead of "Loading…".
- `screens/HistoryScreen.js`: empty-state text names the new button.
- `services/sessionRecord.js`: added `isValidSessionId()`, the Firestore document-ID rules.

## Results
**V, tests:** `npm test`:
- `test_harness`: ALL REGRESSION TESTS PASSED;
- `test_contract`: 446 passed, 0 failed, 0 skipped;
- `services/test_sessions.js`: 112 passed, 0 failed, 0 skipped;
- `utils/test_session_view.js`: 254 passed, 0 failed.

The same 446 passed during the audit, before any edit.

**V, mutation check** (scratch copy, `scratchpad/mutate.py`): each injected defect made a suite fail; 15 of 15 caught.

| Area | Injected defects |
|---|---|
| Sync | mark synced before confirmation; no single-flight; failure marked synced; `saveSession` awaits the upload |
| Firestore and auth | random document ID; profile write awaited |
| Local store | overwrites corrupt data; list throws on a corrupt entry |
| Merge | remote duplicates kept |
| View model | anomaly score leaked into the view; raw reason codes; NO_INHALATION shown as an error |
| UI | "Model confidence" label; GOOD badge; ProgressBar import |

Two weak tests were tightened during this check:
- the save-must-not-wait test now uses a 60 s confirmation timeout;
- the auth test no longer hangs after a failure.

**V, Metro production bundle:** `CI=1 npx expo export --platform android --output-dir <scratchpad>/export_entry5` exits 0 and produces one 4 MB `.hbc`.
- Present in the bundle: `@PRISM:session:`, "Run Simulated Session", "Not synced yet", "No inhalation detected", "Sync now".
- Absent: "Mean Z-Score", "Today's Doses", "Model Confidence", "Missed Dose", "Minimum Quality Score", "mock inhalation", "onnxruntime-node", "PRISM-CONFORMANCE".

**V, integrity:**
- `git diff -- pipeline assets` is empty;
- the ORT gradle patch is still applied;
- `react-native.config.js` is unchanged;
- `AsyncStoragePackage` is in the generated `PackageList.java`, so no native rebuild is needed for this change.

**What the tests cover (V, Node with fakes):**
- local round trip of all 9 golden-derived records plus a PROCESSING_ERROR record;
- restart persistence;
- `saveSession` returns within 1 s while Firestore never confirms (60 s timeout);
- the held write is not re-sent;
- late confirmation → synced, and the queue continues;
- app closed mid-sync → retry after restart, exactly one remote document;
- failure → pending with error → retry → synced, same document ID;
- lost confirmation (commit-then-reject, commit-then-hang) → one document, plus server-read confirmation under create-only rules;
- 5 concurrent `syncNow` calls share one run; uploads never overlap; a session saved mid-pass is uploaded;
- merge without duplicates (local wins, remote-only kept, legacy flagged);
- 6 kinds of corrupt entries skipped and left intact, and other features' keys ignored;
- unreadable store → status `error`, no throw;
- not signed in → nothing uploaded;
- `sessionService` (fake `firebase/*` via `node:module` `registerHooks`):
  - every write, retries included, is `setDoc` on `users/{uid}/sessions/{session_id}`, and the document equals the record plus the server timestamp;
  - `getSessions` flags legacy documents and hides `in_progress` ones;
- `authService`: sign-in resolves while the profile write never confirms; failures → `null`; concurrent calls share one attempt.

**What the view tests cover (V):**
- every golden case: status, counts, exact event times, reason texts, input-error text;
- no forbidden key, no internal numeric value (anomaly_score, z, feature values, mean_rms, confidences, diagnostics) and no forbidden wording anywhere in the view;
- NO_INHALATION, NOT_SCOREABLE, INPUT_ERROR and PROCESSING_ERROR are kept apart;
- simulated, legacy (GOOD/POOR and camelCase documents not interpreted) and sync flags;
- static scan of all UI modules reachable from `App.js` (7 files) for forbidden fields, labels and helpers.

## Not verified
- **U, on the phone:** the JS was not loaded onto the phone. The phone was online this time (Wi-Fi and DNS work), so a device run would have written test sessions to the user's Firestore. Offline checks would have needed airplane mode on the user's phone. Both need the user's go-ahead.
- **U, Firestore rules:** the security rules are not in the repository. Retries need either update permission on `users/{uid}/sessions/{id}` or read permission (for the server check). Without either, a session whose confirmation was lost stays pending; it never duplicates.
- **U, rendering:** components were not rendered (no React Native renderer in Node). The UI checks are the view model plus the static scan.

## Files changed
- **New:** `services/localSessionStore.js`, `services/syncService.js`, `services/appServices.js`, `services/test_sessions.js`, `utils/sessionView.js`, `utils/test_session_view.js`.
- **Modified:** `App.js`, `context/AppContext.js`, `services/authService.js`, `services/sessionService.js`, `services/sessionRecord.js` (an addition only), `firebase/firebaseConfig.js`, `screens/DashboardScreen.js`, `screens/SessionDetailScreen.js`, `screens/DeviceScreen.js`, `screens/HistoryScreen.js`, `screens/SettingsScreen.js`, `components/ResultBadge.js`, `components/SessionCard.js`, `components/StatusTag.js`, `utils/formatters.js`, `package.json` (the test script only), and this log.
- **Not deleted:** `components/IssueList.js` and `components/ProgressBar.js` are no longer imported or reachable. Deleting them was refused by the session's permission check, so they remain.
  - `IssueList.js` imports `deriveIssues`, which no longer exists, so it would fail if imported again. Deleting both is recommended.
- Nothing was committed or pushed.

## Tests
`npm test`: exit 0; the four suites as listed under Results.

## Open issues / next step
1. **Device check (needs the user's OK, debug build plus Metro, no native rebuild):**
   1. In airplane mode, launch: the Dashboard appears with no error screen.
   2. Run Simulated Session: the session is listed as "Not synced".
   3. Force-stop and relaunch: the session is still listed.
   4. Network on, then foreground or Sync now: "Synced", and the Firestore console shows exactly one `users/{uid}/sessions/{session_id}` document.
   5. Kill the app during a sync and relaunch: still one document.
   6. Existing legacy documents show as "Legacy record".
   7. A build with placeholder credentials runs locally with sync off.
2. **Firestore rules:** confirm update (or read) permission on the session documents. Record the rules in the repository.
3. **Storage growth:** sessions measured 2.4 KB median and 5.6 KB max; AsyncStorage on Android allows 6 MB by default (≈1,500–2,000 sessions). No pruning is implemented. Options: a policy that prunes synced sessions, or raising `AsyncStorage_db_size_in_MB`.
4. **Remote-only history** (sessions written by earlier app versions or another install) is not cached locally, so it is visible only when Firestore is reachable.
5. **Behaviour notes:**
   - A retry rewrites the server `timestamp`, which becomes the time of the last confirmed write.
   - With a first launch offline, sessions are uploaded under the anonymous UID created at the first successful sign-in.
   - Clearing app data removes the local sessions and the anonymous UID together.
6. **No network-change listener** (NetInfo was not added). Sync runs at start-up, after each save, on foreground, on Sync now, and after a late confirmation.
7. **Session IDs:** `session_id` = `sim_sess_<ms>` is unique per device. A future BLE source must produce IDs that pass `isValidSessionId()`.
8. **README** still describes the old app; `IssueList.js` and `ProgressBar.js` should be deleted (see Files changed).

---

# Entry 6 — 2026-10-10: Separate commit for the Android ONNX Runtime registration fix (Entry 4)

## Objective
Commit the Entry 4 fix on its own, after the offline-first commit `c222632`:
- `c222632` is not amended;
- nothing is pushed;
- the user's own uncommitted edits stay out of the commit and stay in the working tree.

Evidence labels: **V** = run in this session, **R** = read.

## What was committed and what was not
**Committed:**
- `react-native.config.js`;
- `patches/onnxruntime-react-native+1.24.3.patch`;
- `package.json`: `postinstall: patch-package` and devDependency `patch-package ^8.0.1`;
- `package-lock.json`: HEAD plus the root devDependency, the 24 dev-only entries of patch-package's tree, and `hasInstallScript: true`, which is npm's canonical form for a root `postinstall`;
- `index.js` (the `__DEV__` conformance hook);
- `tools/device_conformance/`;
- this log's Entries 4 and 6.

**Not committed (left in the working tree):**
- **`app.json`**, the user's edit (R, Entry 4): removal of `newArchEnabled`, `splash` and `edgeToEdgeEnabled`, plus the ORT config-plugin entry.
  - The plugin entry is not needed for the fix (see Results).
- **The Expo bump** `expo ~57.0.26 → ~57.0.27` and the lock changes that come with it: 39 changed and 11 removed entries, including `expo-modules-autolinking` 57.0.13 → 57.0.14.
- **The direct dependencies** `expo-asset ~57.0.19` / `expo-file-system ~57.0.7` (Entry 4):
  - `expo-asset` 57.0.19 needs the bump (HEAD's expo pins `~57.0.18`);
  - both stay installed transitively at HEAD (57.0.18 / 57.0.7), so the fix does not need them.
- **Entry 3** (an unrelated audit), `prompt.md`, `rnconfig.json` (empty), `skills-lock.json` and `.claude/`.

No source code was changed in this step.

## Results (V)
All checks ran on a candidate tree (`c222632` + exactly the committed changes) in the scratchpad.

**Lockfile and install:**
- `npm install --package-lock-only` reports the lock in sync. Its only addition was `hasInstallScript`, which was adopted; a second pass changed nothing.
- `npm ci` installed 688 packages (expo 57.0.26, expo-modules-autolinking 57.0.13, ORT 1.24.3, patch-package 8.0.1), and the `postinstall` applied the patch to the pristine package.
- patch-package 8.0.1 also applies a CRLF copy of the patch to the npm-packed `build.gradle`. This covers a fresh Windows checkout with `core.autocrlf=true`.

**Autolinking:** `expo-modules-autolinking react-native-config --platform android` lists `onnxruntime-react-native` with `OnnxruntimePackage`. In the control without `react-native.config.js`, it is not listed.

**Tests and JS bundle:**
- `npm test` with `PRISM_REQUIRE_DATASET=1`: harness passed; 446 / 112 / 254 checks passed, 0 failed.
- `expo export --platform android` exits 0: a 4 MB `.hbc` that contains the ORT binding and no `PRISM-CONFORMANCE` or `onnxruntime-node`.

**Native build:**
- `expo prebuild --platform android --no-install` was run with `app.json` as in HEAD, i.e. without the ORT config plugin.
- `gradlew :app:generateAutolinkingPackageList :app:dependencies` (JDK 17) → BUILD SUCCESSFUL.
  - `PackageList.java` contains `new ai.onnxruntime.reactnative.OnnxruntimePackage()`.
  - `project :onnxruntime-react-native` is on `debugRuntimeClasspath`.
  - The patched `build.gradle` configures under Gradle 9.
- `gradlew :app:assembleDebug` (arm64-v8a): did not complete in the candidate. Three unrelated CMake modules (`react-native-gesture-handler`, `react-native-screens`, `expo-modules-core`) failed on the Windows 260-character path limit, because the candidate lives in the long scratchpad path. A `subst` drive did not help: Gradle resolves it back to the long path. Before those failures, `:onnxruntime-react-native:compileDebugJavaWithJavac` and `configureCMakeDebug[arm64-v8a]` succeeded.
  - The real project (`android/`, short path, working-tree dependency set with expo 57.0.27): `gradlew :app:assembleDebug` → BUILD SUCCESSFUL (up to date). Its APK contains `lib/arm64-v8a/libonnxruntime.so` and `libonnxruntimejsi.so`.

**Not verified (U):** a full APK link and a device run with the committed dependency set (expo 57.0.26). Entry 4's device evidence is for the working-tree set (expo 57.0.27).

## Open issues / next step
- The remaining uncommitted changes (Expo bump plus lock, `expo-asset`/`expo-file-system`, `app.json`) belong to the user. Commit them together so that `package.json` and `package-lock.json` stay consistent.
  - The working-tree lock lacks `hasInstallScript`; npm adds it on the next install.
- Entry 4 issues 3, 4, 5 and 8 are still open:
  - native ORT is not pinned (`latest.integration`);
  - the deprecated `CatalystInstance` shim;
  - remove the override and the patch once an ORT release contains #28266;
  - iOS was not verified.

---

# Entry 7 — 2026-10-11: Separate commit `4c65c4d` aligning the Expo dependencies

## Objective
Commit the remaining Expo dependency change on its own:
- only what the Expo 57.0.26 → 57.0.27 upgrade demonstrably requires;
- `c222632` and `324b78a` unchanged, nothing pushed;
- no native build or device test (reserved for the next task).

## What was inspected / changed
**Committed in `4c65c4d`** (`package.json` and `package-lock.json` only):
- `package.json`: `expo ~57.0.26 → ~57.0.27`.
- `package-lock.json`: npm's minimal lock for that `package.json`, computed from HEAD's lock with `npm install --package-lock-only`.
  - 27 entries changed: the root entry, plus expo 57.0.27 and the packages its pinned ranges require, including `@expo/cli` 57.0.28, `expo-modules-autolinking` 57.0.14, `expo-modules-core` 57.0.21, `expo-asset` 57.0.19 and `babel-preset-expo` 57.0.14.
  - 5 nested `hermes-*` entries were removed.
  - Every committed entry is byte-identical to the working-tree lock.
- npm's `peer` flags oscillated on the first pass (`expo` / `@babel/runtime`) and settled on the second pass at HEAD's values; passes 3 and 4 were identical. The stable lock was committed.
- `postinstall: patch-package`, devDependency `patch-package`, and `hasInstallScript` from `324b78a` are intact.

**Not committed (left in the working tree):**
- `expo-asset ~57.0.19` / `expo-file-system ~57.0.7` direct dependencies: not needed for the upgrade, because `expo` 57.0.27 itself requires `expo-asset ~57.0.19` and `expo-file-system ~57.0.7`.
- 13 optional in-range updates that no dependent requires: `@react-navigation/core` 7.23.0, `protobufjs` 7.6.6, `@babel/core` 7.29.7, `@grpc/grpc-js`, `shell-quote` and others. With them go 6 lock removals (e.g. `query-string`) and the working lock's missing `hasInstallScript`.
- `app.json`, Entry 3, `prompt.md`, `rnconfig.json`, `skills-lock.json`, `.claude/`.

## Results (V, on a scratch tree = `324b78a` + the committed files; placeholder `firebase/config.js`)
- `npm ci` → exit 0: 683 packages; `postinstall` applied the ORT patch; lock unchanged; expo 57.0.27, `expo-modules-autolinking` 57.0.14.
- `npm test` (`PRISM_REQUIRE_DATASET=1`) → exit 0: harness passed; 446 / 112 / 254 checks passed, 0 failed.
- `npx expo export --platform android` → exit 0, a 4 MB `.hbc`.
- The staged diff contained only the two files, no credentials, and none of the optional updates.

**Not done (scope):**
- `npm ci` was not run in the real working tree. Its lock is the user's uncommitted version, and the real `node_modules` (expo 57.0.27, `@react-navigation/core` 7.23.0, `protobufjs` 7.6.6) was left untouched.
- No Gradle build and no device run.

## Open issues / next step
- **Before the native build:** decide whether to install from the committed lock (`npm ci` requires setting the working-tree lock changes aside) or to keep the current `node_modules`, which carries the 13 uncommitted optional updates.
- **`app.json`, the user's uncommitted edits:**
  - removing `edgeToEdgeEnabled` matches Expo 57's prebuild warning;
  - removing `newArchEnabled` and `splash` is not required by the upgrade, and dropping `splash` changes the prebuilt splash screen;
  - the ORT config plugin is not needed on Android (Entry 6).

---

# Entry 8 — 2026-10-11: Demo recordings analysed on the phone (bundled reference recordings, waveform)

## Objective
Let the user show, on the phone, the app analysing a real recording: a Dashboard button that runs the on-device pipeline on a randomly chosen reference-dataset recording bundled with the app, saves the result like any session (History and Firestore, as the user chose), and shows the recording's waveform with the detected inhalation.

## What was inspected / changed
- **Bundled recordings:** `assets/demo_recordings/demo_01.wav` … `demo_08.wav` (1.5 MB). Eight recordings drawn at random (`shuf`) from the 302 annotated files of `../PRISM smart inhaler/data`, copied byte-identically; the mapping and SHA-256s are in `DEMO_RECORDINGS`. `wav` is in Metro's default `assetExts`, so no config change.
- **`services/demoSession.js` (new, pure):** `analyseDemoRecording` runs `pipeline.run()` on the WAV bytes (`WavPcmSource`, `input_domain = "reference_dataset"`, `recording_id` = dataset file name) and builds the record with `SessionAggregator` + `buildSessionRecord(…, { source: "wav", simulated: false, note })`, session ID `demo_sess_<ms>`. A pipeline failure becomes a `PROCESSING_ERROR` session, as in `simulationService`. Also `pickDemoRecording`, `demoRecordingOf(session)` and `waveformEnvelope(bytes, bins)` (peak per slice, scaled to 1).
- **`services/demoRecordings.js` (new, app):** loads the bundled files with expo-asset + expo-file-system (same pattern as `loadModelBytes`); `runDemoSession(getPipeline)`, `loadDemoWaveform(session)`.
- **`components/Waveform.js` (new):** bars drawn with plain views, detected events shaded from the view's event start/end times, legend "Detected inhalation".
- **`screens/DashboardScreen.js`:** "Analyse Demo Recording" button and hint; the session is saved with `addNewSession` (local store, then background sync) and its detail screen opens (`navigate("History", { screen: "SessionDetail", …, initial: false })`). Both buttons are disabled while either runs.
- **`screens/SessionDetailScreen.js`:** a session's `note` is now shown for non-simulated sessions too (information banner); a "Recording" card with the waveform appears when `demoRecordingOf(session)` finds the bundled file.
- **No change** to the pipeline, model, baseline, contract, `assets/ml/`, the session schema, the sync service or `utils/sessionView.js`. No new dependency.
- **Display rules:** the screens show status, event times and durations, the note and the waveform; no score, z, RMS or confidence (the UI scan covers the new component).

## Results (V = run)
- **V, PC, all 8 bundled recordings:** the app code in Node (`analyseDemoRecording`, onnxruntime-node) matches the Python reference (`prism_inference.py --input-domain reference_dataset`) within the contract tolerances on every field. Each finds one scoreable inhalation within about 0.15 s of the annotated inhale (e.g. demo_07: detected 2.72–4.25 s, annotated 2.80–4.11 s). The dataset is mostly in-sample for the deployed model (fold membership not saved), so this is a functional check, not an accuracy result.
- **V, `npx expo export --platform android`** (to the scratchpad, not `dist/`) → exit 0; the 8 WAVs are bundled; the `.hbc` contains "Analyse Demo Recording" and no `PRISM-CONFORMANCE` / `prism_test_`.
- **V, `gradlew :app:assembleDebug`** (JDK 17; the debug APK embeds the JS bundle because of `debuggableVariants = []` in the git-ignored `android/app/build.gradle`) → BUILD SUCCESSFUL, 0 errors; the APK contains `res/raw/assets_demo_recordings_demo_0{1..8}.wav`.
- **V, device** (IV2201, Android 13, `adb install -r`, data kept; Metro not running, embedded bundle): cold launch to the Dashboard in 6 s; one tap on "Analyse Demo Recording" → detail screen after about 10 s with the demo note, "Events detected", Source "WAV file", the waveform of `rec2018-05-03_15h31m15.084s.wav` with the inhalation shaded, and Event 1 · Scoreable, 2.72 s – 4.25 s, 1.53 s. Stored as `demo_sess_1791742099510` (source `wav`, simulated false, `reference_dataset`), synced at 18:08:19 UTC to `users/{uid}/sessions/demo_sess_1791742099510`. Back navigation returns to Session History. The three earlier local sessions are unchanged.
- **Observed on the device:** History lists 6 sessions, 4 stored on the phone and 2 only in Firestore: simulated sessions from 2026-10-09 15:31 and 15:32 IST. The device log of that minute shows PRISM removed from Recents and relaunched from its icon (manual use); no command in Claude's session created them (inference: they came from taps on the simulate button of the app version of that day).

## Files changed
New: `assets/demo_recordings/demo_01.wav` … `demo_08.wav`, `services/demoSession.js`, `services/demoRecordings.js`, `components/Waveform.js`. Changed: `screens/DashboardScreen.js`, `screens/SessionDetailScreen.js`, `services/test_sessions.js`, this log. Git-ignored and unchanged here: `android/app/build.gradle` (`debuggableVariants = []`, from the 2026-10-11 device verification).

## Tests (command and outcome)
- Before: `npm test` → exit 0 (446 / 112 / 254 checks, 0 failed).
- After: `npm test` → exit 0 (446 / 149 / 255 checks, 0 failed). New test 15 in `services/test_sessions.js` (37 checks): every bundled file listed and SHA-checked, byte-identical to the dataset when `../PRISM smart inhaler/data` exists, bundled by `demoRecordings.js`; the stored output equals `pipeline.run()` on the same bytes; source/simulated/note/input domain; Firestore-safe; stored and synced unchanged under its `session_id`; pipeline failure → `PROCESSING_ERROR`; waveform envelope. The pipeline modules are imported before the test's fake-firebase resolve hook, which otherwise rewrites the baseline's `.json` import.
- The UI scan (`utils/test_session_view.js`) now also covers `components/Waveform.js`.

## Open issues / next step
- **Dataset audio in the repository:** the 8 WAVs are dataset recordings. The origin remote is public; check that the dataset's terms allow publishing them before committing `assets/demo_recordings/`.
- **Demo sessions go to Firestore** (the user's choice) and cannot be deleted from the app; they are marked by `source: "wav"`, the note, `input_domain: "reference_dataset"` and the `demo_sess_` prefix.
- The 2026-10-11 device verification (build, ORT on device, persistence, offline) is recorded in `PRISM_AUTONOMOUS_PROGRESS.md` (untracked), not yet as an entry here.
- Not committed.

# Entry 9 — 2026-10-15: V2 pipeline audit (read-only) and INMP441 hardware recordings through the pipeline

## Objective
1. (2026-10-12 IST, under the user's strict read-only rules: no file changes, no V3/Stage 9 integration.) Audit whether the app runs the V2 deviation-scoring pipeline end to end, and whether live microphone audio reaches it.
2. (2026-10-15 IST.) Run two recordings from the user's ESP32 + INMP441 prototype through the app pipeline and the Python reference, and give the input level the detector expects. The recordings are `C:\CAPSTONE\hardware\inmp441_recording.wav`, outside this repository; the second run used a new file at the same path.

No file was changed in either task; this entry records them afterwards.

## What was inspected / changed
- **Call path traced** from audio source to UI, against `../PRISM smart inhaler/src/prism_inference.py` and the contract:
  - `pipeline/sources/*`, `pipeline/wav.js`, `pipeline/contract.js`, `pipeline/dsp.js`, `pipeline/OnnxDetector.js`;
  - `pipeline/InferencePipeline.js`: `buildWindows`, `runInference`, `decodeEvents`, `checkScoreability`, `extractEventPcm`, `scoreEvent`;
  - `pipeline/BaselineStore.js`, `services/*`, `utils/sessionView.js`, the screens and components.
- **The user's `C:\CAPSTONE\hardware\record_audio.py`** (read only):
  - the 8000 Hz WAV header is written by the script;
  - it reads 320,000 bytes from serial;
  - `pcm = (samples >> 16).astype(np.int16)`.
- Nothing changed.

## Results (V = run; O = read in code; N = not verified)
**V2 audit**
- **The full chain runs on the phone (O + V from earlier device reports):** 124 frame features → ONNX detector → Inhale events → scoreability → 4 V2 features → z against the frozen baseline → `anomaly_score = sqrt(mean z²)`, plus `mean_rms`. Device evidence:
  - Entry 4: 361 WAVs, 17,331 checks, device = Node with Δ = 0.
  - The 2026-10-11 run: 845 checks on native ORT 1.31.0, including features, z and score against the golden outputs.
- **No live input path (O).** There is no microphone capture code, no `RECORD_AUDIO` permission and no BLE library; `bleService` is simulated. Only WAV bytes (`WavPcmSource`) and the synthetic signal (`SimulatedPcmSource`) reach `pipeline.run()`.
- **Score data is stored and uploaded but never displayed (O).** This covers the score, z-scores, features, `mean_rms` and confidence; the `utils/sessionView.js` whitelist and the UI scan keep them off screen. This is the intended state:
  - the contract is `DRAFT_NOT_FROZEN`;
  - its gate fails on G4c (flatness tilt 0.9 = 0.750, centroid_std tilt 0.9 = 0.583);
  - `threshold` and `classification` are null.
- **Corrections to the task's context:**
  - The research repo is `C:\CAPSTONE\PRISM smart inhaler`; `C:\CAPSTONE\PRISM` does not exist.
  - The 8 demo recordings were matched with Python on the PC. On the phone, 1 demo recording and 1 random recording were run.

**Hardware recordings.** In both runs:
- **App pipeline:** run in Node with `createNodePipeline()` and `WavPcmSource(bytes, { inputDomain: "prism_hardware" })`.
- **Reference:** `venv/Scripts/python.exe -B src/prism_inference.py <wav> --input-domain prism_hardware`.
- **Comparison:** the outputs were compared field by field and saved to the session scratchpad (`hardware_run/`, `hardware_run2/`).

| | File 1 (SHA-256 `95cabefb…`) | File 2 (SHA-256 `2322fd0e…`) |
|---|---|---|
| Format | PCM16 mono 8000 Hz, 10.0 s, peak 0.29 | PCM16 mono 8000 Hz, 10.0 s, peak 0.20 |
| Output (app = Python, identical) | `NO_INHALATION_DETECTED`, 0 events | `NO_INHALATION_DETECTED`, 0 events |
| Detector windows | 614, all Noise; max P(Inhale) 0.002 | 614, all Noise; max P(Inhale) 0.000 |
| Sounds found (V, outside the contract) | bursts at 2.0–2.3 and 2.6–2.8 s; sustained 3.0–3.7 s and 5.4–6.1 s at −49 / −51 dBFS | bursts at 3.5–4.4 s; faint 4.4–5.0 s (−54.6 dBFS) and 7.7–8.3 s (−55.9 dBFS) |
| Diagnostic gain to near reference level (outside the contract) | Noise; one sound partly Drug (P 0.38) | Noise |

- **Start-up drift (V):** both files start with an I2S DC drift (down to −0.28 and −0.18) lasting about 1–2 s.
- **True sample rate (N):**
  - The header's 8000 Hz comes from the Python script, while `C:\CAPSTONE\hardware\log.md` describes the sketch capturing at 16 kHz.
  - A 100 Hz hum with no 50 Hz peak suggests 8 kHz.
  - Treating file 1 as 16 kHz also found no inhalation.
  - The user was asked to confirm.
- **Bit conversion (O):** `samples >> 16` on the 32-bit I2S word equals the contract's `s24 >> 8` for left-justified 24-bit samples.

**Expected input level** (V, in dBFS), from `../PRISM smart inhaler/results/inhale_dataset/inhale_events_v1.csv` and `results/representation_analysis/candidate_features.csv`:

| | min | p5 | median | p95 | max |
|---|---|---|---|---|---|
| Event `mean_rms`, 318 scored events | −21.8 | −17.6 | −14.7 | −12.5 | −7.1 |
| Event peak RMS (0.032 s frames), 364 events | −28.4 | −14.3 | −11.2 | −8.6 | −3.1 |
| Background RMS around scored events | −79.7 | −75.7 | −55.0 | −38.9 | −31.1 |
| Event above background (dB) | 15.9 | 23.3 | 40.3 | 61.2 | 71.3 |
| Scored event duration (s) | 0.5 | 0.9 | 1.6 | 2.3 | 3.3 |

- **Gap:** the hardware sounds were about 35–40 dB below the reference median.
- **Caveat:** these levels belong to the dataset's own recording chain, which is uncalibrated.
- **Sound pressure equivalent:** per the INMP441 datasheet (−26 dBFS at 94 dB SPL; not checked in this session), −15 dBFS is about 105 dB SPL at the microphone. That is realistic only with the microphone in or at the inhaler's airflow.
- **No digital gain:** gain is outside the contract (`s24 >> 8`, no preprocessing), and the detector depends on absolute level.

## Files changed
None.

## Tests (command and outcome)
No code change, so no tests were run for these tasks.

## Open issues / next step
- **Live audio is not implemented** (no microphone or BLE audio path). Hardware audio has only been run from WAV files on the PC.
- **Next hardware recording:**
  - a real inhalation through an inhaler, with the INMP441 at the mouthpiece or airflow;
  - discard the first ~2 s after I2S start;
  - a 1–2 s inhalation;
  - confirm the sketch's I2S rate is 8000 Hz.
- **V2 acceptance** despite gate G4c is the project owner's decision; until then the score stays internal.

# Entry 10 — 2026-10-15: Demo recordings licence, attribution, commits and push

## Objective
Resolve Entry 8's open licence issue with the licence the user gave for the dataset behind the demo recordings, then commit and push the work as the user asked.

## What was inspected / changed
- **Dataset identified (V, web):** the file-name pattern (`rec2018-01-22_17h41m33.475s.wav`) and annotation format match:
  - "Respiratory and Drug Actuation Dataset";
  - Stavros Nousias, Gerasimos Arvanitis, Aggeliki Anastasiou, Konstantinos Moustakas;
  - IEEE Dataport, 2022-03-02, doi:10.21227/g84h-ma24.

  The research repo does not record the source.
- **Licence: CC BY-NC-ND 4.0, as stated by the user.**
  - Not confirmed independently: the IEEE Dataport page text fetched on 2026-10-15 did not show the licence field.
  - The licence allows sharing verbatim copies for non-commercial use, with attribution. It does not allow sharing modified versions.
- **New `assets/demo_recordings/ATTRIBUTION.md`:**
  - **Contents:** citation, DOI, licence link, each file's dataset file name and SHA-256, and notes on the terms: unmodified (renamed only), non-commercial, no derivatives, no endorsement.
  - **Not bundled:** test 15 lists only `.wav` files and `demoRecordings.js` requires only the WAVs.
- **Commits on `ml-integration`:**
  - `146a64d` `feat: add demo recording analysis with waveform view`: the Entry 8 feature plus the attribution file.
  - `71ac527` `test: add output-shape probe and storage fixtures to device conformance runner`: the `appRunner.js` hooks used in the 2026-10-11 device verification.
  - A docs commit with this log, which includes Entries 3, 7 and 8 (until now uncommitted) and Entries 9 and 10.
- **Left uncommitted, as in every earlier commit:**
  - `app.json`, `package.json`, `package-lock.json`: the direct `expo-asset` and `expo-file-system` dependencies and the `onnxruntime-react-native` plugin line (Entry 7);
  - `PRISM_AUTONOMOUS_PROGRESS.md`, `prompt.md`, `rnconfig.json`, `skills-lock.json`, `.claude/`.
- **Push:** the user asked for a normal push (no force). It publishes these commits and the 8 earlier unpushed ones (`64b726b` … `4c65c4d`).

## Results (V = run)
- **WAV blobs (V):** the committed WAV blobs hash to the SHA-256 values in `DEMO_RECORDINGS` (`git show HEAD:assets/demo_recordings/demo_0N.wav | sha256sum`).
- **Secrets check (V):**
  - no key, token or private-key pattern in `git diff origin/ml-integration..HEAD`;
  - `firebase/config.js` is git-ignored and untracked;
  - the tracked `firebase/example_config.js` holds only a placeholder key.

## Files changed
New: `assets/demo_recordings/ATTRIBUTION.md`. Changed: this log.

## Tests (command and outcome)
- Before the commits: `npm test` → exit 0 (446 / 149 / 255 checks, 0 failed).

## Open issues / next step
- **In-app credit:** the demo note names the dataset file but not its authors or licence. If the APK is given to anyone, add a credit line in the app; the licence requires attribution wherever the recordings are shared.
- **User's config files:** the `app.json`, `package.json` and `package-lock.json` changes are still the user's to commit or drop.

# Entry 11 — 2026-10-15: Correction to Entry 10: the demo recordings come from the Kaggle pMDI dataset

## Objective
The user said the project does not use the dataset named in Entry 10, and gave the source: https://www.kaggle.com/datasets/stanou/pmdi-inhaler-use-audio-dataset. This entry corrects the attribution.

## What was inspected / changed
- **Entry 10 was wrong about the source.** It named the IEEE Dataport "Respiratory and Drug Actuation Dataset" (doi:10.21227/g84h-ma24), matched only by file-name pattern; the project does not use that dataset. Entry 10 and the message of the pushed commit `146a64d` are left as they are (append-only log, no history rewrite). This entry and the corrected attribution file supersede them.
- **Source (V, Kaggle API `datasets/view/stanou/pmdi-inhaler-use-audio-dataset`, fetched 2026-10-15):**
  - title "pMDI Inhaler Use Audio Dataset";
  - owner and creator Stavros Nousias (`stanou`);
  - licence CC BY-NC-ND 4.0 (this confirms the licence the user gave);
  - last updated 2021-08-31.

  The description asks users to cite two papers. Their author lists and DOIs were taken from Crossref:
  - Nousias et al., *IEEE Access* 6:11871–11882, 2018, doi:10.1109/ACCESS.2018.2809611;
  - Ntalianis et al., *Sensors* 20(8):2363, 2020, doi:10.3390/s20082363.
- **`assets/demo_recordings/ATTRIBUTION.md` rewritten** with this source, the licence and both citations. The file mapping, SHA-256 values and terms are unchanged.
- **Not checked:** whether the Kaggle files are byte-identical to `../PRISM smart inhaler/data`; the Kaggle download needs an account. Test 15 checks the demo files against that local copy.

## Results (V = run)
- `npm test` → exit 0 (446 / 149 / 255 checks, 0 failed).

## Files changed
`assets/demo_recordings/ATTRIBUTION.md`, this log.

## Tests (command and outcome)
- Before and after: `npm test` → exit 0 (446 / 149 / 255 checks, 0 failed).

## Open issues / next step
- **In-app credit:** still not added (Entry 10). If the APK is shared, it should credit the Kaggle dataset and its licence.

# Entry 12 — 2026-10-16: Why ESP32 + INMP441 recordings give NO_INHALATION_DETECTED (investigation, no code change)

## Objective
Find out whether PRISM's signal processing is responsible for detecting no inhalations in the ESP32 + INMP441 recordings, and separate five candidate causes: conversion, feature extraction, amplitude scaling, model inference and temporal post-processing. The user's constraints: no change to production code, the model, thresholds or gain.

## What was inspected / changed
- **Hardware (`C:\CAPSTONE\hardware`, outside this repo):**
  - `record_audio.py` and `log.md`, read only.
  - **The ESP32 sketch is not in the folder.** Its I2S configuration (rate, slot, mode) could not be read.
  - `log.md` still describes the sketch at 16 kHz; `record_audio.py:8` writes 8000 Hz into the WAV header.
- **Research repo:**
  - **Training path:** `train_cnn.py` (`__main__` lines ~375–419, `run_cnn_cv`), with `librosa_extractor.extract_features_from_audio` / `load_audio`, `feature_extractor.trim_to_events` / `create_windows`, `config.py` and `model_cnn.py`.
  - **Inference path:** `post_event.generate_window_predictions` / `group_inhale_events` / `TemporalGroupingConfig`, plus `prism_inference.check_input` / `read_wav` / `analyze_recording`.
  - **Not available:** the training feature cache (`data/extracted/`). The exact features the model was trained on cannot be compared byte for byte.
- **App:** `pipeline/wav.js` `decodeWav`, `pipeline/contract.js` `checkInput`, `pipeline/dsp.js` `processPcm`, `pipeline/InferencePipeline.js` (`extractFrameFeatures`, `buildWindows`, `runInference`, `decodeEvents`).
- **Nothing changed** in any repository. All diagnostics are scripts in the session scratchpad (`hw_diag/`).

## Results (V = run; O = read in code; N = not verified)
- **Recordings analysed (V):** `hw3` (SHA-256 `b85d0b86…`, 2026-10-16 12:51) and `hw4` (`cf88e459…`, 13:54). The two earlier hardware files were overwritten at the same path; only their outputs (Entry 9) remain.
- **Processing is the same in training, Python inference and the app (O).**
  - Audio is int16/32768 with no gain, DC removal or normalisation.
  - All three use the same 124-feature extractor (librosa_extractor; dsp.js in parity).
  - Windows: 25 frames, stride 2. No feature scaler in training (`train_cnn` feeds raw features; BatchNorm only inside the model).
  - Decision: softmax then argmax, no threshold.
  - Grouping uses the defaults: no smoothing, no minimum confidence or duration, max gap 0. Any single Inhale window therefore becomes an event, so grouping cannot drop one. Scoreability marks events but never removes them.
- **App = Python on both files (V):**
  - All 614 window labels are identical.
  - Probability difference ≤ 9.3e-10.
  - Frame features differ by at most 1.2e-4.
- **Detector output (V):** all 614 windows are Noise in both files. Max P(Inhale) is 0.0006 (hw3) and 0.0004 (hw4). The loss is at the classifier, not post-processing.
- **The I2S→PCM conversion is consistent with correct decoding (V, data checks; sketch N):**
  - Max |x| is 7256 and 13226, which rules out right-aligned 24-bit data, where `>>16` would give |x| ≤ 127.
  - Low bits are used uniformly (0.50 / 0.25 / 0.06 / 0.004 for 1 / 2 / 4 / 8 bits), so there is no truncation.
  - Even and odd samples have the same RMS (correlation 0.998), so there is no stereo interleave.
  - There is no clipping.
  - The code (`record_audio.py:49,53`, signed little-endian int32, arithmetic shift by 16) equals `s24 >> 8` for left-justified 24-bit samples.
- **Low frequencies dominate the hardware signal (V):**
  - Over 99% of power is below 20 Hz in both files, against −67 dB median in the reference.
  - The rms below 20 Hz is −30.5 dBFS in hw3 after the start-up drift (−0.19 to −0.20 FS at 0 s, settling over ~2 s).
  - **Effect on features:** during audio bursts, ZCR, centroid, flatness and rolloff sit at the 0th–15th percentile of reference inhale frames. After a 20 Hz high-pass, centroid, flatness and rolloff return to the 44th–76th; ZCR stays at the 1st–6th.
- **Gain changes only MFCC-0 (V).** It shifts by √128·ΔdB: −113 / −226 / −396 at −10 / −20 / −35 dB. MFCC 1–39 change by < 0.08 and the spectral features by < 0.002.
- **Hardware bursts are about 32 dB too quiet (V).** MFCC-0 sits at the 3rd percentile of reference inhale frames (median −517 vs −156). Burst levels (mean frame RMS) are −45.5 to −35.8 dBFS (hw3) and −41.2 to −30.0 dBFS (hw4), each 0.08–0.87 s long.
- **Controlled tests on 80 reference recordings with 85 annotated inhalations (seed 7; re-quantised to int16; unchanged detector) (V):**
  - **Gain sweep, recall:** 100% at 0, −3 and −6 dB; 98.8% at −9; 81.2% at −12; 29.4% at −15; 4.7% at −18; 0% at −20 to −50 dB.
  - **By absolute inhalation level (mean frame RMS):**

    | Level (dBFS) | Recall |
    |---|---|
    | ≥ −24 | 99–100% |
    | −27 to −24 | 80% |
    | −30 to −27 | 46% |
    | −33 to −30 | 15% |
    | < −33 | 0% |
  - **Hardware low frequencies (<20 Hz) added at the recorded level:** 100% at 0 dB. 98.8% and 80.0% at −9 and −12 dB, the same as without them. A constant DC of −0.03 FS also gives 100%. A 20 Hz high-pass does not rescue attenuated inhalations.
  - **16 kHz capture labelled as 8 kHz (simulated):** recall 0/85, with 9 spurious events.
- **Diagnostic transforms of the hardware files (V, outside the contract):**
  - hw4's sound at 3.0–3.3 s becomes Inhale (P 0.98, event 2.99–3.32 s) after a 20 Hz high-pass plus +30 dB (0.08% clipped). At +20 dB it reaches only P 0.445, below Noise in the argmax.
  - hw3's sounds become Drug, not Inhale (max P(Inhale) 0.125).

## Conclusions
- **No processing bug found.** Conversion, features, model execution, app/Python parity and grouping are all consistent.
- **Primary cause (V):** the detector is level-dependent by design (raw MFCC-0, no normalisation) and needs inhalations at about −24 dBFS mean frame RMS or louder. The hardware sounds are −45 to −30 dBFS.
- **Unknown (N):** whether these sounds were inhalations at all, and whether the INMP441 reaches that level when mounted at the inhaler airflow. The mic was not on the inhaler (`log.md`).
- **Unverified and fatal if true (N):** a sample-rate mislabel. The sketch is missing, and `log.md` says 16 kHz.
- **Not inferred:** that a gain stage is appropriate. Any input calibration would be a contract change and needs data from inhaler-mounted recordings.

## Files changed
This log only.

## Tests (command and outcome)
No code change; `npm test` not re-run.

## Open issues / next step
1. **Confirm the capture rate:** check the sketch's I2S rate, or record a known tone (e.g. 1 kHz) and check its frequency and the 10 s duration.
2. **Record controlled inhalations at the deployment position:** INMP441 mounted at the inhaler mouthpiece or airflow, quiet first ~2.5 s, 1–2 s inhalations.
3. **Measure each inhalation's mean frame RMS against the ~−24 dBFS edge,** then run the unchanged pipeline.

# Entry 13 — 2026-10-16: Five ESP32 + INMP441 recordings (`C:\CAPSTONE\hardware\recordingds`) through the unchanged detector

## Objective
Inspect the five recordings in `C:\CAPSTONE\hardware\recordingds` (outside this repo), then:
- measure their level, background and candidate acoustic events;
- run each original WAV through the unchanged detector;
- compare the results with the reference recall-vs-level statistics in Entry 12.

No model, feature extractor, threshold, firmware or pipeline change, and no transform of the WAVs before inference.

## What was inspected / changed
- **Recordings, 2026-10-16:** `inmp441_20261016_142709.wav` (SHA-256 `e2b74246…`), `_142744` (`3fbbb9e1…`), `_142806` (`9e9524d0…`), `_142823` (`8fc42967…`), `_142839` (`e3623b5f…`).
- **Not analysed:** `C:\CAPSTONE\hardware\inmp441_recording.wav` (14:26, `19f0b81e…`), which is not in `recordingds`.
- **Capture code (read only).**
  - **`record_audio.py`:** conversion unchanged (`"<i4"`, `>> 16`, header 8000 Hz); it now writes timestamped files to `recordingds/`.
  - **Sketch `C:\CAPSTONE\hardware\prism_hardware.cpp`** (file time 14:32, after the recordings) configures:
    - ESP_I2S `I2S_MODE_STD` (Philips);
    - `SAMPLE_RATE = 8000`, `I2S_DATA_BIT_WIDTH_32BIT`, `I2S_SLOT_MODE_MONO`, `I2S_STD_SLOT_LEFT`;
    - 80,000 samples sent as raw int32 bytes over `Serial.write` at 921,600 baud, after an `AUDIO_BEGIN` line.

  The configured rate matches the WAV header. The 16 kHz in `log.md` is outdated. The effective clock rate was not measured.
- **Existing tools reused, unchanged.**
  - **`../PRISM smart inhaler/results/recording_runs/run_recording.py`:** its `main(wav, "prism_hardware")` runs the contract output, per-window logits and probabilities, descriptive class segments and a diagnostic plot. It was imported by a wrapper that only redirects its `OUT_ROOT` to the session scratchpad, so nothing was written to the research repo.
  - **`post_event._rms_envelope`:** 256-sample frames, hop 64.
  - **`representation_analysis.recording_background_rms`:** the median of that envelope, the same definition as the reference background.
- **New, diagnostic only (no existing script provides these):**
  - an "audio-band" envelope: the same function on a 20 Hz high-passed copy, used only for measurement;
  - candidate acoustic events: audio-band envelope above background + 10 dB, gaps ≤ 0.1 s merged, ≥ 0.1 s kept.

  Neither touches inference.
- **No file changed** except this log.

## Results (V = run)
- **Integrity (V):** all five files are mono 16-bit PCM at 8000 Hz:
  - 80,000 frames (10.000 s), RIFF size consistent, chunks `fmt ` (16) and `data` (160,000), no trailing bytes;
  - soundfile and wave decode identically;
  - all bits used (low-bit-zero fractions 0.50 / 0.06 / 0.004);
  - no stuck samples (longest run of identical samples 3–5);
  - no sample at ±32767/−32768.
- **Capture problems (V):**
  - **Start-up DC:** −0.18 to −0.19 FS mean in the first 0.5 s in 3 of 5 files.
  - **Sub-20 Hz dominance:** −0.0 to −0.3 dB of total power, i.e. ≥ 93% of power below 20 Hz (reference median −67 dB).
  - **Integer wraparound in `_142806`:** at 3.478–3.519 s there are 18 sign-flip jumps between near +FS and −FS (max step 65,202). Unwrapping by ±65,536 gives a continuous waveform (max step 4,707) peaking at 36,444, 11% over int16 full scale. The over-range signal wrapped instead of clipping. Where the wrap happens (microphone overload or capture alignment) was not determined.

| File | Peak (dBFS) | Overall RMS (dBFS) | PRISM-envelope background, raw (dBFS) | Audio-band background (dBFS) | Candidate events, s (audio-band mean frame RMS, dBFS) | Detector (unchanged) |
|---|---|---|---|---|---|---|
| `_142709` | −10.9 | −23.1 | −32.4 | −60.0 | 3.12–3.41 (−38.9); 3.63–4.52 (−45.9); 5.63–6.46 (−43.7) | NO_INHALATION_DETECTED; 614/614 Noise; max P(Inhale) 0.0015 |
| `_142744` | −7.8 | −20.0 | −31.1 | −59.9 | 3.04–3.21 (−47.1); 3.58–4.56 (−40.7); 5.94–7.01 (−42.1) | NO_INHALATION_DETECTED; 614 Noise; max P(Inhale) 0.0004 |
| `_142806` | −0.0 (wrap) | −15.7 | −27.0 | −58.0 | 3.36–4.50 (−29.0); 5.10–6.27 (−39.0) | NO_INHALATION_DETECTED; 614 Noise; max P(Inhale) 0.0006 |
| `_142823` | −5.6 | −17.9 | −29.3 | −58.5 | 0.00–0.22 (−45.7, start-up); 4.81–5.84 (−37.4); 6.58–7.75 (−31.6) | NO_INHALATION_DETECTED; 613 Noise + 1 Drug (P 0.507 at 6.656 s); max P(Inhale) 0.0022 |
| `_142839` | −6.8 | −18.5 | −26.4 | −57.5 | 4.08–5.00 (−38.3); 5.95–7.36 (−36.8); 7.98–8.34 (−36.4) | NO_INHALATION_DETECTED; 614 Noise; max P(Inhale) 0.0064 |

- **Candidate events: 14 in total.**
  - Durations are 0.17–1.41 s; 9 last 0.8–1.4 s.
  - They sit 12.8–29.0 dB above the audio-band background (reference events: 23–61 dB, median 40).
  - **Level bands (Entry 12 recall curve):** 12 are below −33 dBFS (the ~0% band), 1 is at −31.6 (15% band) and 1 at −29.0 (46% band).
  - Inside every candidate the window argmax is Noise (min P(Noise) ≥ 0.998) except one Drug window in `_142823` at 6.66 s. Max P(Inhale) inside any candidate is ≤ 0.0015.
- **Background:** the audio-band background (−57.5 to −60.0 dBFS; −55.3 to −60.0 after 2.5 s) is close to the reference median (−55 dBFS). The PRISM-convention background on the raw waveform (−26.4 to −32.4 dBFS) is dominated by sub-20 Hz content.
- **App = Python (V):** the app pipeline (`pipeline.run()` and the per-window path, `prism_hardware`) gives the same status, window counts and max probabilities, to 6 decimals, on all five files.

## Interpretation (limits)
- **No candidate is a confirmed inhalation.** There are no annotations, and what was done during each recording was not recorded here.
- **Recall bands are not detection probabilities for these sounds.** The bands come from digitally attenuated reference inhalations of a different, uncalibrated recording chain. The audio-band level is a new diagnostic measure.
- **The loudest candidate (`_142806`, −29.0 dBFS) also contains the wraparound** and strong sub-20 Hz pressure.

## Files changed
This log only. Outputs are in the session scratchpad: `recordingds_runs/<stem>/` (run_recording.py outputs), `recordingds_runs/measurements.json`, and the scripts `recordingds_run_existing.py`, `recordingds_measure.py` and `recordingds_detail.py`.

## Tests (command and outcome)
No code change; `npm test` not re-run.

## Open issues / next step
- **Label the five recordings:** what was done, and when.
- **Explain the wraparound in `_142806`.** A loud steady tone (e.g. 1 kHz) at rising volume would show both the true rate (peak at 1000 Hz) and whether over-range signals clip or wrap, and at what level.
- **Record annotated inhalations with the INMP441 at the inhaler airflow,** without breath blowing straight onto the port.

# Entry 14 — 2026-10-16: The five recordings contain inhaler use; level-vs-shape probe (diagnostic only)

## Objective
The user stated that all five `recordingds` recordings (Entry 13) contain inhaler use, with the inhaler near the microphone, not mounted on it. The detector's five `NO_INHALATION_DETECTED` results are therefore misses. This entry tests whether level alone explains them.

## What was inspected / changed
- **Probe (`SP\recordingds_level_probe.py`, run twice, identical output).** For each of the 14 candidate sounds from Entry 13:
  1. remove content below 20 Hz from the whole recording;
  2. scale the recording so that this candidate's audio-band mean frame RMS reaches −24 dBFS (edge of ~99% reference recall), and separately −15 dBFS (reference inhalation median);
  3. re-quantise to int16;
  4. run the unchanged research detector (`generate_window_predictions` plus contract grouping).
- **Diagnostic only, outside the contract.** It is not a fix and not a proposal for gain in the product. The original files were not modified.
- **Outputs (session scratchpad):** `recordingds_runs/level_probe.json` and `level_probe_stdout.log`.

## Results (V = run)
- **No candidate becomes Inhale at either target.** 28 of 28 runs have zero Inhale windows inside the candidate, and the highest P(Inhale) in any of them is 0.0098. Clipping inside candidates is ≤ 2.7%.
- **At −15 dBFS, five candidates acquire Drug windows** (the model's aerosol-spray class):

  | Recording | Candidate | Drug windows | Max P(Drug) |
  |---|---|---|---|
  | `_142709` | 5.63–6.46 s | 33 of 52 (majority) | 0.985 |
  | `_142806` | 5.10–6.27 s | 25 of 73 | 0.921 |
  | `_142823` | 4.81–5.84 s | 8 of 64 | 0.964 |
  | `_142823` | 6.58–7.75 s | 15 of 74 | 0.935 |
  | `_142839` | 5.95–7.36 s | 24 of 88 | 0.949 |

  The other candidates stay Noise. That includes the loudest, `_142806` 3.36–4.50 s, which contains the wraparound.
- **The scaling also raises the background by the same gain,** so each candidate keeps its 13–29 dB margin over background (reference events: median 40 dB).

## Interpretation (limits)
- **Level is a confirmed cause, but not the only one.** Brought to reference loudness, these sounds are still classified as Noise or Drug, not Inhale. In this recording chain and placement, the inhaler-use sounds do not resemble the reference inhalations to the model.
- **Which candidate is the inhalation is still not labelled.** Whether the canister was actuated is not known either, so a Drug label cannot be judged right or wrong.
- **Possible contributors, not separated:**
  - microphone placement (reference: mic on the inhaler);
  - microphone and frequency-response differences;
  - lower margin over background;
  - airflow on the mic port;
  - limited generalisation of the detector, which was trained on 3 subjects and one device.

## Files changed
This log only.

## Tests (command and outcome)
No code change; `npm test` not re-run.

## Open issues / next step
- **Label the five recordings:** inhale and exhale times, and whether the canister was pressed.
- **Record with the INMP441 mounted on the inhaler,** as in the reference setup, and repeat Entries 13 and 14.
- **If mounted recordings are still not recognised,** the detector needs PRISM-hardware data. That is a research decision outside the current constraints.

# Entry 15 — 2026-10-16: DC offset, RMS and sub-20 Hz energy over time: `_150317` vs `_142744`

## Objective
Measure DC offset, RMS and energy below 20 Hz over time in the new recording `C:\CAPSTONE\hardware\recordingds\inmp441_20261016_150317.wav` (SHA-256 `96351973…`, 15:03), and compare it with `inmp441_20261016_142744.wav` (`3fbbb9e1…`, unchanged). The user did not say what was done during `_150317`.

## What was inspected / changed
- **Script:** `SP\dc_lf_compare.py`, read-only.
- **Method:**
  - 0.5 s blocks on the original int16/32768 samples;
  - one zero-phase 4th-order 20 Hz Butterworth low-pass splits each file into a component below 20 Hz and one at 20 Hz and above, which sum back to the original;
  - DC is the block mean; "wander" is the RMS of the below-20 Hz component with the block mean removed.
- **Outputs:** `SP\dc_lf_150317\dc_lf_compare.json`, plus the research CLI output `contract_output_150317.json`.
- **Unchanged:** sketch and `record_audio.py` (file times 14:32 and 14:27, before this recording). Nothing in either repo changed except this log.

## Results (V = run)

| | `_150317` | `_142744` |
|---|---|---|
| Format | mono, 16-bit, 8000 Hz, 10.000 s | same |
| Peak / overall RMS | −12.4 / −25.0 dBFS | −7.8 / −20.0 dBFS |
| DC, first 0.5 s | −0.185 FS | −0.037 FS (then −0.364 at 0.5–1.0 s) |
| DC after 2.5 s (mean) | −0.0031 FS | +0.0005 FS |
| DC behaviour | Smooth monotonic decay (−0.185, −0.129, −0.090, −0.044, −0.024, −0.011 at 0.5 s steps); 0.5 s blocks within ±0.01 FS from 3.0 s | Block means swing −0.36 to +0.05 FS throughout; never stays within ±0.01 FS |
| Sub-20 Hz wander after 2.5 s | −43.9 dBFS | −29.1 dBFS |
| Audio band (≥ 20 Hz) after 2.5 s, RMS | −56.7 dBFS | −45.5 dBFS |
| Audio band, quietest 10% of 0.5 s blocks after 2.5 s | −64.4 dBFS | −61.7 dBFS |
| Energy share below 20 Hz, whole file / after 2.5 s | 99.8% / 95.9% | 99.8% / 97.7% |
| Sub-20 Hz power below 5 Hz (Welch, after 2.5 s) | 87% | 94% |
| Detector (unchanged, research) | NO_INHALATION_DETECTED; 614/614 Noise; max P(Inhale) 0.0003 | NO_INHALATION_DETECTED (Entry 13) |

- **Audio-band activity in `_150317`:** only 3.0–4.5 s, at −56 to −49 dBFS (0.5 s blocks). In the same span `_142744` reaches −40 to −39 dBFS.

## Interpretation (limits)
- **Two different patterns.** `_150317` shows a start-up offset that decays smoothly and settles in about 3 s, and much less slow wander. In `_142744` the "DC" is continuous sub-5 Hz wander, which fits air pressure or handling at the mic.
- **Below-20 Hz energy still dominates both files.** That is because their audio-band content is so quiet.
- **Whether `_150317` is a quiet baseline or inhaler use with a different setup is not known.** The comparison describes the signals, not their cause.

## Files changed
This log only.

## Tests (command and outcome)
No code change; `npm test` not re-run.

## Open issues / next step
Ask the user what `_150317` contains. If it is a still baseline, its values (DC settling ≈ 3 s, wander ≈ −44 dBFS, audio floor ≈ −64 dBFS) are the device's own floor.

# Entry 16 — 2026-10-16: `_150317` is a silent baseline (user); device floor and burst check

## Objective
The user confirmed that `inmp441_20261016_150317.wav` is a silent baseline with no inhaler use. This entry records what that establishes about the device's own behaviour (Entry 15 measurements). It also checks whether the sound at 3.4 s in the silent file is a recurring device artefact at a fixed time after capture start.

## What was inspected / changed
- **Script:** `SP\burst_check.py`, read-only.
- **Recordings checked:** `_150317`, the five `recordingds` inhaler recordings, and today's 12:51 and 13:54 files (`hw3`, `hw4`).
- **Method:**
  - audio-band (≥ 20 Hz) RMS in 0.1 s steps from 2.0 to 5.0 s;
  - first onset after 2.5 s (a 32 ms frame at least 10 dB above the 20th-percentile frame);
  - spectral share of the 0.4 s after the onset;
  - sample continuity near the onset (maximum second difference relative to the file's 99.9th percentile).
- **Nothing changed** except this log.

## Results (V = run)
- **Device floor in silence (from Entry 15):**
  - Start-up offset −0.185 FS, decaying smoothly (−0.129 / −0.090 / −0.044 / −0.024 / −0.011 FS in successive 0.5 s blocks) and within ±0.01 FS from 3.0 s.
  - Slow drift below 20 Hz −43.9 dBFS after 2.5 s, 87% of it below 5 Hz.
  - Audio-band RMS: −56.7 dBFS after 2.5 s including the bump below; 0.1 s blocks in quiet stretches −58 to −66 dBFS (quietest 10% of 0.5 s blocks: −64.4).
- **The sound in the silent file:**
  - onset 3.43 s, peak frame −44.2 dBFS at 3.49 s, activity to about 4.6 s;
  - spectral centroid 77 Hz, 98.8% of energy at 20–300 Hz;
  - no sample discontinuity (ratio 0.7).
- **Onsets after 2.5 s in the other files vary:** 2.62, 3.02, 3.35, 4.62 and 4.07 s (`recordingds`); 2.80 s (`hw3`); 2.99 s (`hw4`).
  - **Spectral centroids:** 41–191 Hz in `_142709` and `_142744`; 599–1200 Hz in `_142806`, `_142823`, `_142839`, `hw3` and `hw4`.
  - **Continuity:** ratios ≤ 0.7 in all files, so no digital glitches.

## Interpretation (limits)
- **No fixed-time capture artefact was found.** The silent file's sound is a low-frequency event without a digital glitch, consistent with a mechanical bump or room sound. Its source is not known.
- **The device floor is lower than the reference background median (−55 dBFS),** so hardware self-noise is not what limits detection.
- **The inhaler sounds (−47 to −29 dBFS, Entry 13) are 15–35 dB above the device floor.** They are real captured sounds.
- **Some first onsets in inhaler files look like the silent bump.** `_142709` at 2.62 s and `_142744` at 3.02 s are dominated by energy below 300 Hz and may be handling rather than airflow (not verified).
- **The start-up offset is a device property.** About the first 3 s of each capture are not usable as audio.

## Files changed
This log only.

## Tests (command and outcome)
No code change; `npm test` not re-run.

## Open issues / next step
- **Start-up offset:** discard the first ~3 s, or have the sketch wait longer before `AUDIO_BEGIN`. That would be a firmware change, for the user to decide.
- **Recording setup:** keep the device still, and record annotated inhalations with the INMP441 mounted at the inhaler airflow.

# Entry 17 — 2026-10-16: Audio-only compatibility experiment for the ESP32 + INMP441 inhaler recordings (no production change)

## Objective
Find out whether audio preprocessing alone can make the existing pipeline detect real inhalations in the five ESP32 + INMP441 inhaler recordings. Audit the signal chain from capture to ONNX at the same time. The model, feature extractor, thresholds, inference, app and firmware must stay unchanged.

## What was inspected / changed
- **Recordings** (`C:\CAPSTONE\hardware\recordingds`):
  - inhaler use: `inmp441_20261016_142709/142744/142806/142823/142839.wav`;
  - silent baseline: `_150317.wav`.
  - **The supplied name `inmp441_20261016_142744(1).wav` was not found** (searched `C:\CAPSTONE`, Downloads, Desktop, Documents). `…142744.wav` (`3fbbb9e1…`) was used as a disclosed stand-in.
- **Code read:**
  - firmware `prism_hardware.cpp`; `record_audio.py`;
  - research `prism_inference.py`, `post_event.py`, `librosa_extractor.py`, `feature_extractor.py`, `train_cnn.py`, `model_cnn.py`, `config.py`;
  - app `pipeline/*`.
- **New workspace: `experiments/audio_compatibility/`.** All outputs and scripts live there; see its `README.md` and `summary.md`.
  - **Scripts:** `scripts/common.py` (imports the production functions unchanged), steps `01`–`09`, `transforms.py`, `plotlib.py`, `app_windows.mjs`, `compare_app_python.py`, `reproduce_best.py`, `run_all.sh`.
  - **Hand-made input:** `annotations.csv`, with ESTIMATED actuation / inhale / exhale intervals, ±0.10 s onsets and ±0.15 s offsets, and confidence.
- **No dependency installed** (the research venv already had everything). Scripts ran with `python -B`, so nothing was written to the research repo.

## Results (V = run; O = read in code; N = not verified)
- **Baseline (V):** all 6 files `NO_INHALATION_DETECTED`. Max P(Inhale) 0.0003–0.0064. One Drug window (142823, 6.656 s, P 0.507), inside the estimated exhalation. App = Python on all 6 (max |Δp| 6e-7).
- **Audit:**
  - **Correct (V/O):** decoding (`<i4`, `>>16`, LE, left slot, PCM header); 8 kHz time axis (1251 frames, 614 windows, 16 kHz rejected); feature parameters and known-answer tests; training/inference window layout and class order; ONNX logits / softmax / batch; timing with a synthetic burst (2.992 / 4.512 s for 3.0 / 4.5 s).
  - **Capture defect (V):** int16 wraparound in 142806 at 3.478–3.519 s; unwrapped peak 36,444. Its cause is N.
  - **Not verified (N):** the physical sample rate; byte-level training features (cache absent); I2S DMA sample drops.
- **Signal compatibility (V, annotated intervals vs 261 reference inhalations, production features):**
  - **Below-20 Hz share:** 94.8–99.8% of inhalation-interval power (reference ≈ 0%).
  - **Level:** MFCC-0 robust z −10.3, about 27 dB below the reference.
  - **Spectral shape:** reference inhale peaks +5.7 dB at 1.27 kHz; hardware inhale −0.9 dB there and +5.3 dB at 126 Hz.
- **Experiments (V):** 28 configurations × 6 files plus wraparound repair on 142806 (169 runs, deterministic; a rerun was byte-identical), all through `analyze_recording`. Configurations: trim, DC removal, moving-average detrend, HP 10–150 Hz (zero-phase/causal, order 2/4), gain, peak/RMS normalisation, upward compression, leave-one-recording-out EQ, and combinations.
  - **Detection:** 0/5 inhalations matched (IoU ≥ 0.2) and 0 Inhale windows inside any inhalation, in every configuration.
  - **False positives:** 0 Inhale events, including the silent baseline.
  - **Least bad:** `hp20_eqloo_rms-14`, max P(Inhale) inside 0.193.
  - **Side effect:** raising the level labels the estimated exhalations Drug (up to 170 windows).
  - **Reference safety:** HP 20/50/80 Hz and `hp20_rms-14` keep 40 reference recordings at 42/42 matched inhalations.
- **Feature diagnostics (V, outside the production path; modified tensors fed to the unchanged ONNX):**
  - **Hardware → reference:** hardware MFCC-0 drops reference inhale windows from 0.99 to 0.00 (to 0.93 after HP 20 Hz + RMS normalisation). Hardware MFCC 1–12 drops them to 0.03 before and after. Deltas, centroid, flatness, rolloff and ZCR have no effect (≥ 0.98).
  - **Reference → hardware:** reference MFCC 1–39 lifts processed hardware inhale windows to 0.92.
  - **Conclusion:** the decisive mismatch is the spectral envelope, and no tested global filter or gain corrects it.

## Files changed
- **New:** `experiments/audio_compatibility/**`, comprising:
  - scripts, CSV/JSON/MD results and plots;
  - `transformed_audio/` with 165 WAVs (about 25 MB, including 2 from testing `reproduce_best.py`).
- **Changed:** this log.
- **Unchanged:** originals, `assets/ml/`, the research model and `src/`, app `pipeline/`/`services/`/`screens/`, firmware.

## Tests (command and outcome)
- `bash experiments/audio_compatibility/scripts/run_all.sh` (end-to-end reproduction, about 15 min) → exit 0. `experiment_results.csv`, `baseline_results.csv`, `feature_ablation.csv` and `reference_transform_check.csv` are byte-identical to the first run. App = Python on 6 originals + 12 transformed files (max |Δp| 8e-7).
- **No production code changed;** `npm test` was not re-run for this entry.

## Open issues / next step
- **Annotations:** estimated without listening. 142744 and 142823 have a plausible alternative actuation/inhale split; no conclusion depends on it.
- **Tone test:** confirm the physical rate and over-range behaviour (wrap vs clip).
- **Placement test:** record annotated inhalations with the INMP441 mounted on the inhaler, as in the reference setup.
- **If still incompatible:** detection needs PRISM-hardware training data. That is a research decision outside these constraints.
- **Do not commit `transformed_audio/` (25 MB) without deciding to.** The repo is public, and the recordings are the user's.

# Entry 18 — 2026-10-16: On-board recording over BLE (ESP32 + INMP441), Stage 9 assessment, V3 status, UI

## Objective
Make the app's primary action an actual recording with the ESP32 + INMP441 over BLE, processed by the
existing pipeline (unchanged V2 contract). Add the research Stage 9 assessment, and handle V3
personalisation safely. Persist, sync and display the results with integrity checks and real failure
states. Keep demo and simulation as separate, labelled actions.

## What was inspected / changed
**Inspected:**
- the app;
- research `prism_assessment.py` (Stage 9), `personal_reference.py` and its README/contract (V3), `ARCHITECTURE.md` §9.4–9.8;
- the serial firmware and `record_audio.py` (`C:\CAPSTONE\hardware`, read only);
- the installed Arduino ESP32 core 3.3.12 (Bluedroid BLE).

**Firmware** (`firmware/`, new):
- `prism_ble_recorder/` streams 8 kHz audio while recording:
  - sequenced 12-byte-header packets;
  - a 5.4 s RAM ring for resends;
  - CRC-32 over the recording;
  - capture checks in META.
  - Live streaming because only about 118 KB of heap can be allocated with Bluedroid (measured), less than a 10 s buffer needs.
- `i2s_alignment_check/` finds which bits of the 32-bit I2S slot hold the sample.
- `tools/ble_record.py` is a PC reference client.
- Documentation: `PROTOCOL.md` and `README.md`.

**Phone:**
- `services/ble/`: `protocol.js`, `AudioReassembler.js`, `PrismRecorder.js`, `bleTransport.js` (react-native-ble-plx 3.5.1) and the test-only simulator `testing/fakePrismDevice.js`.
- `pipeline/sources/BlePcmSource.js` produces float32 = int16 / 32768 with input_domain `prism_hardware`.
- `services/recordingWorkflow.js` runs the lifecycle IDLE→CONNECTING→READY→RECORDING→TRANSFERRING→ANALYSING→COMPLETED/ERROR.
- `services/hardwareSession.js` builds the session record:
  - the V2 output, unchanged, under `recordings`;
  - Stage 9 under `assessments`;
  - V3 state under `personal`;
  - device, transfer and capture checks under `capture`.
- `services/audioFiles.js` keeps the raw WAV on the phone only.

**Stage 9:**
- `pipeline/ReferenceAssessment.js` ports `assess_event`/`assess_recording`/`validate_assessment_output`.
- The reference is copied verbatim to `assets/ml/final_assessment/` (SHA-256 `32ada36c…` = contract).
- Demo sessions now carry it too.

**V3:**
- `pipeline/PersonalReferenceStatus.js` ports the sitting and warm-up rules.
- Status is always UNAVAILABLE, with blockers:
  - not validated;
  - sitting definition incompatible: 10 scoreable inhalations per 25-min sitting against 1–2 in real use;
  - no hardware reference.
- The baseline update rule is not ported and no personal deviation is computed.

**UI:**
- **Dashboard:** recording panel with the lifecycle and real progress; the device banner; a Personal baseline card; a "Demo and test" section.
- **Device screen:** real scan, connect, identify and disconnect, showing device information. The fake battery and fake devices are removed.
- **Session detail:** the real waveform from the local WAV, a capture/integrity card, and a collapsed "Research measurements" section.
- **History:** 14-day trends of stored sessions.
- **Settings:** recording length 5/10/15 s; vibration on result; local audio size. The dead reminder switches are replaced by "not available".

**Config:**
- `react-native-ble-plx@3.5.1` (exact);
- `app.json` plugin entry with `neverForLocation`;
- the same permissions in the git-ignored generated `AndroidManifest.xml`.

**Display rule decision:**
- The user asked to show the "acoustic deviation score", which conflicts with CLAUDE.md §4 and research §9.4.
- It is shown only in the separate, collapsed Research measurements section, in the research wording ("acoustically within / outside the range of the reference recordings").
- It comes with the PRISM-hardware caveat and without NORMAL/ANOMALY, GOOD/POOR, %, quality or clinical wording.
- The UI scan in `utils/test_session_view.js` exempts only the word "deviation" in its two files.

## Results (V = run; O = read in code; N = not verified)
**I2S alignment (V, hardware, `firmware/i2s_alignment_check/RESULT_2026-10-16.txt`):**
- Philips framing (`bit_shift = true`, used by `ESP_I2S` and the serial sketch): bits 31..9 toggle and bit 8 is always 0. The sample is read one SCK late, so the sign is lost and values are doubled.
- MSB framing: bits 31..8 toggle and bit 31 equals bit 30.
- The recorder uses `bit_shift = false`.
- **Correction to Entries 12–17 (they stay unchanged):**
  - The serial recordings in `C:\CAPSTONE\hardware\recordingds` were captured with Philips framing, so their int16 values are doubled. Their level is therefore about 6 dB below what those entries stated: about 33 dB, not 27 dB, below the reference inhalations.
  - The "wraparound" in `_142806` is this framing effect: the loss of the sign bit, not a mic overflow.
  - The conclusions of Entry 17 (spectral shape mismatch, 0/5 detections) do not depend on level.

**BLE, PC (V):**
- 10 s recordings: 690/690 packets, CRC match.
- With every 7th packet dropped on purpose: 114 live gap requests, CRC match.
- A 4 s recording with drops was recovered after the recording.
- Measured capture rate 7996.8–8022.3 Hz (±0.3 % resolution).
- 0 DMA overflows, 0 ring overruns.
- Start-up DC transient gone: first-0.5 s mean +6/−52 against −6067 serial.

**Phone + ESP32 (V, OnePlus IV2201, Android 13, debug APK with embedded bundle):**
- **Permissions:** the "Nearby devices" prompt was answered on the phone; BLUETOOTH_SCAN and BLUETOOTH_CONNECT are granted.
- **Recordings:** five recordings (four of 10 s, one of 5 s) all verified: CRC phone = device, 690 (345) packets, 0 overflows, 0 clipping, alignment check passed.
  - Each took 10.4 s (5.4 s) from start to verified.
  - All NO_INHALATION_DETECTED (room sound), stored and synced to Firestore.
  - WAVs of 160,044 bytes are kept in app storage.
- **Settle fix:**
  - Run 1 needed 1 resend round: on Android the READY status overtook the last packets.
  - Fixed with a settle wait plus a regression test.
  - Runs 2–5 needed 0 rounds.
- **Parity on the phone's own data:**
  - The 4 kept WAVs have the device's CRC (mic → phone file bit-exact).
  - The research Python `assess_recording(..., input_domain="prism_hardware")` gives the same status and events (NO_INHALATION_DETECTED, 0) for all 4.
- **Stage 9 on the phone:**
  - Demo `rec2018-02-05_10h58m35.817s.wav` vs Python `prism_assessment.py`: every categorical field and the reason text are identical, the tail probability is exact, and the deviation differs by 2.2e-7.
  - Shown in Research measurements: 1.10, within, stable, 121 of 318.
- **Failure paths:**
  - ESP32 reset during scan → "Connect failed — No PRISM device was found nearby".
  - ESP32 reset 3 s into a recording → "Record failed — The connection to the PRISM device was lost", "Nothing was saved" (no session, no file), with "Connect device".
  - Reconnect, then record → success.
- **Other paths:**
  - Scan list (PRISM-4F42, −40 dBm) → connect.
  - Identify: delivered; the LED blink was N.
  - Remembered device: auto-reconnect after a cold start.
  - The simulated session still works.
  - Settings 5 s → 40,000 samples.
  - Final cold start: 20 sessions, all synced, the 13 pre-existing ones byte-identical, 0 JS errors, 0 FATAL.

**N:**
- Real inhalations from this hardware: the detector found none, consistent with Entry 17.
- Bluetooth-off and permission-denied UI on the phone: code paths tested in Node only, because toggling them is a device-wide or permission change.
- Offline sync of a BLE session on the phone: the sync code is unchanged and was verified offline in Entry 7; BLE records were synced online on the phone and offline/online in Node.
- Long-range and long-session behaviour.

## Files changed
**New:**
- `firmware/**`;
- `services/ble/**`, `services/{recordingWorkflow,hardwareSession,audioFiles,sessionWaveform,test_ble}.js`;
- `pipeline/{ReferenceAssessment,PersonalReferenceStatus,test_assessment}.js`, `pipeline/sources/BlePcmSource.js`;
- `utils/{recordingView,captureView,researchView,trendsView,test_recording_view}.js`;
- `components/{RecordingPanel,CaptureCard,ResearchMeasurements,TrendsCard}.js`;
- `assets/ml/final_assessment/**` and `assets/ml/personal_reference/{personal_contract_v3,personal_reference_config_v3}.json` (verbatim).

**Changed:**
- `services/{bleService,sessionRecord,storageService,demoSession,test_sessions}.js`;
- `pipeline/{wav,contractAssets}.js`;
- `context/AppContext.js`, `App.js`;
- `screens/*.js`;
- `utils/{sessionView,test_session_view}.js`;
- `package.json` (dependency, test script), `package-lock.json`, `app.json`;
- `android/app/src/main/AndroidManifest.xml` (git-ignored).

**Unchanged:**
- the ONNX model, the V2 baseline/contract/golden files;
- `InferencePipeline`, DSP, `FeatureExtractor`, scoring;
- `components/IssueList.js`, `components/ProgressBar.js`;
- `firebase/config.js`;
- the research repo and `C:\CAPSTONE\hardware`.

## Tests (command and outcome)
`PRISM_REQUIRE_DATASET=1 npm test`, before and after.

| Test file | Before | After |
|---|---|---|
| harness | all passed | all passed |
| contract | 446 | 446 |
| assessment (new) | — | 503 |
| sessions | 149 | 150 |
| ble (new) | — | 102 |
| session view | 255 | 264 |
| recording view (new) | — | 67 |

All pass with 0 skipped. `gradlew :app:assembleDebug` (JDK 17) → BUILD SUCCESSFUL; the APK has the BLE permissions and the new bundle.

## Open issues / next step
- **Hardware reference study:** record annotated inhalations with the INMP441 in its final placement, using this firmware. Detection and the Stage 9 reference are not validated for this microphone.
- **V3 personalisation:** needs a new sitting definition and a validation study before anything personal is shown.
- **Firmware:** the ESP32 runs the BLE recorder; the original serial sketch can be re-uploaded (see `firmware/README.md`).
- **Not committed:** nothing is committed. `experiments/` and `PRISM_AUTONOMOUS_PROGRESS.md` stay untracked.

# Entry 19 — 2026-10-21: Start Event split-source sessions (device capture for playback, reference recording for analysis), BLE firmware flashed

## Objective
The user's specification (`C:\Users\SJN\OneDrive\Desktop\prompt_app.md`, outside the repo) asks for this flow:
- **Start Event:** a short press selects an inhalation reference recording (random, never the same one twice in a row) and a long press selects a no-inhalation reference recording.
- **Capture:** the ESP32 then records 15 s for real. The capture is verified over BLE, saved and used for playback.
- **Analysis:** the selected reference recording is run through the unchanged pipeline and Stage 9. History restores each session; Trends counts only these sessions.
- **Firmware:** check BLE compatibility and flash with approval.

**Decision recorded:** the spec asked for no on-screen indication that a reference recording supplied the analysis. That conflicts with CLAUDE.md §4 ("No mocked detector outputs presented as real… Simulation output must be clearly marked"). Claude declined to build it without a disclosure. The user approved the specification **with one plain caption**, "Analysis input: reference recording", on the session (results and History) screen. There is no other disclosure, banner or extra button.

## What was inspected / changed
**Inspected:** the app's recording workflow, BLE recorder and protocol, session record, storage, sync, views, screens and tests; firmware `firmware/prism_ble_recorder/` and `firmware/PROTOCOL.md`; `C:\CAPSTONE\hardware\prism_hardware.cpp` (read only).

**Firmware compatibility (O, then V on hardware):**
- `prism_hardware.cpp` is a USB-serial sketch (`R` → `AUDIO_BEGIN`, raw int32) with no BLE, so it is not compatible with the app.
- `prism_ble_recorder` matches `services/ble/protocol.js` on every point: service and 5 characteristic UUIDs, properties, command bytes 0x01–0x06 and argument layouts, the 12-byte audio header, CRC-32 over int16 LE, STATUS JSON keys. 15 s = 120,000 samples is within 1,536–240,000.
- **Backup:** full 4 MB flash read with esptool 5.3.1 at 115200 baud (230400 failed with "Packet content transfer stopped"). Saved to the session scratchpad: `esp32_backup/esp32_full_flash_before_reflash_20261021.bin`, SHA-256 `c9efdb4d9454a22611b1817e31ad12c8c0de23c0f40723e06e1a837d027086b0`. It contains the serial sketch (`AUDIO_BEGIN`, `PRISM_CFG` strings). **The scratchpad is temporary**, so copy it somewhere permanent to keep it.
- **Flashed** `prism_ble_recorder` with the user's approval (`arduino-cli compile --upload -p COM7 --fqbn esp32:esp32:esp32:UploadSpeed=230400`; hash verified). Boot log: `prism-ble-recorder 1.0.0 ready as PRISM-4F42 (prism-esp32-582abdd44f42)`. The `build/` folder that arduino-cli exported into the sketch folder was moved out of the repo to the scratchpad.

**App — new files:**
- `services/analysisRecordings.js` (pure):
  - the configured recordings: the 8 demo recordings as `ref-inhalation-01..08`, plus `ref-no-inhalation-01`;
  - `pickAnalysisRecording` and `createAnalysisSelector`, which keep `@PRISM:analysisSelection` = `{ last_inhalation_id }` in phone storage;
  - `analysisSourceBlock`, `usesReferenceInput`, `analysisRecordingOf` and `verifyAnalysisBytes` (SHA-256).
- `services/analysisAudio.js` (app): loads the bundled analysis recordings (expo-asset) and their waveform.
- `assets/analysis_recordings/no_inhalation_01.wav`: a byte-identical copy of `rec2018-01-23_11h00m33.928s.wav`, the recording of the research golden case `no_inhalation_detected`. Comes with `ATTRIBUTION.md` (same Kaggle dataset, CC BY-NC-ND 4.0).
- `components/RecordingPlayback.js`: expo-audio player of `capture.audio.file` only. It says "Playback is not available…" when that file is not on the phone.
- `services/test_split_source.js`: 195 checks, added to `npm test`.

**App — changes:**
- **`sessionRecord.buildSessionRecord`:** optional `analysisSource` → `analysis_source` (added only when given).
- **`hardwareSession`:**
  - new `analyseReferenceInput` builds a Start Event session: the same `capture` block, analysis of the selected recording (SHA-checked, `WavPcmSource` with `input_domain` `reference_dataset`, unchanged `pipeline.run` and `assessRecording`), `personal` null, `note` null;
  - load, verify or pipeline failure → `PROCESSING_ERROR` with the capture kept; the capture is never analysed instead;
  - `analyseHardwareRecording` (genuine path) is unchanged except that it now adds `analysis_source: { type: "device_capture" }`; `captureBlock` was extracted without change;
  - `deviceHistory` (V3) ignores Start Event sessions.
- **`recordingWorkflow`:**
  - `run({ analysis })`: selection first (before any capture) → the unchanged capture and verification → new phase `SAVING` (the capture must be written, otherwise `STORAGE_FAILED` and no analysis) → `ANALYSING` → `COMPLETED`;
  - if the session cannot be built or stored, `discardAudio` removes the saved capture;
  - new codes `SELECTION_FAILED` and `STORAGE_FAILED`;
  - the genuine path and its lifecycle are unchanged.
- **`audioFiles`:** `recordingAudioUri` and `deleteRecordingAudio`.
- **`sessionWaveform`:** a Start Event session draws its analysis recording (its events are on that timeline). Label null, so no file name is shown. "Not available" when that recording is missing; it never draws the capture instead.
- **`AppContext`:**
  - `startEvent({ long })`: ignored while a recording runs; short press → `SELECTION.INHALATION`, long press → `NO_INHALATION`;
  - the selector uses AsyncStorage;
  - default `recordingSeconds` 10 → 15 (stored settings keep their value).
- **`RecordingPanel`:** "Test On-Board Recording" → "Start Event". Start Event, Try again and Record again all have `onPress` and `onLongPress` (600 ms); in RN Pressability a long press cancels the press.
- **`DashboardScreen` / `HistoryScreen`:** wiring and the empty-state text.
- **`SessionDetailScreen`:** the Recording card shows the waveform (no file label for Start Event sessions), the caption from `describeSession().analysisCaption`, and `RecordingPlayback` of `capture.audioFile`.
- **`sessionView`:** `REFERENCE_INPUT_CAPTION`, `analysisCaption`; reads only the explicit `analysis_source.type`.
- **`researchView`:** no hardware caveat when the analysis input is a reference recording.
- **`recordingView`:** `SAVING` state (Transfer step), the two error texts; failure detail is now "Nothing was saved from this attempt." The sentence "Demo recordings are not used in its place" was removed because the spec forbids "Demo" in the normal flow.
- **`trendsView` / `TrendsCard`:** count only `source "ble"` sessions whose `analysis_source.type` is `reference_recording`. Other device sessions go to `totals.excluded`, shown as "N other device recordings" under "Not counted". No inference from names, times or counts.
- **`test_recording_view.js` (spec-driven updates):** the failure-text regex, and the Trends fixture marks its device sessions as reference sessions; added checks for exclusion, a single session and missing values.
- **Dependency:** `expo-audio ~57.0.5` (`npx expo install`). The `app.json` plugin is set to `microphonePermission: false`, `recordAudioAndroid: false`, `enableBackgroundPlayback: false`. The APK requests no RECORD_AUDIO; expo-audio adds only `MODIFY_AUDIO_SETTINGS`.

**Unchanged:** the ONNX model, DSP, features, windowing, grouping, thresholds, `InferencePipeline`, `ReferenceAssessment` (Stage 9), `assets/ml/**`, the V2 baseline and the Stage 9 reference, BLE protocol and recorder, `prism_hardware.cpp`.

## Results (V = run; O = read in code; N = not verified)
**Tests (V):** `PRISM_REQUIRE_DATASET=1 npm test` → exit 0.

| Test file | Before | After |
|---|---|---|
| harness | all passed | all passed |
| contract | 446 | 446 |
| assessment (Stage 9) | 503 | 503 |
| sessions | 150 | 150 |
| ble | 102 | 102 |
| split source (new) | — | 195 |
| session view (UI scan) | 264 | 265 |
| recording view | 67 | 71 |

Before the update, 4 recording-view checks failed. All 4 were the intended spec changes (failure text, Trends filter); none was a regression.

**Configured recordings (V, Node):**
- all 9 have their SHA-256, are byte-identical to `../PRISM smart inhaler/data`, and are 8 kHz mono PCM16;
- each inhalation recording gives `EVENTS_DETECTED` with a scoreable event;
- the no-inhalation recording gives `NO_INHALATION_DETECTED`, 0 events, as its golden case.

**Build (V):** `gradlew :app:assembleDebug` (JDK 17) → BUILD SUCCESSFUL in 2m 18s. The APK contains `res/raw/assets_analysis_recordings_no_inhalation_01.wav`, `expo/modules/audio/AudioModule` and both new UI strings.

**Phone + ESP32 (V; OnePlus IV2201, Android 13; `adb install -r`, data kept):**
- **Setup:**
  - Bluetooth was off on the phone. The app showed its existing "Bluetooth is off" error (V), then Bluetooth was enabled with `cmd bluetooth_manager enable`.
  - Settings → recording length set to 15 s (the phone had 10 stored).
  - Scan found PRISM-4F42 at −36 dBm; connect read INFO (prism-ble-recorder 1.0.0, INMP441, 8000 Hz, protocol v1, 247-byte MTU).
- **Short press (Start Event):** `ble_sess_1792560697701`.
  - Capture: 120,000 samples, 15.0 s; CRC phone = device `50b1daf3`; 1,035 packets; 0 resend rounds; 0 DMA overflows; rate 7,988 Hz.
  - The WAV pulled from the phone has that CRC and is not the analysis file.
  - Analysis: `ref-inhalation-01`, 96,000 samples, 1 event 2.432–4.200 s SCORE_ONLY, Stage 9 WITHIN/STABLE.
  - Phone = Node: events identical except `detector_confidence` |Δ| 3.0e-9; anomaly_score and Stage 9 deviation identical.
  - Synced to Firestore.
- **Result screen:** status, Source "PRISM device (BLE)", 12.00 s analysis waveform with the inhalation shaded, the caption, and "Device recording 0.00 s / 15.00 s".
  - **Playback (V, system log):** expo-audio took audio focus at 11:03:30.69 and started an 8000 Hz AudioTrack; focus was released at 11:03:45.90 (15.2 s, the capture's length, not the analysis file's 12 s).
- **Long press:** exactly one new session, `ble_sess_1792560903108`: `no_inhalation`, `NO_INHALATION_DETECTED`, capture CRC `e8659f17` verified. The short-press state stayed `ref-inhalation-01`, so the long press did not also trigger a short press.
- **History / Trends:**
  - 26 sessions listed;
  - Trends "Device recordings (2)", "Inhalations detected (1)", "Not counted: 6 other device recordings, 11 demo, 7 simulated";
  - the no-inhalation session reopens with its waveform, caption and its own playback.
- **ESP32 reset 4 s into a recording** (RTS pulse on COM7): "Record failed — The connection to the PRISM device was lost… Nothing was saved from this attempt", Connect device. No session and no new WAV.
- **App force-stopped and relaunched:** the remembered device auto-reconnected. A short press chose `ref-inhalation-07`; the stored previous choice was `ref-inhalation-04`.
- **Capture file temporarily renamed:** the session screen shows the analysis waveform and "Playback is not available: the device recording is not on this phone."; no crash. The file was renamed back.
- **Integrity:** the 22 pre-existing local sessions are byte-identical; 0 FATAL; no JS errors in logcat.

**N:**
- the physical sound of playback (the speaker was not listened to);
- a human finger's long press (simulated with `input swipe` held 1.2 s);
- a storage-full failure on the phone (Node only);
- a transfer CRC failure on hardware (Node only);
- Bluetooth permission denial on the phone.

## Files changed
- **New:**
  - `services/{analysisRecordings,analysisAudio,test_split_source}.js`, `components/RecordingPlayback.js`;
  - `assets/analysis_recordings/{no_inhalation_01.wav,ATTRIBUTION.md}`.
- **Changed:**
  - `app.json`, `package.json`, `package-lock.json`;
  - `context/AppContext.js`, `components/{RecordingPanel,TrendsCard}.js`, `screens/{Dashboard,History,SessionDetail}Screen.js`;
  - `services/{audioFiles,hardwareSession,recordingWorkflow,sessionRecord,sessionWaveform}.js`;
  - `utils/{recordingView,researchView,sessionView,trendsView,test_recording_view}.js`;
  - this log.
- **Device state changed:**
  - ESP32 firmware (backup above);
  - phone Bluetooth turned on;
  - app setting 15 s;
  - 3 new sessions and 3 new WAVs on the phone, all 3 synced to Firestore (`ble_sess_1792560697701`, `…903108`, `…1053510`).

## Tests (command and outcome)
- Before: `PRISM_REQUIRE_DATASET=1 npm test` → exit 0 (see table).
- After: `PRISM_REQUIRE_DATASET=1 npm test` → exit 0, 0 failed, 0 skipped.

## Open issues / next step
- **Disclosure scope:** the caption is the only indication on screen. Elsewhere, Start Event results look like device results:
  - Dashboard "Last Session";
  - History cards;
  - the Trends counts, whose legend is still "Inhalations detected".
- **CLAUDE.md §4:** these sessions show detector results that did not come from the captured audio. This contradicts the rule as written, which the project owner accepted with the caption; record it in the project's own documentation if the app is presented.
- **Genuine analysis of the device audio is no longer reachable from the Dashboard,** because every start control is a Start Event. The code path (`startOnBoardRecording`, `analyseHardwareRecording`) is kept and tested.
- **The labelled "Demo and test" buttons on the Dashboard are unchanged** (existing features; the spec did not ask for their removal explicitly).
- **Session `recorded_at` is null for Start Event sessions,** because the analysis input has no recording time. History and Trends use the save time, and the capture time is in `capture.recorded_at` (shown under "Recording and transfer").
- **Not committed.** Copy the flash backup out of the scratchpad if the serial firmware may be needed again.

# Entry 20 — 2026-10-21: Local session history cleared on the phone (Firebase untouched)

## Objective
The user had already deleted the Firebase session history. This task clears the phone's local session history, with a backup first, so that PRISM starts from an empty history before personal-baseline scoring. Constraints:
- no Firebase operation;
- no change to source code, models, reference data, firmware, settings or the auth record;
- no app wipe or reinstall;
- selective removal only.

(The read-only scoring and personal-baseline audit that came just before was not logged, because the user asked for no file changes in that task.)

## What was inspected / changed
**Storage, from the source:**
- AsyncStorage (`@react-native-async-storage` 2.2.0, Android SQLite `databases/RKStorage`, table `catalystLocalStorage`):
  - `@PRISM:session:<id>`: session records with their sync state (`services/localSessionStore.js`);
  - `@PRISM:settings` (`context/AppContext.js`);
  - `@PRISM:analysisSelection` (`services/analysisRecordings.js`);
  - `@SmartInhaler:lastDevice` (`services/storageService.js`);
  - the Firebase Auth persistence key (`firebase/firebaseConfig.js`, `getReactNativePersistence`).
- Capture audio: `files/recordings/*.wav` (`services/audioFiles.js`).
- Firestore: `getFirestore()`, an in-memory cache only, so no persistent Firestore cache exists on the device.
- **There is no separate sync queue.** Pending state is `sync.state` inside each session entry (`services/syncService.js`).
- **There is no persistent personal-baseline state.** V3 exists only as the `personal` snapshot inside session records.

**Phone, app force-stopped:** `files/prism_conformance/` (conformance fixtures and results from Entries 4 and 6), `cache/` (expo-asset copies of the bundled WAVs, ONNX model and font; OkHttp `http-cache`), `shared_prefs/` (WebView, expo). None of these holds session history; all were left alone.

**Backup:** `C:\CAPSTONE\backups\prism_local_sessions_2026-10-21\` (`README.md`), containing:
- `session_records.json`: the 28 entries;
- `recordings/`: the 12 WAVs, SHA-256 identical to the phone;
- `referenced_wavs.json`;
- `rollback_full_database/RKStorage`: a byte-identical copy, SHA-256 `56ec443c…`. **It contains the Firebase sign-in record; delete it once it is no longer needed.**

**Cleared:**
- **Database:** the 28 `@PRISM:session:*` keys were deleted with SQLite on the pulled copy, followed by `VACUUM` (integrity `ok`). The copy was written back with `adb exec-in run-as … cat > databases/RKStorage` while the app was stopped, after checking that the phone file still had SHA-256 `56ec443c…`. Result: `cd359815…`, same owner and mode, journal still empty.
- **Audio:** the 12 `files/recordings/*.wav` files were removed by name. Each had been confirmed as referenced by one of the cleared sessions (`capture.audio.file`) and present in the backup.

## Results (V = run)
**Before:**
- 32 keys: 28 sessions (5 simulation, 11 demo `wav`, 6 device-analysed `ble`, 6 Start Event); all 28 `synced`, 0 pending; 14 with Stage 9 `assessments`, 6 with a `personal` snapshot.
- 12 WAVs, all referenced, none orphaned.

**After:**
- 4 keys (`@PRISM:settings` 15 s, `@PRISM:analysisSelection`, `@SmartInhaler:lastDevice`, auth), each byte-identical to before; 0 session keys; 0 WAVs.

**App relaunched:**
- Dashboard: "No sessions yet"; the device auto-reconnected; "All sessions on this phone are synced".
- Personal baseline card: "Not available", without the earlier device-sitting line.
- History: "No sessions yet", so Trends is not drawn.
- Settings: 15 s, "0 recordings, 0.0 MB".
- After the Firestore history fetch: still 0 session keys; 0 FATAL; no JS errors.

**Unchanged:** `assets/` (git status), the ONNX model, Stage 9 reference and V2 baseline (SHA-256 prefixes `2e4e72d3`, `32ada36c`, `0eaea4b8`), `assets/analysis_recordings/`, `../PRISM smart inhaler/data` (2,167 files), the phone's conformance fixtures and asset cache, firmware, source code.

**Correction within this task:** a phone listing truncated with `head -40` first suggested that one referenced WAV was missing. A full listing showed all 12 present. There was no anomaly.

## Files changed
This log only (repo). Outside the repo: the new backup folder. On the phone: `databases/RKStorage` (session keys removed) and `files/recordings/` (emptied).

## Tests (command and outcome)
`PRISM_REQUIRE_DATASET=1 npm test` → exit 0 (446 / 503 / 150 / 102 / 195 / 265 / 71 checks, 0 failed).

## Open issues / next step
- **Session-history copies remain in the session scratchpad** (temporary): earlier device snapshots `device/RK*.db`, `cap1.wav`, `cleanup/`. They also contain the sign-in record.
- **`@PRISM:analysisSelection` was kept** (Start Event no-repeat state, not history). Remove it only if the selection sequence should restart.
- **Restoring the local backup would not restore Firestore.**

# Entry 21 — 2026-10-21: Product presentation — demo/simulation controls removed, user-facing wording polished

## Objective
User sections 18–20:
- **Remove from the product UI:** the "Run Simulated Session" and "Analyse Demo Recording" controls, demo/development terminology, technical status details.
- **Rule from the user (D/H):** keep internal provenance correct, and keep a concise source disclosure where it is needed to avoid a misleading claim.
- **Unchanged:** Start Event, BLE, capture, playback, inference, V2, Stage 9 and personal-baseline logic.

## What was inspected / changed
**Located:** both controls in `screens/DashboardScreen.js`, in a "Demo and test (not device recordings)" section:
- `handleSimulate` → `services/simulationService.runSimulatedSession`;
- `handleDemo` → `services/demoRecordings.runDemoSession`.

There are no other entry points: the navigation has 4 tabs + SessionDetail. `index.js` loads `tools/device_conformance/appRunner` only under `__DEV__`; it has no UI and is kept as developer tooling.

**Removed from the UI (presentation only):**
- **Dashboard:**
  - the section label, both buttons, their hints, handlers, state (`isSimulating`, `isAnalysingDemo`, `busy`), the Alert, unused imports and styles;
  - in the Personal Baseline card, the research blocker text and the "This device: N sittings…" line.
- **SessionDetail:** the waveform's file-name label (`waveform.label`: capture or dataset file name).
- **CaptureCard (title "Device recording"):** the Firmware and Sample-rate rows and the per-check list. It now shows one line, "Received complete and verified", plus any failed check. `utils/captureView.js` is unchanged; the stored record keeps all checks.
- **DeviceScreen:** the Microphone, Sample rate, Link (protocol/MTU) and Resend buffer rows.
- **Settings:** the "BLE Protocol", "Target Device" (ESP32 + INMP441) and "Analysis" (V2 contract + Stage 9) rows; "1.0.0-beta" (now 1.0.0, as `app.json`); "Built with Expo + Firebase"; the Firebase wording.

**Reworded:**
- **Results section:** "Research measurements" → "Acoustic assessment" (icon `analytics-outline`).
- **Interpretation:** "a research reference dataset" → "the PRISM reference recordings" (`INTERPRETATION`).
- **Personal Baseline:** one concise line, `PERSONAL_BASELINE_UNAVAILABLE_TEXT`, used on the Dashboard and in the results section.
- **Source tags:** SIM/BLE/WAV → Simulated / Device / File.
- **Source label:** `SOURCE_TEXT.ble` "PRISM device (BLE)" → "PRISM device".
- **Sync message:** "offline, or Firebase not configured" → "offline or not signed in".
- **Trends:** "Device recordings (N)" → "Sessions (N)"; footer "… N other sessions not included." in place of "demo/simulated" counts.
- **Recording view:**
  - COMPLETED "Recording analysed and saved" → **"Event saved"**: the old title was false for Start Event sessions, whose device recording is not analysed;
  - the verified detail → "The recording arrived complete.";
  - the Device-screen note no longer says the phone checks the recording "before analysing it" (now "before saving it").
- **Settings:** "Raw audio on this phone" → "Recordings on this phone"; "Anonymous User ID"/ANON → "Account ID"/GUEST; a concise limitation note in About.

**Kept:**
- **Internal, unchanged:** `simulationService`, `demoSession`, `demoRecordings`, all assets, the analysis-source metadata.
- **Retained disclosure:** the "Analysis input: reference recording" caption, needed for correct interpretation.

**Not done (G):** no "Set up baseline" action. No personal-baseline implementation exists (audit, 2026-10-21), so the button would be a non-functional placeholder, which section 20 forbids. The card states the true status.

## Results (V = run)
**UI audit:** all 24 modules reachable from `App.js`, comments excluded, searched for demo, simulat, develop, fixture, dataset, debug, firebase, expo, BLE, WAV, INMP, ESP32, contract, rec2018, ref-inhalation, beta, research. Remaining matches:
- **Internal only:** source codes `"ble"`, `"wav"`, `"simulation"` in logic; the `App.js` LogBox string; `PERSONAL_BLOCKER_TEXT.UPDATE_RULE_NOT_PORTED`, no longer rendered.
- **Legacy-record disclosure:** the "Simulated" tag/label/banner and "WAV file"; the stored `note` banner (old demo notes contain a dataset file name, and the genuine-device note names ESP32 + INMP441). None of these sessions can be created from the UI now, and the local history is empty.
- **Interpretation:** "reference upper limit" (the Stage 9 acoustic reference range); `HARDWARE_CAVEAT` (genuine device sessions only).

**APK:** `gradlew :app:assembleDebug` (JDK 17) → BUILD SUCCESSFUL. The bundle contains "Acoustic assessment", "Personal baselines are not available", "Analysis input: reference recording" and "Start Event", and none of "Analyse Demo Recording", "Run Simulated Session", "Demo and test", "Research measurements", "Built with Expo".

**Phone** (`adb install -r`, data kept; no Start Event pressed, to keep the cleared history empty):
- the Dashboard ends with the Personal Baseline card; there is no demo section;
- Device and Settings show the trimmed rows;
- 0 session keys, 0 recordings, 0 FATAL, 0 JS errors.

**Workflow files untouched by this task** (mtimes before it): `services/recordingWorkflow.js`, `hardwareSession.js`, `analysisRecordings.js`, `analysisAudio.js`, `context/AppContext.js`, `services/ble/*`.

## Files changed
- `screens/{Dashboard,SessionDetail,Device,Settings}Screen.js`;
- `components/{CaptureCard,ResearchMeasurements,StatusTag,TrendsCard}.js`;
- `utils/{researchView,sessionView,recordingView}.js`;
- tests: `utils/test_recording_view.js` (verified-detail regex `/checksum/` → `/arrived complete/`), `services/test_split_source.js` (source label);
- this log.

## Tests (command and outcome)
- Before (end of Entry 20): `PRISM_REQUIRE_DATASET=1 npm test` → exit 0.
- After: exit 0 (446 / 503 / 150 / 102 / 195 / 265 / 71, 0 failed). One intermediate run failed on the pinned `/checksum/` regex before it was updated.

## Open issues / next step
- **The Personal Baseline "Set up" experience needs a baseline implementation and its specification first** (audit §10). Not started.
- **Old note and source labels** would reappear only for legacy demo or simulated records (none exist).
- **Not committed.**

# Entry 22 — 2026-10-21: Start Event analyses the device recording; personal baseline implemented

## Objective
User's corrective task:
- **Start Event:** make the actual ESP32 recording the analysis input (no reference WAV in the product flow), with truthful result wording.
- **Personal baseline:** implement a persistent, functional one (versioned, setup/reset, eligibility, version recorded per comparison).
- **Unchanged:** the model, 124-feature contract, DSP, Stage 9 and V2 formulas. Real-device detection must not be forced.

## What was inspected / changed
**Data flow before (Entries 19–21):**
1. Start Event → `AppContext.startEvent({ long })` → `workflow.run({ analysis: SELECTION.* })`.
2. `selectAnalysis` → `services/analysisRecordings.createAnalysisSelector` picked a bundled WAV.
3. BLE capture → `PrismRecorder.record()` (CRC) → `keepAudio` (`services/audioFiles.saveRecordingAudio`, `files/recordings/*.wav`).
4. `analyseReferenceInput` ran the pipeline on the **bundled WAV** (`WavPcmSource`, `reference_dataset`); the capture was only played back.

**Data flow now:**
1. Start Event → `startEvent()` = `startOnBoardRecording()` → `workflow.run({ nSamples })` (no selection).
2. Capture and CRC verification.
3. **SAVING** (required; `STORAGE_FAILED` otherwise, no analysis).
4. `analyse(recording)` → `analyseHardwareRecording`: `BlePcmSource` (float32 = int16/32768, `prism_hardware`) → unchanged `InferencePipeline.run()` → Stage 9 `assessRecording` → V3 status → `comparePersonal`, against the baseline as stored before the session.
5. Session stored; then `personalBaselineStore.observe(record)`.

The analysed samples are the samples written to the WAV (the same `recording` object).

**Reference path:** `run({ analysis })` and `analyseReferenceInput` are kept as an internal, tested path (`services/test_split_source.js`). The app context no longer wires it, and its sessions are labelled `analysis_source.type = "reference_recording"`.

**Device-audio investigation (reused `experiments/audio_compatibility/scripts/app_windows.mjs` + `compare_app_python.py`):**
- **Inputs:** the 12 BLE captures in the 2026-10-21 backup.
- **Format:** all 8000 Hz mono, CRC = device, DC ≤ 6e-4, no clipping; RMS −55.5 to −22.9 dBFS, peaks up to −2.4 dBFS.
- **Detector:** every window Noise; max P(Inhale) ≤ 0.009.
- **App = Python:** identical labels, max |ΔP| ≤ 6e-8.
- **No preprocessing mismatch found.** The blocker is the acoustic domain mismatch of Entries 12–17. Nothing was changed to force detections.
- **The 3 earlier Start Event sessions that had "detected" an inhalation give `NO_INHALATION_DETECTED` on their own device audio**, which confirms their results were the reference recording's.

**Personal baseline — new, pure: `pipeline/PersonalBaseline.js`**
- **Formulas from V3** (`personal_reference.py`, checked):
  - coordinates = the Stage 9 robust z (`feature_deviations`);
  - B = per-feature `numpy.median` of the enrollment z (V3 `reenroll`), with ≥ `min_events_per_sitting` = 10 events;
  - personal deviation = sqrt(mean (z − B)²) (V3 a_u).
- **App policy (documented in the module):**
  - enrollment = scoreable events of genuine device recordings made after "Set up baseline";
  - READY at 10; then fixed (no V3 update or warm-up; trust radius not applied, rms(B) kept as `population_distance`);
  - assess before adapt.
- **Eligibility:**
  - `source "ble"`, same `device_id`, `analysis_source "device_capture"`, `capture.integrity.verified`, assessment `input_domain "prism_hardware"`;
  - SCOREABLE events with 4 finite z;
  - idempotent per session and event.
- **`validateBaseline`:** rejects other devices, non-finite z, duplicates, and a center that differs from the median of the enrollment.

**Storage — `services/personalBaselineStore.js` (new):**
- Key `@PRISM:personalBaseline:<device_id>` in AsyncStorage; JSON schema `prism-personal-baseline-v1`; local only, not synced.
- **Actions:** `load` (missing → NOT_SET_UP, unreadable or invalid → UNAVAILABLE, never used), `setup` (version + 1, COLLECTING), `reset` (NOT_SET_UP, version kept), `observe`.
- **Content:** id `pb-<device>-v<n>`, profile (device, user, domain), coordinates (Stage 9 reference id), enrollment z rows, center, `established_at`, an audit log of setup / ready / reset.
- **Instance:** created in `services/appServices.js`.

**Session record:** `personal_comparison` (schema `prism-personal-comparison-v1`), with `baseline_id` and `baseline_version`.
- **Statuses:** NOT_SET_UP, NOT_ELIGIBLE, COLLECTING (`collected_before`, `contributes`, `required`), NO_SCOREABLE_EVENTS, COMPARED (per-event `personal_deviation` and `personal_feature_deviations`).
- **Where it is built:** `sessionRecord.buildSessionRecord` (`personalComparison`) and `hardwareSession.analyseHardwareRecording` (`personalBaseline` option).

**Workflow (`services/recordingWorkflow.js`):**
- one post-capture path, `saveAndAnalyse` (SAVING → ANALYSING → stored);
- `sessionExists` added: a saved file is removed only if no stored session refers to it (fixes the Entry 19 case where `save` could throw after storing).

**AppContext:**
- `startEvent` = device recording;
- the baseline is loaded for the connected or last device;
- `setupPersonalBaseline` and `resetPersonalBaseline`;
- `analyse` passes the stored baseline; `save` stores, then observes (errors there never fail the session);
- the selector and reference wiring are removed.

**UI:**
- **Start Event:** one gesture (the long press existed only to choose a reference WAV).
- **Completion title** from the stored status:
  - "Recording analysed and saved" (events);
  - "Recording saved — no inhalation detected";
  - "Recording saved — assessment unavailable" (INPUT_ERROR / PROCESSING_ERROR).
- **Dashboard Personal Baseline card** (`utils/baselineView.js`):
  - Setup required + **Set up baseline**;
  - Setting up, with "k of 10 measured inhalations collected", a progress bar and Reset;
  - Ready (version, date, n) + Reset;
  - Unable to establish baseline + Set up;
  - "Connect device" when no device is known.
  - Reset asks for confirmation.
- **Session screen:**
  - new `components/PersonalComparisonCard.js` (`researchView.describePersonalComparison`): numbers only for COMPARED, otherwise the reason in words, plus the baseline version;
  - "Measured" (scoreable) count replaces "Recordings" (also on Dashboard and History cards).
- **Results section:** the old V3 "not available in this version" text is removed (`PERSONAL_BASELINE_UNAVAILABLE_TEXT` deleted).
- **Trends:** counts device sessions analysed from their own recording; reference-input sessions are `excluded`. Personal values are not trended, because they depend on the baseline version.
- **Device-session note:** shortened: "Recorded and analysed with your PRISM device. The inhalation detector was developed with recordings from a different microphone and has not yet been validated with this device."
- **The "Analysis input: reference recording" caption** now appears only for reference-input sessions; none are produced by the app.

**Unchanged:** the ONNX model, DSP/124 features, windows, grouping, scoreability, V2 scoring, Stage 9 code and reference, `assets/ml/**`, firmware, BLE protocol/recorder, playback.

## Results (V = run; N = not verified)
**Tests** (`PRISM_REQUIRE_DATASET=1 npm test` → exit 0):

| Test file | Checks | Note |
|---|---|---|
| harness | all passed | |
| contract | 446 | |
| assessment | 503 | |
| sessions | 150 | |
| ble | 102 | |
| split source | 195 | |
| personal baseline + device workflow | 74 | new |
| session view | 267 | UI scan covers the 2 new UI files |
| recording view | 71 | |

**Test changes:**
- **Updated** (intended behaviour change):
  - `test_ble` 5a: lifecycle includes SAVING; 5b: `keepAudio` returns a file name;
  - `test_split_source` §5 (lifecycle), §6 (Trends now exclude reference-input sessions), §7 (Start Event = device input; no reference wiring in the app context);
  - `test_recording_view` §4 (Trends fixture: device sessions counted, reference-input excluded).
- **New `services/test_personal_baseline.js`:**
  - **Input:** the device recording is the inference input and equals the saved file (CRC, run on the file = stored result, Stage 9 equal).
  - **Failures:** corrupt transfer, wrong CRC and disconnect give no analysis and no session; an analysis failure keeps the recording; a stored session never loses its file.
  - **Outcomes:** completion titles; V3 formulas.
  - **Lifecycle:** setup → 10 measured inhalations → READY (B = median) → COMPARED with version 1 → fixed → restart → reset keeps sessions, files and assets → v2 → corrupt and tampered state rejected.
  - **Eligibility:** reference-input sessions, unverified transfers, other devices, other domains, non-finite and unscoreable events are never enrolled.
  - **Contracts:** model, baseline and reference unchanged; views.
  - **Honesty note:** the READY path uses bundled inhalation audio streamed by the protocol simulator as its microphone signal. It checks the mechanism, not real-device detection. Each bundled recording gave 1 scoreable event through the BLE path (probe, V).

**Android:** `gradlew :app:assembleDebug` (JDK 17) → BUILD SUCCESSFUL. The bundle contains "Set up baseline", "Personal comparison", "Recording analysed and saved", and both "Recording saved — …" titles (UTF-16 in the Hermes bundle).

**Phone + ESP32** (OnePlus IV2201, PRISM-4F42, `adb install -r`, data kept):
- **Setup:** the Dashboard showed "Setup required" with **Set up baseline**. Pressing it stored `@PRISM:personalBaseline:prism-esp32-582abdd44f42`: v1, COLLECTING, `prism_hardware`, coordinates `prism-assessment-ref-2026-10-06`.
- **Start Event** (room sound, no inhalation performed) → "Recording saved — no inhalation detected". Session `ble_sess_1792570518113`:
  - `analysis_source device_capture`;
  - inference input `prism_ca7bf5b8` (= capture id), 120,000 samples, `prism_hardware`;
  - CRC phone = device `f5776374`;
  - `personal_comparison` COLLECTING (0 before, 0 added); baseline still 0 enrolled; synced.
- **PC check of the pulled WAV:** CRC `f5776374`; app and Python both `NO_INHALATION_DETECTED`, labels identical, |ΔP| 6e-8; RMS −52.1 dBFS.
- **Session screen:** the note, "No inhalation detected", the 15.00 s waveform of the device recording, playback of the same file, "Received complete and verified", Measured 0, Personal comparison "…added none · version 1", Acoustic assessment "0 measured inhalations". No reference caption.
- **App restart:** the baseline was still "Setting up, 0 of 10".
- **Reset:** confirmation → "Setup required"; the session and its WAV kept; the version counter (1) and log (setup, reset) kept.
- **Errors:** 0 FATAL, 0 JS errors.

**N:**
- a READY baseline from real ESP32 inhalations (the detector finds none);
- a personal comparison on the phone;
- a human finger press on Set up / Reset (simulated taps).

## Files changed
- **New:**
  - `pipeline/PersonalBaseline.js`;
  - `services/personalBaselineStore.js`;
  - `services/test_personal_baseline.js`;
  - `utils/baselineView.js`;
  - `components/PersonalComparisonCard.js`.
- **Changed:**
  - `context/AppContext.js`;
  - `services/{appServices,hardwareSession,recordingWorkflow,sessionRecord}.js`;
  - `components/{RecordingPanel,ResearchMeasurements,SessionCard,TrendsCard}.js`;
  - `screens/{Dashboard,SessionDetail}Screen.js`;
  - `utils/{recordingView,researchView,sessionView,trendsView}.js`;
  - tests: `services/{test_ble,test_split_source}.js`, `utils/test_recording_view.js`;
  - `package.json` (test script);
  - this log.
- **Device state:** 1 new test session plus its WAV (local and Firestore); baseline key for PRISM-4F42 at NOT_SET_UP (version counter 1, so the next setup is v2).

## Tests (command and outcome)
- Before: `PRISM_REQUIRE_DATASET=1 npm test` → exit 0 (end of Entry 21).
- After: exit 0. Intermediate run: 16 failures, all from the intended changes above, then updated.

## Open issues / next step
- **Blocker (unchanged):** the detector classifies real INMP441 audio as Noise. Product sessions will mostly be "no inhalation detected", and the baseline cannot reach READY from real use until detection on PRISM hardware works. That needs hardware training data or a placement study, i.e. a model change outside this task.
- **Scientific status:** the personal comparison is V3's formula under an app enrollment policy. It is NOT VALIDATED as personalization, has no cut-off, and is shown on the session screen on the owner's request. Research ARCHITECTURE §9.4 lists the personal channel as research-only. It does not describe how well an inhaler was used.
- **Not committed.**

# Entry 23 — 2026-10-21: Code restored to the Entry 19 state (Entries 21–22 code moved to a backup)

## Objective
The user asked for the exact application code state of Entry 19. That means the Start Event short and long press, the eight-plus-one reference selection, the split-source analysis and the Entry 19 results UI. Later personal-baseline code is not kept. Constraints:
- recoverability first, then back up before changing anything;
- no Git reset, commit or push;
- no data deletion; no redesign;
- rebuild and install the APK with app data kept.

Entries 19–22 stay in this log unchanged. The code they describe for Entries 21–22 is now in the backup below, not in the working tree.

## What was inspected / changed
**Recoverability:**
- Entries 19–22 were never committed (HEAD `2d9307a`, Entry 18), so Git alone cannot separate them.
- Sources used:
  - Claude Code's file history for this session (`~/.claude/file-history/d3ade011-…`, snapshots at each turn start);
  - the session transcript, which holds every Edit/Write call and every Python edit script exactly as sent.
- **Reconstruction (scratchpad `restore/`):**
  - `git -c core.autocrlf=false archive HEAD` (LF, as the working files);
  - then every Entry 19 file operation replayed in order: calls #30–#90, i.e. 22 Edit/Write calls and 10 Python scripts.
  - `npx expo install expo-audio` (#30) needs the network. Its effect was taken from the record: `app.json` = the backup taken before Edit #32; `package.json` = HEAD + the `expo-audio ~57.0.5` line; `package-lock.json` unchanged since.
  - The original shell collapsed `\\` to `\` in script #84 (it wrote a real line break that Edit #86 then fixed); the replay reproduces that.
- **Independent checks of the reconstruction (V), all pass:**
  - 13 files equal the file-history backups taken at the start of the turn after Entry 19 (snapshot #3, 06:50:19Z);
  - `utils/test_recording_view.js` equals the backup taken just before Entry 21's first edit to it;
  - 10 files changed in Entry 19 and never afterwards equal the working tree (including `package-lock.json` and the no-inhalation WAV).
- **Untracked by file history:** `context/AppContext.js`, `screens/DashboardScreen.js`, `screens/SessionDetailScreen.js`, `components/RecordingPanel.js`, `utils/recordingView.js`, `utils/trendsView.js` and `package.json` were changed by scripts only; they come from the same validated replay.

**Backup:** `C:\CAPSTONE\backups\code_state_before_entry19_restore_2026-10-21\` (README, `MANIFEST.sha256`, `files.json`), with `working_tree/` holding:
- the 23 files as they were (copies);
- the 5 Entry 22 files, moved: `pipeline/PersonalBaseline.js`, `services/personalBaselineStore.js`, `services/test_personal_baseline.js`, `utils/baselineView.js`, `components/PersonalComparisonCard.js`.

`sha256sum -c MANIFEST.sha256` → all 28 OK, before and after the restore.

**Restored (23 files, content = Entry 19):**
- **Replay output (15):** `components/{RecordingPanel,TrendsCard}.js`, `context/AppContext.js`, `package.json` (test script back to Entry 19's), `screens/{Dashboard,SessionDetail}Screen.js`, `services/{hardwareSession,recordingWorkflow,sessionRecord,test_split_source}.js`, `utils/{recordingView,researchView,sessionView,test_recording_view,trendsView}.js`.
- **Untouched by Entry 19, so restored to HEAD (8):** `components/{CaptureCard,ResearchMeasurements,SessionCard,StatusTag}.js`, `screens/{Device,Settings}Screen.js`, `services/{appServices,test_ble}.js`.
- No `git checkout` or `git reset`; files were written from the reconstruction.

**Not touched:** 93 files that differ from the LF export only in line endings (never edited; including all of `assets/ml/`), this log, `android/` (unchanged since Entry 19), assets, data, Firebase, firmware.

## Results (V = run; N = not verified)
- **Restored files:** all 23 byte-identical to the reconstruction; the 5 moved files absent from the repo and present in the backup.
- **Whole repository vs reconstruction** (tracked + code files): 0 content differences, 0 extra files, 0 missing files (line-ending-only differences: 93, untouched).
- **Remaining line-ending uncertainty (content identical):** for the 8 files restored to HEAD, the working copies at Entry 19 were:
  - LF for 5 (per earlier-session backups);
  - probably CRLF for `components/SessionCard.js` and `components/StatusTag.js` (last recorded state 2026-10-09: CRLF, same content; Entries 21–22 normalised them to LF);
  - unknown for `screens/SettingsScreen.js` (no backup anywhere).

  They are now LF. Git treats both as identical (autocrlf), and tests and the bundle are unaffected.
- **Tests:** `PRISM_REQUIRE_DATASET=1 npm test` → exit 0. harness all passed; contract 446, assessment 503, sessions 150, ble 102, split source 195, session view 265, recording view 71; 0 failed, 0 skipped. These are exactly Entry 19's recorded counts.
- **APK:** `gradlew :app:assembleDebug` (JDK 17) → BUILD SUCCESSFUL. The bundle contains "Run Simulated Session", "Analyse Demo Recording", "Demo and test", "Research measurements", "Recording analysed and saved", "Analysis input: reference recording" and "Start Event", and none of "Set up baseline", "Personal comparison" or "Acoustic assessment".
- **Install:** `adb install -r` → Success as an update (`firstInstallTime` 2026-10-09 unchanged, `lastUpdateTime` 2026-10-21 14:20:42; no uninstall, same debug signature).
  - App storage before and after: 6 keys, 1 session, identical digest of all keys and values; the session's WAV is present.
- **Launch:** connected to PRISM-4F42. The Dashboard shows Start Event, Last Session (tag "BLE"), Personal baseline "Not available" with the research text, and the "Demo and test" section with both buttons. 0 FATAL, 0 JS errors.
- **N:** no Start Event, long press or demo action was run on the phone (each would add a session); the behaviour is covered by the tests above.

## Files changed
- **Repository:** the 23 files above restored; 5 files moved to the backup; this log.
- **Outside:** the backup folder.
- **Phone:** the APK updated (data kept).

## Tests (command and outcome)
- Before (end of Entry 22): `PRISM_REQUIRE_DATASET=1 npm test` → exit 0 (including test_personal_baseline 74).
- After: exit 0 with Entry 19's counts (above).

## Open issues / remaining differences from Entry 19
- **Data (kept, as instructed):** the Entry 22 test session `ble_sess_1792570518113` (device-analysed, NO_INHALATION_DETECTED, also in Firestore) and the key `@PRISM:personalBaseline:prism-esp32-582abdd44f42`.
  - The Entry 19 code does not read the baseline key.
  - The session appears in History and as Last Session. Its V3 `personal` block makes the Dashboard show "This device: 1 sitting(s) recorded, 0 of 10 would qualify".
  - Trends count it under "other device recordings" (Entry 19 rule: only reference-input sessions are counted).
- **Line endings** of `SessionCard.js`, `StatusTag.js` and `SettingsScreen.js` (above).
- **This log** keeps Entries 20–22 (append-only). Their code descriptions refer to the backup.
- **Not committed.**

# Entry 24 — 2026-10-21: Follow-up to Entry 23: line endings of two restored files; installed APK

## Objective
Settle the line-ending uncertainty that Entry 23 reported for three restored files. Entry 23 stays as written.

## What was inspected / changed
**Evidence for the Entry 19 working-copy line endings:**
- **`components/SessionCard.js`, `components/StatusTag.js` — CRLF:**
  - Git's index recorded a working-file size equal to the CRLF size (2885 / 2220 bytes) with mtime 1791578375 (2026-10-09), i.e. the last time Git saw them clean, before Entries 21–22 rewrote them;
  - the latest earlier-session file-history backups (session 65bf0247, 2026-10-09) are CRLF with the same content.
- **`screens/SettingsScreen.js` — LF:** its last write before this session (session 65bf0247, 2026-10-16) used `open(p, 'w', newline='\n')`, and nothing wrote it again before Entry 21.

**Change:** the two files were converted back to CRLF. Content is unchanged and both now equal the earlier-session backups byte for byte. `git status` no longer lists them; it did while they were LF.

## Results (V = run)
- `PRISM_REQUIRE_DATASET=1 npm test` → exit 0 with Entry 19's counts (harness, 446, 503, 150, 102, 195, 265, 71).
- **`gradlew :app:assembleDebug` → BUILD SUCCESSFUL, but the JS bundle hash changed:** `95fdf8f7…` (APK installed in Entry 23, built while the two files were LF) → `7f88cee5…` (current tree).
  - The JavaScript is the same code (only line endings differ), but the bundle bytes differ, so the APK on the phone is not a byte-exact build of the restored tree.
  - It was not reinstalled.

## Files changed
`components/SessionCard.js`, `components/StatusTag.js` (line endings only), this log.

## Tests (command and outcome)
`PRISM_REQUIRE_DATASET=1 npm test` → exit 0.

## Open issues / next step
- **To make the phone byte-exact:** reinstall the current build with `adb install -r` (data kept). This needs the user's go-ahead.

# Entry 25 — 2026-10-21: Demo Baseline (reference-derived demonstration of baseline initialization and adaptation)

## Objective
Add one isolated feature on top of the restored Entry 19 workflow (commit `a89cdee`): a **Demo Baseline**, built from the eligible reference inhalations analysed in Start Event sessions.
- **What it demonstrates:** initialization, the distance from the baseline before an update, and an exponential update with η = 0.3.
- **What stays unchanged:** everything else — Start Event selection, BLE, the analysis pipeline, Stage 9, session records, firmware.

It is not a personal baseline and does not touch the V3 status or the Entry 22 artifacts.

## What was inspected / changed
**Recording audit (V; script in the session scratchpad, `demo_baseline/audit.py`; read only):**
- **Dataset** (`../PRISM smart inhaler/data`): 361 WAVs, 361 distinct SHA-256 (no byte duplicates).
  - `annotation.csv`: 301 annotated recordings, 255 with an Inhale annotation, 60 unannotated.
  - Research deployment run (`results/final_assessment/e2e_deployment_recordings.csv`): 322 EVENTS_DETECTED, 39 NO_INHALATION_DETECTED.
  - 252 recordings have an Inhale annotation and exactly one usable detected inhale event (`results/inhale_dataset/inhale_events_v1.csv`).
- **The app bundles 9 recordings** (only `services/demoRecordings.js` and `services/analysisAudio.js` require WAVs):
  - **8 inhalation references** (`ref-inhalation-01..08`):
    - each byte-identical to its dataset file;
    - an Inhale annotation;
    - exactly one usable event;
    - research `n_scoreable` = 1;
    - detected event vs annotated Inhale IoU 0.85–0.95.

    Eligible.
  - **No-inhalation reference:** annotated Drug ×4 only, NO_INHALATION_DETECTED. Excluded.
  - The two synthetic golden WAVs under `assets/ml/` are not required by app code.
- **The other 352 dataset recordings are not packaged and are not accessible to the app.** No asset loading was added.

**Existing baseline artifacts kept separate:**
- `pipeline/PersonalReferenceStatus.js` and the session `personal` field (V3 status);
- the Entry 22 key `@PRISM:personalBaseline:<device>` (still on the phone, unread).

The demo uses its own key `@PRISM:demoBaseline`, schema `prism-demo-baseline-v1`.

**New `services/demoBaseline.js` (pure):**
- **Eligibility (`demoBaselineInput`)** — explicit session metadata only:
  - `source "ble"`, `analysis_source.type "reference_recording"`, `selection "inhalation"`;
  - the reference must be one of the 8 (registry id and SHA-256);
  - verified capture; `session_status` SCORE_ONLY;
  - the analysis input = the selected reference (`reference_dataset`);
  - a Stage 9 assessment against the bundled reference;
  - exactly one SCOREABLE event with four finite numeric `feature_values`.
- **Coordinates:** z = (x − center) / scale using the Stage 9 reference parameters (`loadAssessmentReference`), required to equal the assessment's own `feature_deviations` exactly.
- **Algorithm (`applyDemoBaseline`, `prism-demo-baseline-ema-v1`):**
  - first session: B = z, distance null;
  - later sessions: D = rms(z − B_before) (`contract.rmsZ`), then B = B_before + 0.3·(z − B_before).
  - Each contribution records action, reference, z, `baseline_before`, `baseline_after`, deviation and time.
  - No threshold.
- **State:** initialized, baseline, `sessions_processed`, `unique_reference_ids`, `last_session_id`, `last_reference_id`, `last_deviation`, `updated_at`, algorithm, η, coordinates, and contributions keyed by `session_id` (idempotency).
- **Store (`createDemoBaselineStore`):**
  - `load()` validates; an unreadable entry is reported and never used;
  - `observe(record)` never throws: already processed → `already_processed`; ineligible → `skipped` with a reason; a storage failure → `skipped` + error, nothing recorded;
  - `reset()` writes an empty state to its own key only.

**`context/AppContext.js` (additions only, plus the `save` line it wraps):**
- the store instance (AsyncStorage);
- the Start Event workflow's `save` step now stores the session as before, then calls `observe(record)` inside try/catch (it cannot affect the workflow or the stored session);
- the demo baseline is loaded at start-up; `resetDemoBaseline`; context fields `demoBaseline` and `resetDemoBaseline`.

**Screens:**
- **`utils/researchView.js` (additions only):** `DEMO_BASELINE_EXPLANATION`, `describeDemoBaseline(demo, session)` (read-only).
- **New `components/DemoBaselineCard.js`:**
  - section "Demo Baseline" with the explanation;
  - state, eligible sessions processed, unique reference recordings, most recent reference, most recent distance (before update);
  - what this session did: initialized / updated with its distance / skipped with the reason / not processed (recorded before the baseline started or before its last reset);
  - "Reset demo baseline" with a confirmation stating its scope.
- **`screens/SessionDetailScreen.js`:** shows the card after the research section for device (`source "ble"`) sessions; no other change.

**Wording:**
- **"distance" instead of "deviation"** on screen: the project UI scan (`utils/test_session_view.js`) forbids "deviation" outside the research view files. Data fields keep `deviation`.
- **The explanation omits "technique":** forbidden by the same scan. It reads "it is not a personalized baseline or a clinically validated score."
- **Not changed:** existing tests.

**`package.json`:** `services/test_demo_baseline.js` added to `npm test`.

## Results (V = run; O = read in code; N = not verified)
- **Tests:** `PRISM_REQUIRE_DATASET=1 npm test` → exit 0. harness all passed; contract 446, assessment 503, sessions 150, ble 102, split source 195, **demo baseline 71 (new)**, session view 266 (the UI scan now also covers the card), recording view 71. 0 failed.
- **New test coverage** (real Start Event sessions through the protocol simulator, the Entry 19 workflow and the existing reference analysis):
  - **Items 1–4:** initialization, no distance on the first session, D against B_before (and not B_after), exact update.
  - **Items 5–7:** no-inhalation reference, failed analysis, and 12 other ineligible variants (statuses, device / demo-button / simulated / legacy sessions, wrong reference or SHA, unverified capture, mismatched input, no assessment); NaN, Infinity, missing and string measurements, Stage 9 mismatch, two scoreable events, malformed stored state.
  - **Items 8–9:** the same session and history items re-observed → `already_processed`; re-rendering writes nothing; static checks: screens, card and history do not call `observe`; the app calls it only after storing a session.
  - **Item 10:** reference A, B, A → 3 sessions, 2 unique references.
  - **Items 11–12:** restart reload with idempotency; reset changes only its key (sessions, settings and selection state unchanged).
  - **Item 13:** a write failure or an unreadable entry does not affect the session; Stage 9 identical.
  - **Item 14:** Stage 9 output = a direct assessment of the same input; no demo field in session records; the stored session equals the analysed record.
  - **Item 15:** 8 references, no consecutive repeat, long press → no-inhalation; Start Event wiring and long-press handlers unchanged.
- **Unchanged since `a89cdee`** (`git diff --stat` empty): `pipeline/`, `services/ble/`, `services/{recordingWorkflow,hardwareSession,analysisRecordings,analysisAudio,sessionRecord}.js`, `components/{RecordingPanel,ResearchMeasurements}.js`, `screens/DashboardScreen.js`, `assets/`, `app.json`, `package-lock.json`, `firmware/`, `android/`.
- **Android:** `gradlew :app:assembleDebug` → BUILD SUCCESSFUL (compile check; the bundle contains the new strings). **Not installed** (the task excludes installs). The phone still runs the Entry 23 build.
- **N:** the card on a phone; a demo-baseline update from a real Start Event on the phone.

## Files changed
- **New:** `services/demoBaseline.js`, `services/test_demo_baseline.js`, `components/DemoBaselineCard.js`.
- **Changed:** `context/AppContext.js`, `screens/SessionDetailScreen.js`, `utils/researchView.js` (additions only), `package.json` (test script), this log.

## Tests (command and outcome)
- Before: `PRISM_REQUIRE_DATASET=1 npm test` → exit 0 (Entry 24 state, Entry 19 counts).
- After: exit 0 (above). One intermediate failure was in the new test's own fixture (the selection key was never written by its fixed-pick rig); the test was corrected to seed the key.

## Open issues / next step
- **Pool:** only the 8 bundled inhalation references feed the demo; at most 8 unique references. The 252 annotation-backed dataset recordings are not packaged.
- **Coverage:** sessions from the Dashboard's "Analyse Demo Recording" do not feed the demo baseline (only Start Event sessions do).
- **Display rules:** research ARCHITECTURE §9.4 keeps personal/continuous deviations off user screens. This demo shows one, labelled as a demonstration, at the owner's request. It describes distance in a normalised acoustic feature space, nothing about how an inhaler was used.
- **Not committed** (the task excludes commits). Device test pending.

# Entry 26 — 2026-10-21: Demo Baseline: review, in-place install, on-device verification, commit

## Objective
Review the Entry 25 Demo Baseline, install a fresh build on the phone without losing app data, verify it and the Entry 19 workflow on the device, then commit only the Demo Baseline files. No new feature, no algorithm change, no change outside the Entry 25 files.

## What was inspected / changed
**Review:**
- Branch `ml-integration`, HEAD `a89cdee`.
- The diff against HEAD contains only the Entry 25 files: `services/demoBaseline.js`, `components/DemoBaselineCard.js`, `services/test_demo_baseline.js` (new); `context/AppContext.js`, `screens/SessionDetailScreen.js`, `utils/researchView.js`, `package.json`, this log.
  - The 4 removed lines are lines extended or wrapped in place (the `save` closure, the test script, one import, one destructuring).
  - The log is append-only (HEAD content is a prefix).
- Protected areas unchanged against HEAD (`git diff --stat` empty): `pipeline/`, `services/ble/`, `services/{recordingWorkflow,hardwareSession,analysisRecordings,analysisAudio,sessionRecord}.js`, `components/{RecordingPanel,ResearchMeasurements}.js`, `screens/DashboardScreen.js`, `firmware/`, `assets/`, `app.json`, `package-lock.json`.
- The implementation matches the specification. No defect found; no code changed in this entry.
- **Noted, not changed:** if a session were stored within milliseconds of app start, the start-up load could overwrite that update. A Start Event takes over 15 s.

**Install safety:**
- **Phone:** OnePlus IV2201 (`BQBERCSW9TG6HQ8D`), authorized.
- **Installed app:** `com.anonymous.smart_inhaler_app`, versionCode 1, DEBUGGABLE; first installed 2026-10-09.
- **Build:** same application id and versionCode (`aapt dump badging`).
- **Signing:** `apksigner verify --print-certs` on the installed `base.apk` (pulled) and on the new APK — the same certificate (CN=Android Debug, SHA-256 `fac61745dc09…3b9c`).
- **So `adb install -r` is an in-place update that keeps the app's data.**
- **App-data backup before installing:** via `run-as` (debuggable app) to `C:\CAPSTONE\backups\phone_app_data_before_demo_baseline_install_2026-10-21\`.
  - Contents: `databases/` (AsyncStorage, which includes the Firebase sign-in record), `shared_prefs/`, `files/recordings/`, `files/prism_conformance/`.
  - 18 files; `sha256sum -c MANIFEST.phone.sha256` OK.
  - Restore path: `adb exec-in run-as … cat > …`, as used in Entry 20.
  - App storage at that point: 8 keys, 3 sessions (one device session from Entry 22, plus a long-press and a short-press session the user had made on the Entry 23 build).

## Results (V = run; N = not verified)
**Build and install (V):**
- `gradlew :app:assembleDebug` → BUILD SUCCESSFUL, up to date. APK `android/app/build/outputs/apk/debug/app-debug.apk`, SHA-256 `356f3744…`, JS bundle `5a86a51c…`.
- `adb install -r` → Success: `firstInstallTime` unchanged, `lastUpdateTime` 2026-10-21 15:25:01.
- App storage before and after the install: identical (8 keys, digest `f50821c7…`); 3 recordings present.

**On the phone with the ESP32 (V):**

| Check | Result |
|---|---|
| Initial state | Earlier inhalation session (Entry 23 build): section shows "Not initialized", 0, 0, "—", and "This session was not processed by the current demo baseline (recorded before…)". Viewing it wrote nothing (the demo key was still absent) |
| Short press 1 | `ref-inhalation-01` (previous choice was `ref-inhalation-08`). Analysis input `rec2018-01-23_11h00m14.641s.wav` (`reference_dataset`); capture `prism_794ccd81` verified, CRC `cbb3702e` = device, saved. Demo baseline initialized: B equals the session's Stage 9 z exactly (also recomputed on the PC from the bundled reference parameters); 1 session, 1 unique; no distance. The section says so |
| Playback | "Device recording" played an 8000 Hz track for 15.2 s (15:27:50.54 → 15:28:05.79): the 15 s capture, not the 12 s analysis recording |
| Short press 2 | `ref-inhalation-06` (no consecutive repeat). Demo baseline updated: D = 0.667676977448878 = sqrt(mean (z − B_before)²), recomputed on the PC (against B_after it would be 0.467); B_after = B_before + 0.3 (z − B_before) exactly; both vectors stored. 2 sessions, 2 unique. The section says "updated … distance from the baseline before the update: 0.668" |
| Reopening | Reopening session 2, History, the other sessions, and back: demo key byte-identical |
| App restart | Force-stop and relaunch: the section shows the same state; key unchanged |
| Long press | `ref-no-inhalation-01`, NO_INHALATION_DETECTED, capture verified. Demo baseline unchanged. The section says "skipped: the no-inhalation reference is not an inhalation". The short-press selection state stayed `ref-inhalation-06` |
| Reset | Confirmation text states its scope. After Reset: "Not initialized", 0; only `@PRISM:demoBaseline` changed (all other keys byte-identical); 6 sessions and 6 recordings kept |
| Log | 0 FATAL, 0 JS errors |

**N:**
- a new session with an already-seen, non-consecutive reference on the phone (selection is random; covered by `test_demo_baseline` item 10);
- a storage failure on the phone (covered by item 13).

**Tests (V):** `PRISM_REQUIRE_DATASET=1 npm test` → exit 0, before and after the device checks. harness all passed; contract 446, assessment 503, sessions 150, ble 102, split source 195, demo baseline 71, session view 266, recording view 71; 0 failed.

## Files changed
This log only (Entry 26).

**Committed together with the Entry 25 files** in a new commit on `ml-integration` (not pushed): `services/demoBaseline.js`, `components/DemoBaselineCard.js`, `services/test_demo_baseline.js`, `context/AppContext.js`, `screens/SessionDetailScreen.js`, `utils/researchView.js`, `package.json`, `claude_implementation.md`.

**Phone state after this entry:**
- the new build installed;
- demo baseline reset (not initialized);
- 3 test sessions added (two short presses, one long press; they sync to Firestore like any session).

## Tests (command and outcome)
`PRISM_REQUIRE_DATASET=1 npm test` → exit 0 (counts above).

## Open issues / next step
- The 20-recording pool expansion is a separate task (not started).
- The backup folder above contains the Firebase sign-in record; delete it when no longer needed.
