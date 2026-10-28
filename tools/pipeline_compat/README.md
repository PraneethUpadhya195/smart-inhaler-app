# Pipeline compatibility check (app JS vs PRISM Python reference)

This check runs the app's own pipeline code on the PRISM reference recordings,
unmodified, and compares every stage with the research reference implementation:
- frame features;
- detector windows and logits;
- events, scoreability, V2 features, z-scores and score.

It was used for `claude_implementation.md` Entry 1.

## Requirements
- `npm install` in this repository (provides `fft.js` and `onnxruntime-node`). Node 24 was used; the app's `.js` files rely on Node's ESM syntax detection.
- The sibling research repository `../PRISM smart inhaler`, with its `venv/` and `data/` (361 WAVs).

## Run (from the app repository root)

```bash
OUT=<scratch dir>; mkdir -p $OUT/frames_js $OUT/frames_py
FR=rec2018-01-22_17h41m49.809s.wav,rec2018-01-22_17h41m33.475s.wav,rec2018-01-23_11h00m33.928s.wav,rec2018-01-23_12h52m08.363s.wav,rec2018-01-23_10h45m44.127s.wav,rec2018-01-23_10h52m57.816s.wav

# 1. Integration paths (run(), aggregator, simulation, input errors) on one recording
node tools/pipeline_compat/js_run.mjs integration "../PRISM smart inhaler/data/rec2018-01-22_17h41m49.809s.wav"

# 2. App pipeline, stage by stage, on all reference recordings (about 30 min)
node tools/pipeline_compat/js_run.mjs dataset "../PRISM smart inhaler/data" $OUT/js_dataset.jsonl $OUT/frames_js $FR

# 3. Python reference (run with the research venv)
"../PRISM smart inhaler/venv/Scripts/python.exe" tools/pipeline_compat/py_ref.py $OUT/py_dataset.jsonl $OUT/frames_py $FR

# 4. Comparison with the contract's golden tolerances
"../PRISM smart inhaler/venv/Scripts/python.exe" tools/pipeline_compat/compare.py $OUT
```

## How the dataset mode calls the pipeline
- **Stage methods, not `run()`.** The dataset mode calls the stage methods directly (`extractFrameFeatures` → `buildWindows` → `runInference` → `decodeEvents` → `extractEventPcm` → `extractEventFeatures` → `checkScoreability` → `scoreEvent`) and reads their internal fields.
- **Why:** this measures the numerical core separately from the wiring defects in `run()` and the result builders, which the integration mode reports.
- **One field is supplied:** `channels: 1`, which `WavPcmSource` does not set.

## Timing
`node tools/pipeline_compat/timing.mjs <wav>` prints per-stage times for the following, plus the max logit difference between the per-window and batched calls:
- DSP;
- windowing;
- per-window ONNX;
- a single batched ONNX call;
- event features.

## Timing-fix check (F14)
`node tools/pipeline_compat/js_fixcheck.mjs <data dir> <list file> <out.jsonl>` reruns the listed recordings with window times computed exactly as `post_event.generate_window_predictions` does (`start = i·(2·64/8000)`, `end = min(start + 25·64/8000, duration)`). It overwrites the times on the prediction objects and does not modify app code. Use it to confirm the fix before applying it to `InferencePipeline.buildWindows`.
