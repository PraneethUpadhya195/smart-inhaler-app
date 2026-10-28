# On-device conformance (Android)

Runs recordings through the app's own pipeline on a phone, using:
- `onnxruntime-react-native`;
- the packaged `assets/ml/inhaler_cnn.onnx`;
- the frozen V2 baseline;
- the session layer.

It then compares the phone's canonical outputs with:
- the golden expected outputs (the Python reference), at the contract tolerances;
- the same pipeline code run in Node (`onnxruntime-node`), for every case.

Nothing is written to Firestore.

## Parts
- `appRunner.js` runs **on the device**. `index.js` loads it only in `__DEV__` builds. It does nothing unless `request.json` exists in `<app files dir>/prism_conformance/`. It deletes the request, then:
  1. runs each case through `getPipeline().run()`;
  2. builds the session record the app would store (`SessionAggregator` + `buildSessionRecord`);
  3. runs the app's simulation path (`runSimulatedSession`);
  4. exercises three failure paths: a tampered model, invalid model bytes for ORT, and a failing pipeline factory;
  5. writes `results.json` and logs `[PRISM-CONFORMANCE]` lines.
- `run_device_conformance.mjs` runs **on the host**. It:
  1. builds the cases;
  2. computes the Node reference;
  3. copies inputs to the app with `adb push` + `run-as` (debuggable build only);
  4. restarts the app;
  5. waits for `results.json`, streams logcat, and compares.

## Run
Prerequisites:
- a debug build installed (`cd android; .\gradlew.bat installDebug`);
- Metro running (`npx expo start`);
- `adb reverse tcp:8081 tcp:8081`;
- exactly one device attached.

```
node tools/device_conformance/run_device_conformance.mjs [--extra N] [--out DIR] [--timeout-s S]
```

**Cases:**
- **Always run (15 cases):**
  - the 9 golden cases (the 5 dataset WAVs are read from `../PRISM smart inhaler/data` and SHA-checked);
  - 2 undecodable files;
  - 3 input-error cases (empty, non-finite, amplitude > 1);
  - one `prism_hardware` silence case.
- **`--extra N`:** adds the first N other dataset recordings by name; `--extra 400` gives all 361.

**Output** (default `%TEMP%/prism_device_conformance`):
- `report.json`;
- `device_results.json`;
- `node_results.json`;
- `device_logcat.txt` (the full log, streamed during the run);
- `device_conformance_log.txt` (the `[PRISM-CONFORMANCE]` and ONNX Runtime lines).

The exit code is 0 only if every check passes.

**Notes:**
- Expo CLI in `CI=1` mode does not watch files. Restart Metro after changing app code, or the device runs the old bundle.
- The run blocks the app's JS thread while it runs (about 5 s per 12 s recording in a debug build).
