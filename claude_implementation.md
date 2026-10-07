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
