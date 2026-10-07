/**
 * pipeline/test_contract.js — conformance of InferencePipeline.run() with the research contract.
 *
 * 1. The 9 golden cases of assets/ml/v2_validation/golden/golden_manifest.json through run(),
 *    compared with the expected outputs at the contract's golden tolerances.
 *    The 5 dataset recordings are not in this repository: they are read from PRISM_DATA_DIR
 *    (default ../PRISM smart inhaler/data) and verified by SHA-256. When they are absent the
 *    cases are reported as SKIPPED; set PRISM_REQUIRE_DATASET=1 to make that a failure.
 * 2. Every output is validated twice: by contract.validateOutput (prism_inference.validate_output)
 *    and by Ajv against inference_output.schema.json (JSON Schema 2020-12).
 * 3. Unit checks: input error codes, baseline validation, output validation, JSON safety,
 *    SHA-256, WAV decoding.
 *
 * Run: node pipeline/test_contract.js   (part of npm test)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import PcmSource from "./PcmSource.js";
import WavPcmSource from "./sources/WavPcmSource.js";
import BaselineStore from "./BaselineStore.js";
import { createNodePipeline, MODEL_URL } from "./runtime/node.js";
import { checkInput, validateOutput, roundHalfEven, ContractError } from "./contract.js";
import { sha256Hex } from "./sha256.js";
import { decodeWav, WavDecodeError } from "./wav.js";
import { baselineV2 } from "./contractAssets.js";
import { MODEL_SHA256, V2_FEATURE_ORDER } from "./versions.js";

const ROOT = new URL("..", import.meta.url);
const GOLDEN = new URL("assets/ml/v2_validation/golden/", ROOT);
const readJson = (url) => JSON.parse(fs.readFileSync(url, "utf8"));
const DATA_DIR = process.env.PRISM_DATA_DIR
  ?? path.resolve(fileURLToPath(ROOT), "..", "PRISM smart inhaler", "data");

let passed = 0;
let failed = 0;
let skipped = 0;
function check(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}
function throwsContract(fn, message) {
  try {
    fn();
    check(false, `${message} (no error thrown)`);
  } catch (e) {
    check(e instanceof ContractError, `${message} (threw ${e.name}: ${e.message})`);
  }
}

class ArrayPcmSource extends PcmSource {
  constructor(pcm) {
    super("test");
    this.pcm = pcm;
  }
  async acquire() {
    return { channels: 1, sourceType: "test", sourceId: null, recordedAt: null, inputDomain: "unknown", ...this.pcm };
  }
}

// ─── Golden comparison at the contract tolerances ───────────────────────────

const manifest = readJson(new URL("golden_manifest.json", GOLDEN));
const tol = manifest.tolerances;
const TIME_TOL = 1e-9;

function compareOutput(actual, expected, label) {
  const exactTop = ["contract_version", "baseline_id", "detector_model_sha256", "recording_status", "error",
    "baseline_domain_validated", "n_events", "n_scored", "interpretation"];
  for (const k of exactTop) check(actual[k] === expected[k], `${label}: ${k} ${actual[k]} != ${expected[k]}`);
  check(JSON.stringify(actual.feature_order) === JSON.stringify(expected.feature_order), `${label}: feature_order`);
  check(JSON.stringify(Object.keys(actual)) === JSON.stringify(Object.keys(expected)), `${label}: output key order`);
  check(JSON.stringify(actual.input) === JSON.stringify(expected.input), `${label}: input ${JSON.stringify(actual.input)}`);
  check(actual.events.length === expected.events.length, `${label}: event count`);
  actual.events.forEach((a, i) => {
    const e = expected.events[i];
    if (!e) return;
    const L = `${label} event ${i}`;
    for (const k of ["event_id", "window_count", "status"]) check(a[k] === e[k], `${L}: ${k} ${a[k]} != ${e[k]}`);
    check(JSON.stringify(a.not_scoreable_reasons) === JSON.stringify(e.not_scoreable_reasons), `${L}: reasons`);
    for (const k of ["start_time", "end_time", "duration_s"]) {
      check(Math.abs(a[k] - e[k]) <= TIME_TOL, `${L}: ${k} ${a[k]} vs ${e[k]}`);
    }
    for (const k of ["detector_confidence", "detector_max_confidence"]) {
      check(Math.abs(a[k] - e[k]) <= tol.detector_confidence_abs, `${L}: ${k} ${a[k]} vs ${e[k]}`);
    }
    check((a.feature_values === null) === (e.feature_values === null), `${L}: feature_values presence`);
    if (a.feature_values && e.feature_values) {
      for (const f of V2_FEATURE_ORDER) {
        const rel = Math.abs(a.feature_values[f] - e.feature_values[f]) / Math.abs(e.feature_values[f]);
        check(rel <= tol.feature_values_relative, `${L}: ${f} relative difference ${rel}`);
      }
    }
    check((a.mean_rms === null) === (e.mean_rms === null), `${L}: mean_rms presence`);
    if (a.mean_rms !== null && e.mean_rms !== null) {
      const rel = Math.abs(a.mean_rms - e.mean_rms) / Math.abs(e.mean_rms);
      check(rel <= tol.mean_rms_relative, `${L}: mean_rms relative difference ${rel}`);
    }
    check((a.feature_z_scores === null) === (e.feature_z_scores === null), `${L}: z presence`);
    if (a.feature_z_scores && e.feature_z_scores) {
      for (const f of V2_FEATURE_ORDER) {
        check(Math.abs(a.feature_z_scores[f] - e.feature_z_scores[f]) <= tol.feature_z_scores_abs, `${L}: z ${f}`);
      }
    }
    check((a.anomaly_score === null) === (e.anomaly_score === null), `${L}: anomaly_score presence`);
    if (a.anomaly_score !== null && e.anomaly_score !== null) {
      check(Math.abs(a.anomaly_score - e.anomaly_score) <= tol.anomaly_score_abs, `${L}: anomaly_score`);
    }
  });
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateSchema = ajv.compile(readJson(new URL("assets/ml/v2_validation/inference_output.schema.json", ROOT)));
function checkSchemas(output, label) {
  check(validateSchema(output), `${label}: inference_output.schema.json: ${ajv.errorsText(validateSchema.errors)}`);
  try {
    validateOutput(output);
    passed++;
  } catch (e) {
    check(false, `${label}: validateOutput: ${e.message}`);
  }
  const roundTrip = JSON.parse(JSON.stringify(output));
  check(JSON.stringify(roundTrip) === JSON.stringify(output), `${label}: JSON round trip`);
}

async function goldenCases() {
  console.log("1. Golden cases (run() end to end)");
  const pipeline = await createNodePipeline();
  for (const c of manifest.cases) {
    const expected = readJson(new URL(c.expected, GOLDEN));
    checkSchemas(expected, `${c.case} (expected file)`);
    let source;
    if (c.input.type === "synthetic_wav") {
      const url = new URL(c.input.path, GOLDEN);
      check(crypto.createHash("sha256").update(fs.readFileSync(url)).digest("hex") === c.input.sha256, `${c.case}: input sha256`);
      source = new WavPcmSource(fs.readFileSync(url), { inputDomain: c.input_domain, sourceId: path.basename(c.input.path) });
    } else if (c.input.type === "dataset_wav") {
      const file = path.join(DATA_DIR, c.input.file);
      if (!fs.existsSync(file)) {
        skipped++;
        console.log(`  SKIPPED ${c.case}: ${c.input.file} not found in ${DATA_DIR}`);
        continue;
      }
      const bytes = fs.readFileSync(file);
      check(crypto.createHash("sha256").update(bytes).digest("hex") === c.input.sha256, `${c.case}: input sha256`);
      source = new WavPcmSource(bytes, { inputDomain: c.input_domain, sourceId: c.input.file });
    } else if (c.case === "input_error_sample_rate_16k") {
      source = new ArrayPcmSource({ samples: new Float32Array(16000), sampleRate: 16000 });
    } else if (c.case === "input_error_too_short") {
      source = new ArrayPcmSource({ samples: new Float32Array(1535), sampleRate: 8000 });
    } else {
      check(false, `unknown golden case ${c.case}`);
      continue;
    }
    const output = await pipeline.run(source);
    compareOutput(output, expected, c.case);
    checkSchemas(output, c.case);
    console.log(`  ${c.case}: ${output.recording_status}${output.error ? ` (${output.error})` : ""}, ${output.n_events} event(s), ${output.n_scored} scored`);
  }
}

// ─── Unit checks ─────────────────────────────────────────────────────────────

async function inputErrors() {
  console.log("2. Input error codes");
  const pipeline = await createNodePipeline();
  const ok = new Float32Array(16000);
  const cases = [
    ["unsupported_sample_rate", { samples: ok, sampleRate: 16000 }],
    ["invalid_shape", { samples: ok, sampleRate: 8000, channels: 2 }],
    ["invalid_shape", { samples: "not audio", sampleRate: 8000 }],
    ["empty_audio", { samples: new Float32Array(0), sampleRate: 8000 }],
    ["nonfinite_audio", { samples: Float32Array.from({ length: 16000 }, (_, i) => (i === 7 ? NaN : 0)), sampleRate: 8000 }],
    ["amplitude_out_of_range", { samples: Float32Array.from({ length: 16000 }, (_, i) => (i === 100 ? 1.5 : 0)), sampleRate: 8000 }],
    ["shorter_than_one_detector_window", { samples: new Float32Array(1535), sampleRate: 8000 }],
  ];
  for (const [code, pcm] of cases) {
    const output = await pipeline.run(new ArrayPcmSource(pcm));
    check(output.recording_status === "INPUT_ERROR" && output.error === code, `expected ${code}, got ${output.error}`);
    checkSchemas(output, `input error ${code}`);
  }
  check(checkInput({ samples: new Float32Array(1536), sampleRate: 8000, channels: 1 }).error === null, "1536 samples accepted");
  check(checkInput({ samples: Float32Array.of(...new Array(1536).fill(1.0)), sampleRate: 8000, channels: 1 }).error === null,
    "amplitude exactly 1.0 accepted");
  const prism = await pipeline.run(new ArrayPcmSource({ samples: new Float32Array(16000), sampleRate: 8000, inputDomain: "prism_hardware" }));
  check(prism.input.input_domain === "prism_hardware" && prism.baseline_domain_validated === false, "prism_hardware → baseline_domain_validated false");
  let threw = false;
  try {
    await pipeline.run(new ArrayPcmSource({ samples: ok, sampleRate: 8000, inputDomain: "device" }));
  } catch (e) {
    threw = e instanceof ContractError;
  }
  check(threw, "unknown input_domain is refused");
  const dated = await pipeline.run(new ArrayPcmSource({ samples: ok, sampleRate: 8000, recordedAt: new Date("2026-10-07T08:00:00Z") }));
  check(dated.input.recorded_at === "2026-10-07T08:00:00.000Z", "recorded_at Date → ISO 8601 string");
}

function baselineValidation() {
  console.log("3. Baseline validation");
  const ok = BaselineStore.validate(baselineV2);
  check(ok.baselineId === "prism-v2-global-2026-09-30" && ok.featureNames.join() === V2_FEATURE_ORDER.join(), "bundled baseline accepted");
  const mutate = (fn) => {
    const copy = JSON.parse(JSON.stringify(baselineV2));
    fn(copy);
    return copy;
  };
  throwsContract(() => BaselineStore.validate(mutate((b) => { b.contract_version = "prism-inference-v1.0"; })), "wrong contract_version refused");
  throwsContract(() => BaselineStore.validate(mutate((b) => { b.baseline_id = "personal-1"; })), "unknown baseline_id refused");
  throwsContract(() => BaselineStore.validate(mutate((b) => { b.features = [...b.features].reverse(); })), "wrong feature order refused");
  throwsContract(() => BaselineStore.validate(mutate((b) => { b.parameters.spectral_flatness_mean.mad = 0; })), "MAD 0 refused");
  throwsContract(() => BaselineStore.validate(mutate((b) => { b.parameters.spectral_centroid_std.scale *= 1.001; })), "scale != 1.4826 MAD refused");
  throwsContract(() => BaselineStore.validate(mutate((b) => { b.parameters.spectral_rolloff_std.center = null; })), "non-finite center refused");
  throwsContract(() => BaselineStore.validate(mutate((b) => { b.mad_scale = 1.5; })), "mad_scale refused");
  throwsContract(() => BaselineStore.validate(mutate((b) => { delete b.parameters.spectral_rolloff_std; })), "missing parameters refused");
}

async function outputValidation() {
  console.log("4. Output validation and JSON safety");
  const expected = readJson(new URL("expected/short_event_not_scoreable.json", GOLDEN));
  const variants = {
    "Float64Array z-scores": (o) => { o.events[0].feature_z_scores = new Float64Array(4); },
    "undefined mean_rms": (o) => { o.events[0].mean_rms = undefined; },
    "camelCase key": (o) => { o.recordingStatus = o.recording_status; delete o.recording_status; },
    "free-text error": (o) => { o.recording_status = "INPUT_ERROR"; o.error = "channels must be 1"; o.events = []; o.n_events = 0; o.n_scored = 0; },
    "NaN score": (o) => { o.events[0].anomaly_score = NaN; },
    "score != rms(z)": (o) => { o.events[0].anomaly_score += 0.01; },
    "label output": (o) => { o.events[0].status = "ANOMALY"; },
    "unordered events": (o) => { o.events.reverse(); },
    "domain flag": (o) => { o.baseline_domain_validated = false; },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const copy = JSON.parse(JSON.stringify(expected));
    mutate(copy);
    throwsContract(() => validateOutput(copy), `rejects ${name}`);
  }
  check(roundHalfEven(0.4999995, 6) === 0.5 && roundHalfEven(2.5, 0) === 2 && roundHalfEven(3.5, 0) === 4
    && roundHalfEven(-2.5, 0) === -2, "numpy round half to even");
}

function sha256AndWav() {
  console.log("5. SHA-256 and WAV decoding");
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000]) {
    const bytes = crypto.randomBytes(n);
    check(sha256Hex(new Uint8Array(bytes)) === crypto.createHash("sha256").update(bytes).digest("hex"), `sha256 of ${n} bytes`);
  }
  const model = new Uint8Array(fs.readFileSync(MODEL_URL));
  check(sha256Hex(model) === MODEL_SHA256, "model sha256 equals the contract's");

  const wav = (channels, frames, extraChunk) => {
    const data = Buffer.alloc(frames.length * 2);
    frames.forEach((v, i) => data.writeInt16LE(v, 2 * i));
    const fmt = Buffer.alloc(24);
    fmt.write("fmt ", 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(channels, 10);
    fmt.writeUInt32LE(8000, 12); fmt.writeUInt32LE(8000 * 2 * channels, 16); fmt.writeUInt16LE(2 * channels, 20); fmt.writeUInt16LE(16, 22);
    const extra = extraChunk ?? Buffer.alloc(0);
    const head = Buffer.alloc(8); head.write("data", 0); head.writeUInt32LE(data.length, 4);
    const riff = Buffer.alloc(12); riff.write("RIFF", 0); riff.writeUInt32LE(4 + fmt.length + extra.length + 8 + data.length, 4); riff.write("WAVE", 8);
    return new Uint8Array(Buffer.concat([riff, fmt, extra, head, data]));
  };
  const mono = decodeWav(wav(1, [0, 16384, -32768, 32767]));
  check(mono.sampleRate === 8000 && mono.channels === 1 && mono.samples[1] === 0.5 && mono.samples[2] === -1
    && mono.samples[3] === Math.fround(32767 / 32768), "mono int16 / 32768");
  const odd = Buffer.alloc(12); odd.write("LIST", 0); odd.writeUInt32LE(3, 4); // odd-sized chunk + pad byte
  check(decodeWav(wav(1, [100, 200], odd)).samples.length === 2, "odd-sized chunk padding");
  const stereo = decodeWav(wav(2, [16384, 0, -16384, -16384]));
  check(stereo.channels === 1 && stereo.fileChannels === 2 && stereo.samples[0] === 0.25 && stereo.samples[1] === -0.5, "stereo averaged to mono");
  let threw = false;
  try { decodeWav(new Uint8Array(20)); } catch (e) { threw = e instanceof WavDecodeError; }
  check(threw, "non-WAV bytes rejected");
}

await goldenCases();
await inputErrors();
baselineValidation();
await outputValidation();
sha256AndWav();

console.log(`\n${passed} checks passed, ${failed} failed, ${skipped} golden case(s) skipped`);
if (skipped > 0 && process.env.PRISM_REQUIRE_DATASET === "1") {
  console.error("PRISM_REQUIRE_DATASET=1 but dataset golden inputs are missing");
  process.exit(1);
}
process.exit(failed === 0 ? 0 : 1);
