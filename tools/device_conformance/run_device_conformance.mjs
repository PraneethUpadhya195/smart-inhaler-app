/**
 * tools/device_conformance/run_device_conformance.mjs — run the PRISM pipeline on an Android
 * device and compare it with the references. See README.md.
 *
 *   node tools/device_conformance/run_device_conformance.mjs [--extra N] [--data DIR] [--out DIR]
 *        [--package ID] [--adb PATH] [--timeout-s S]
 *
 * 1. Builds the case list: the 9 golden cases, invalid-audio cases, and N extra reference
 *    recordings from the dataset (first N by name, golden files excluded).
 * 2. Runs every case through the app's pipeline in Node (onnxruntime-node): the JS reference.
 * 3. Copies the inputs and a request file into the app's document directory (adb run-as; needs
 *    a debuggable build), restarts the app and waits for tools/device_conformance/appRunner.js
 *    to write results.json; pulls it and the device log.
 * 4. Compares: device vs golden expected (Python reference) at the contract tolerances, device
 *    vs Node for every case, schema validation, session records, model I/O, failure paths.
 * Exit code 0 only if every check passes.
 */

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import PcmSource from "../../pipeline/PcmSource.js";
import WavPcmSource from "../../pipeline/sources/WavPcmSource.js";
import { createNodePipeline } from "../../pipeline/runtime/node.js";
import { validateOutput } from "../../pipeline/contract.js";
import { MODEL_SHA256, V2_FEATURE_ORDER } from "../../pipeline/versions.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GOLDEN = path.join(ROOT, "assets/ml/v2_validation/golden");
const TAG = "[PRISM-CONFORMANCE]";
const DEVICE_DIR = "files/prism_conformance"; // relative to the app's data dir (run-as cwd)
const TMP_DIR = "/data/local/tmp/prism_conformance";

// ─── Arguments ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const DATA_DIR = arg("data", process.env.PRISM_DATA_DIR ?? path.resolve(ROOT, "..", "PRISM smart inhaler", "data"));
const EXTRA = Number(arg("extra", "0"));
const OUT = arg("out", path.join(os.tmpdir(), "prism_device_conformance"));
const PKG = arg("package", "com.anonymous.smart_inhaler_app");
const TIMEOUT_S = Number(arg("timeout-s", "1200"));
const SDK = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT
  ?? path.join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk");
const ADB = arg("adb", path.join(SDK, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb"));

fs.mkdirSync(path.join(OUT, "inputs"), { recursive: true });
const adb = (...a) => execFileSync(ADB, a, { maxBuffer: 256 * 1024 * 1024 });
const adbText = (...a) => adb(...a).toString("utf8");

// ─── Cases ───────────────────────────────────────────────────────────────────

const manifest = JSON.parse(fs.readFileSync(path.join(GOLDEN, "golden_manifest.json"), "utf8"));
const tol = manifest.tolerances;
const TIME_TOL = 1e-9;
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** @type {{case: string, file?: string, bytes?: Buffer, inline?: Object, input_domain?: string, source_id?: string, expected?: Object}[]} */
const cases = [];
for (const c of manifest.cases) {
  const expected = JSON.parse(fs.readFileSync(path.join(GOLDEN, c.expected), "utf8"));
  if (c.input.type === "dataset_wav" || c.input.type === "synthetic_wav") {
    const file = c.input.type === "dataset_wav" ? path.join(DATA_DIR, c.input.file) : path.join(GOLDEN, c.input.path);
    const bytes = fs.readFileSync(file);
    if (sha256(bytes) !== c.input.sha256) throw new Error(`${c.case}: input SHA-256 mismatch for ${file}`);
    const name = path.basename(file);
    cases.push({ case: c.case, file: name, bytes, input_domain: c.input_domain, source_id: name, expected });
  } else if (c.case === "input_error_sample_rate_16k") {
    cases.push({ case: c.case, inline: { n: 16000, sampleRate: 16000 }, expected });
  } else if (c.case === "input_error_too_short") {
    cases.push({ case: c.case, inline: { n: 1535, sampleRate: 8000 }, expected });
  } else {
    throw new Error(`unknown golden case ${c.case}`);
  }
}
// Invalid audio and input domains (no golden file: compared with the Node run only).
cases.push(
  { case: "invalid_wav_bytes", file: "invalid_not_a_wav.wav", bytes: Buffer.from("this is not a WAV file\n") },
  { case: "invalid_empty_file", file: "invalid_empty.wav", bytes: Buffer.alloc(0) },
  { case: "input_error_empty_audio", inline: { n: 0, sampleRate: 8000 } },
  { case: "input_error_nonfinite_audio", inline: { n: 16000, sampleRate: 8000, set: [[7, "NaN"]] } },
  { case: "input_error_amplitude_out_of_range", inline: { n: 16000, sampleRate: 8000, set: [[100, 1.5]] } },
  { case: "prism_hardware_domain_silence", inline: { n: 16000, sampleRate: 8000, input_domain: "prism_hardware" } },
);
if (EXTRA > 0) {
  const golden = new Set(cases.filter((c) => c.file).map((c) => c.file));
  const wavs = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".wav") && !golden.has(f)).sort().slice(0, EXTRA);
  for (const f of wavs) {
    cases.push({ case: `dataset_${f.replace(/\.wav$/, "")}`, file: f, bytes: fs.readFileSync(path.join(DATA_DIR, f)),
      input_domain: "reference_dataset", source_id: f });
  }
}

// ─── Node reference run (same pipeline code, onnxruntime-node) ──────────────

class InlinePcmSource extends PcmSource {
  constructor(spec, sourceId) {
    super("test");
    this.spec = spec;
    this.sourceId = sourceId;
  }
  async acquire() {
    const samples = new Float32Array(this.spec.n);
    for (const [index, value] of this.spec.set ?? []) samples[index] = value === "NaN" ? NaN : value;
    return { samples, sampleRate: this.spec.sampleRate, channels: this.spec.channels ?? 1, sourceType: this.sourceType,
      sourceId: this.sourceId, recordedAt: null, inputDomain: this.spec.input_domain ?? "unknown" };
  }
}

console.log(`Node reference: ${cases.length} case(s)`);
const nodePipeline = await createNodePipeline();
const nodeResults = new Map();
for (const c of cases) {
  const sourceId = c.source_id ?? c.file ?? null; // inline cases: null, as in the golden files
  try {
    const source = c.file
      ? new WavPcmSource(new Uint8Array(c.bytes), { inputDomain: c.input_domain ?? "unknown", sourceId })
      : new InlinePcmSource(c.inline, sourceId);
    nodeResults.set(c.case, { output: await nodePipeline.run(source), error: null });
  } catch (e) {
    nodeResults.set(c.case, { output: null, error: { name: e.name, message: e.message } });
  }
}

// ─── Device run ──────────────────────────────────────────────────────────────

const devices = adbText("devices").split(/\r?\n/).slice(1).filter((l) => /\tdevice$/.test(l));
if (devices.length !== 1) throw new Error(`expected exactly one adb device, found ${devices.length}`);
const device = {
  serial: devices[0].split("\t")[0],
  model: adbText("shell", "getprop", "ro.product.model").trim(),
  android: adbText("shell", "getprop", "ro.build.version.release").trim(),
  abi: adbText("shell", "getprop", "ro.product.cpu.abi").trim(),
};
console.log(`Device: ${device.model} (${device.serial}), Android ${device.android}, ${device.abi}`);

const requestId = `${new Date().toISOString()}_${crypto.randomBytes(3).toString("hex")}`;
const request = {
  id: requestId,
  cases: cases.map(({ case: name, file, inline, input_domain, source_id }) => ({ case: name, file, inline, input_domain, source_id })),
};
const inputDir = path.join(OUT, "inputs");
for (const c of cases.filter((x) => x.file)) fs.writeFileSync(path.join(inputDir, c.file), c.bytes);
fs.writeFileSync(path.join(inputDir, "request.json"), JSON.stringify(request, null, 1));

adb("shell", "rm", "-rf", TMP_DIR);
adb("shell", "mkdir", "-p", TMP_DIR);
for (const f of fs.readdirSync(inputDir)) adb("push", path.join(inputDir, f), `${TMP_DIR}/${f}`);
// request.json is copied last, so the app never sees a request before its inputs.
adb("shell", "run-as", PKG, "sh", "-c",
  `'rm -rf ${DEVICE_DIR} && mkdir -p ${DEVICE_DIR} && for f in ${TMP_DIR}/*; do case "$f" in */request.json) ;; *) cp "$f" ${DEVICE_DIR}/ ;; esac; done && cp ${TMP_DIR}/request.json ${DEVICE_DIR}/'`);
adb("shell", "rm", "-rf", TMP_DIR);

adb("logcat", "-c");
// Stream the log to a file for the whole run (the device ring buffer rotates during long runs).
const logcatFile = path.join(OUT, "device_logcat.txt");
const logcat = spawn(ADB, ["logcat", "-v", "time"], { stdio: ["ignore", fs.openSync(logcatFile, "w"), "ignore"] });
adb("shell", "am", "force-stop", PKG);
adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1");
console.log(`Request ${requestId} placed; app restarted. Waiting for results (timeout ${TIMEOUT_S} s)…`);

let results = null;
const deadline = Date.now() + TIMEOUT_S * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  let text;
  try {
    text = adbText("exec-out", "run-as", PKG, "cat", `${DEVICE_DIR}/results.json`);
  } catch {
    continue;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed.request_id === requestId && parsed.finished_at) {
      results = parsed;
      break;
    }
  } catch {
    // not written completely yet
  }
}
logcat.kill();
await new Promise((r) => setTimeout(r, 500));
const log = fs.readFileSync(logcatFile, "utf8");
fs.writeFileSync(path.join(OUT, "device_conformance_log.txt"),
  log.split(/\r?\n/).filter((l) => l.includes(TAG) || /onnxruntime|Onnxruntime|install' of null/.test(l)).join("\n") + "\n");
if (!results) throw new Error(`no results.json from the device within ${TIMEOUT_S} s (see ${OUT}/device_logcat.txt)`);
fs.writeFileSync(path.join(OUT, "device_results.json"), JSON.stringify(results, null, 1));
fs.writeFileSync(path.join(OUT, "node_results.json"), JSON.stringify(Object.fromEntries(nodeResults), null, 1));

// ─── Comparison ──────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];
const check = (ok, message) => {
  if (ok) passed++;
  else failures.push(message);
};
const maxDiff = {};
const noteDiff = (key, value) => {
  if (Number.isFinite(value)) maxDiff[key] = Math.max(maxDiff[key] ?? 0, value);
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateSchema = ajv.compile(JSON.parse(fs.readFileSync(path.join(ROOT, "assets/ml/v2_validation/inference_output.schema.json"), "utf8")));
function checkSchemas(output, label) {
  check(validateSchema(output), `${label}: schema: ${ajv.errorsText(validateSchema.errors)}`);
  try {
    validateOutput(output);
    passed++;
  } catch (e) {
    check(false, `${label}: validateOutput: ${e.message}`);
  }
}

/** Contract golden comparison (same rules as pipeline/test_contract.js), recording max differences. */
function compareOutputs(a, e, label, diffPrefix) {
  for (const k of ["contract_version", "baseline_id", "detector_model_sha256", "recording_status", "error",
    "baseline_domain_validated", "n_events", "n_scored", "interpretation"]) {
    check(a[k] === e[k], `${label}: ${k} ${a[k]} != ${e[k]}`);
  }
  check(JSON.stringify(Object.keys(a)) === JSON.stringify(Object.keys(e)), `${label}: output keys`);
  check(JSON.stringify(a.feature_order) === JSON.stringify(e.feature_order), `${label}: feature_order`);
  check(JSON.stringify(a.input) === JSON.stringify(e.input), `${label}: input ${JSON.stringify(a.input)} vs ${JSON.stringify(e.input)}`);
  check(a.events.length === e.events.length, `${label}: event count ${a.events.length} vs ${e.events.length}`);
  a.events.forEach((ae, i) => {
    const ee = e.events[i];
    if (!ee) return;
    const L = `${label} event ${i}`;
    for (const k of ["event_id", "window_count", "status"]) check(ae[k] === ee[k], `${L}: ${k} ${ae[k]} != ${ee[k]}`);
    check(JSON.stringify(ae.not_scoreable_reasons) === JSON.stringify(ee.not_scoreable_reasons), `${L}: reasons`);
    for (const k of ["start_time", "end_time", "duration_s"]) {
      const d = Math.abs(ae[k] - ee[k]);
      noteDiff(`${diffPrefix}times_abs`, d);
      check(d <= TIME_TOL, `${L}: ${k} ${ae[k]} vs ${ee[k]}`);
    }
    for (const k of ["detector_confidence", "detector_max_confidence"]) {
      const d = Math.abs(ae[k] - ee[k]);
      noteDiff(`${diffPrefix}detector_confidence_abs`, d);
      check(d <= tol.detector_confidence_abs, `${L}: ${k} ${ae[k]} vs ${ee[k]}`);
    }
    check((ae.feature_values === null) === (ee.feature_values === null), `${L}: feature_values presence`);
    if (ae.feature_values && ee.feature_values) {
      for (const f of V2_FEATURE_ORDER) {
        const rel = Math.abs(ae.feature_values[f] - ee.feature_values[f]) / Math.abs(ee.feature_values[f]);
        noteDiff(`${diffPrefix}feature_values_rel`, rel);
        check(rel <= tol.feature_values_relative, `${L}: ${f} relative difference ${rel}`);
      }
    }
    check((ae.mean_rms === null) === (ee.mean_rms === null), `${L}: mean_rms presence`);
    if (ae.mean_rms !== null && ee.mean_rms !== null) {
      const rel = Math.abs(ae.mean_rms - ee.mean_rms) / Math.abs(ee.mean_rms);
      noteDiff(`${diffPrefix}mean_rms_rel`, rel);
      check(rel <= tol.mean_rms_relative, `${L}: mean_rms relative difference ${rel}`);
    }
    check((ae.feature_z_scores === null) === (ee.feature_z_scores === null), `${L}: z presence`);
    if (ae.feature_z_scores && ee.feature_z_scores) {
      for (const f of V2_FEATURE_ORDER) {
        const d = Math.abs(ae.feature_z_scores[f] - ee.feature_z_scores[f]);
        noteDiff(`${diffPrefix}z_abs`, d);
        check(d <= tol.feature_z_scores_abs, `${L}: z ${f} ${d}`);
      }
    }
    check((ae.anomaly_score === null) === (ee.anomaly_score === null), `${L}: anomaly_score presence`);
    if (ae.anomaly_score !== null && ee.anomaly_score !== null) {
      const d = Math.abs(ae.anomaly_score - ee.anomaly_score);
      noteDiff(`${diffPrefix}anomaly_score_abs`, d);
      check(d <= tol.anomaly_score_abs, `${L}: anomaly_score ${d}`);
    }
  });
}

const EXPECTED_SESSION_STATUS = (o) => {
  if (o.recording_status === "INPUT_ERROR") return "INPUT_ERROR";
  if (o.n_scored > 0) return "SCORE_ONLY";
  if (o.n_events > 0) return "NOT_SCOREABLE";
  return "NO_INHALATION_DETECTED";
};

check(results.pipeline_error === null, `pipeline could not run on the device: ${JSON.stringify(results.pipeline_error)}`);

// Model: the packaged model, verified, with the contract's I/O.
const model = results.model ?? {};
check(model.sha256 === MODEL_SHA256, `model sha256 ${model.sha256}`);
const inMeta = model.input_metadata?.[0];
const outMeta = model.output_metadata?.[0];
check(model.input_names?.length === 1 && model.output_names?.length === 1, "one model input and one output");
check(inMeta?.type === "float32" && JSON.stringify(inMeta?.shape?.slice(1)) === "[25,124]",
  `model input metadata ${JSON.stringify(inMeta)}`);
check(outMeta?.type === "float32" && JSON.stringify(outMeta?.shape?.slice(1)) === "[4]",
  `model output metadata ${JSON.stringify(outMeta)}`);

const rows = [];
const deviceCases = new Map((results.cases ?? []).map((r) => [r.case, r]));
for (const c of cases) {
  const d = deviceCases.get(c.case);
  const n = nodeResults.get(c.case);
  if (!d) {
    check(false, `${c.case}: missing from device results`);
    continue;
  }
  if (n.error) {
    // The Node run threw (e.g. undecodable WAV): the device must throw the same error, and the
    // session must be a PROCESSING_ERROR without any contract output.
    check(d.output === null && d.error?.name === n.error.name && d.error?.message === n.error.message,
      `${c.case}: device ${JSON.stringify(d.error ?? d.output?.recording_status)} vs node ${JSON.stringify(n.error)}`);
    check(d.session?.session_status === "PROCESSING_ERROR" && d.session?.recordings?.length === 0
      && d.session?.processing_errors?.length === 1, `${c.case}: processing-error session`);
    rows.push([c.case, `threw ${d.error?.name}`, d.session?.session_status, d.ms]);
    continue;
  }
  check(d.error === null && d.output !== null, `${c.case}: device run() threw ${JSON.stringify(d.error)}`);
  if (!d.output) continue;
  checkSchemas(d.output, `${c.case} (device)`);
  compareOutputs(d.output, n.output, `${c.case} device vs node`, "node_");
  if (c.expected) compareOutputs(d.output, c.expected, `${c.case} device vs golden`, "golden_");
  // Session layer: the canonical output is stored verbatim; the summary state follows from it.
  check(d.session_error === null, `${c.case}: session build failed ${JSON.stringify(d.session_error)}`);
  check(JSON.stringify(d.session?.recordings?.[0]) === JSON.stringify(d.output), `${c.case}: session.recordings[0] is the output`);
  check(d.session?.session_status === EXPECTED_SESSION_STATUS(d.output), `${c.case}: session_status ${d.session?.session_status}`);
  check(d.session?.schema === "prism-app-session-v1" && d.session?.simulated === false, `${c.case}: session record schema`);
  for (const k of ["quality_assessment", "technique_flags", "composite_label", "event_classification"]) {
    check(!(k in (d.session ?? {})), `${c.case}: legacy field ${k} in session`);
  }
  rows.push([c.case, `${d.output.recording_status}${d.output.error ? ` (${d.output.error})` : ""} ${d.output.n_events}/${d.output.n_scored}`,
    d.session?.session_status, d.ms]);
}

const sim = results.simulated_session;
check(sim?.simulated === true && sim?.source === "simulation", "simulated session marked simulated");
check(sim?.recordings?.length === 1 && sim.processing_errors.length === 0, "simulated session ran the real pipeline");
if (sim?.recordings?.[0]) checkSchemas(sim.recordings[0], "simulated session output");

const paths = new Map((results.error_paths ?? []).map((p) => [p.name, p]));
check(paths.get("tampered_model_bytes")?.threw && paths.get("tampered_model_bytes").error.name === "ModelLoadError",
  `tampered model refused: ${JSON.stringify(paths.get("tampered_model_bytes"))}`);
check(paths.get("ort_invalid_model_bytes")?.threw === true, `ORT error surfaced: ${JSON.stringify(paths.get("ort_invalid_model_bytes"))}`);
const pf = paths.get("pipeline_factory_failure_session");
check(pf?.threw === false && pf.value.session_status === "PROCESSING_ERROR" && pf.value.recordings === 0,
  `pipeline failure → PROCESSING_ERROR session without outputs: ${JSON.stringify(pf)}`);

// ─── Report ──────────────────────────────────────────────────────────────────

const report = {
  request_id: requestId,
  device,
  runtime: results.runtime,
  model: { sha256: model.sha256, load_ms: model.load_ms, input: inMeta, output: outMeta },
  n_cases: cases.length,
  checks_passed: passed,
  checks_failed: failures.length,
  failures,
  max_differences: maxDiff,
  cases: rows.map(([name, result, session, ms]) => ({ case: name, result, session, ms })),
  simulated_session_status: sim?.session_status ?? null,
  error_paths: results.error_paths,
};
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));

console.log(`\nRuntime: ${JSON.stringify(results.runtime)}`);
console.log(`Model: sha256 ${model.sha256}, loaded in ${model.load_ms} ms; input ${JSON.stringify(inMeta)}; output ${JSON.stringify(outMeta)}`);
console.log("\ncase | device result (events/scored) | session | ms");
for (const [name, result, session, ms] of rows) console.log(`${name} | ${result} | ${session} | ${ms}`);
console.log(`\nSimulated session: ${sim?.session_status}`);
for (const p of results.error_paths ?? []) {
  console.log(`Error path ${p.name}: ${p.threw ? `threw ${p.error.name}: ${p.error.message}` : JSON.stringify(p.value)}`);
}
console.log(`\nMax differences: ${JSON.stringify(maxDiff)}`);
console.log(`\n${passed} checks passed, ${failures.length} failed. Output: ${OUT}`);
for (const f of failures.slice(0, 50)) console.log(`  FAIL: ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
