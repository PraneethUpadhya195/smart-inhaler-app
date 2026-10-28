/**
 * pipeline/test_assessment.js — Stage 9 final assessment (prism-assessment-v1.0) on the app side.
 *
 * 1. The bundled reference (assets/ml/final_assessment/assessment_reference_v1.json) is the research
 *    file named by the assessment contract (SHA-256) and loads with the contract's cut and band.
 * 2. Unit checks of the reference statistics against the contract text (tail probability, cut rank,
 *    segmentation variants).
 * 3. The 9 golden cases of assets/ml/final_assessment/golden/golden_manifest.json (same inputs as the
 *    V2 golden cases): InferencePipeline.run() + assessRecording() compared with the research outputs
 *    at the manifest's tolerances (inference fields as V2; tail probability exact when the deviation
 *    is within 0.01 and not within 0.01 of a calibration score; assessment and reliability exact).
 *    The 5 dataset recordings are read from PRISM_DATA_DIR (default ../PRISM smart inhaler/data);
 *    absent ones are SKIPPED unless PRISM_REQUIRE_DATASET=1.
 * 4. Every output is validated by validateAssessmentOutput and by Ajv against
 *    assessment_output.schema.json; tampered outputs and references are refused.
 *
 * Run: node pipeline/test_assessment.js   (part of npm test)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import PcmSource from "./PcmSource.js";
import WavPcmSource from "./sources/WavPcmSource.js";
import { createNodePipeline } from "./runtime/node.js";
import {
  assessRecording,
  loadAssessmentReference,
  tailProbability,
  tailCountLimit,
  referenceCut,
  segmentationVariants,
  windowCount,
  validateAssessmentOutput,
  AssessmentError,
  ASSESSMENT_REFERENCE_SHA256,
} from "./ReferenceAssessment.js";
import { V2_FEATURE_ORDER } from "./versions.js";

const ROOT = new URL("..", import.meta.url);
const V2_GOLDEN = new URL("assets/ml/v2_validation/golden/", ROOT);
const GOLDEN = new URL("assets/ml/final_assessment/golden/", ROOT);
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
function refuses(fn, message) {
  try {
    fn();
    check(false, `${message} (accepted)`);
  } catch (e) {
    check(e instanceof AssessmentError, `${message} (threw ${e.name}: ${e.message})`);
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

const contract = readJson(new URL("assets/ml/final_assessment/assessment_contract_v1.json", ROOT));
const referenceRaw = readJson(new URL("assets/ml/final_assessment/assessment_reference_v1.json", ROOT));
const reference = loadAssessmentReference(referenceRaw);

// ─── 1. Reference ────────────────────────────────────────────────────────────
console.log("1. Bundled reference");
const refBytes = fs.readFileSync(new URL("assets/ml/final_assessment/assessment_reference_v1.json", ROOT));
const refSha = crypto.createHash("sha256").update(refBytes).digest("hex");
check(refSha === contract.reference.sha256 && refSha === ASSESSMENT_REFERENCE_SHA256, `reference SHA-256 ${refSha} is the contract's`);
check(contract.status === "CATEGORICAL_ASSESSMENT_ADOPTED" && reference.categorical === true, "categorical statement adopted by the gate");
check(reference.referenceId === contract.reference.reference_id, "reference_id");
check(reference.cut === contract.reference.cut && reference.band[0] === contract.reference.band[0]
  && reference.band[1] === contract.reference.band[1], `cut ${reference.cut} and band ${reference.band}`);
check(reference.calibration.length === contract.reference.n_events && reference.nSessions === contract.reference.n_sessions,
  `${reference.calibration.length} reference events from ${reference.nSessions} sessions`);
const v2Baseline = readJson(new URL("assets/ml/v2_validation/v2_baseline.json", ROOT));
check(V2_FEATURE_ORDER.every((f, i) => reference.centers[i] === v2Baseline.parameters[f].center
  && reference.scales[i] === v2Baseline.parameters[f].scale), "reference baseline is identical to the V2 baseline (contract)");

// ─── 2. Unit checks ──────────────────────────────────────────────────────────
console.log("2. Reference statistics");
const cal = reference.calibration;
check(tailCountLimit(318, { num: 1, den: 20 }) === 14, "m = floor(alpha (n + 1) - 1) = 14 for n = 318");
check(referenceCut(cal, { num: 1, den: 20 }) === cal[303], "cut = 304th smallest of 318 (contract: rank 304)");
check(tailProbability(cal[cal.length - 1] + 1, cal) === 1 / 319, "above every reference deviation: p = 1/319");
check(tailProbability(0, cal) === 1, "zero deviation: p = 1");
check(tailProbability(reference.cut, cal) === 16 / 319, "at the cut: p = 16/319 > 0.05 (WITHIN), ties count as >=");
check(tailProbability(reference.cut + 1e-12, cal) === 15 / 319, "just above the cut: p = 15/319 <= 0.05 (contract: effective level 15/319)");
check(windowCount(96000) === 739, "739 detector windows in 12 s");
const variants = segmentationVariants(2.496, 4.04, 96000);
check(variants.length === 8 && variants.every(([s, e]) => e > s), "an interior event has 8 segmentation variants");
const firstWindow = segmentationVariants(0, 0.2, 96000);
// windows (first, last) = (0, 0): only (0, 1) and (1, 1) are valid shifts (a >= 0, b >= a)
check(firstWindow.length === 2 && firstWindow[0][0] === 0 && firstWindow[1][0] === 0.016,
  `an event of the first window only has 2 variants (got ${JSON.stringify(firstWindow)})`);
refuses(() => segmentationVariants(1.0001, 2, 96000), "bounds that are not detector window bounds are refused");

// ─── 3. Golden cases ─────────────────────────────────────────────────────────
const manifest = readJson(new URL("golden_manifest.json", GOLDEN));
const v2Manifest = readJson(new URL("golden_manifest.json", V2_GOLDEN));
const tol = v2Manifest.tolerances;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateSchema = ajv.compile(readJson(new URL("assets/ml/final_assessment/assessment_output.schema.json", ROOT)));
const nearCalibration = (a) => cal.some((c) => Math.abs(c - a) <= 0.01);

function checkOutput(output, label) {
  check(validateSchema(output), `${label}: assessment_output.schema.json: ${ajv.errorsText(validateSchema.errors)}`);
  try {
    validateAssessmentOutput(output);
    passed++;
  } catch (e) {
    check(false, `${label}: validateAssessmentOutput: ${e.message}`);
  }
}

function compare(actual, expected, label) {
  const exact = ["contract_version", "inference_contract_version", "reference_id", "baseline_id", "detector_model_sha256",
    "recording_status", "error", "baseline_domain_validated", "n_events", "n_scoreable", "n_outside_reference_range",
    "interpretation"];
  for (const k of exact) check(actual[k] === expected[k], `${label}: ${k} ${actual[k]} != ${expected[k]}`);
  for (const k of ["input", "feature_order", "reference"]) {
    check(JSON.stringify(actual[k]) === JSON.stringify(expected[k]), `${label}: ${k} ${JSON.stringify(actual[k])}`);
  }
  check(JSON.stringify(Object.keys(actual)) === JSON.stringify(Object.keys(expected)), `${label}: key order`);
  check(actual.events.length === expected.events.length, `${label}: event count`);
  actual.events.forEach((a, i) => {
    const e = expected.events[i];
    if (!e) return;
    const L = `${label} event ${i}`;
    check(JSON.stringify(Object.keys(a)) === JSON.stringify(Object.keys(e)), `${L}: key order`);
    for (const k of ["event_id", "start_sample", "end_sample", "window_count", "scoreability", "assessment",
      "assessment_reliability", "segmentation_variants", "dominant_feature"]) {
      check(a[k] === e[k], `${L}: ${k} ${a[k]} != ${e[k]}`);
    }
    check(JSON.stringify(a.not_scoreable_reasons) === JSON.stringify(e.not_scoreable_reasons), `${L}: reasons`);
    for (const k of ["start_time", "end_time", "duration_s"]) check(Math.abs(a[k] - e[k]) <= 1e-9, `${L}: ${k}`);
    for (const k of ["detector_confidence", "detector_max_confidence"]) {
      check(Math.abs(a[k] - e[k]) <= tol.detector_confidence_abs, `${L}: ${k}`);
    }
    check((a.feature_values === null) === (e.feature_values === null), `${L}: feature_values presence`);
    if (a.feature_values && e.feature_values) {
      for (const f of V2_FEATURE_ORDER) {
        check(Math.abs(a.feature_values[f] - e.feature_values[f]) / Math.abs(e.feature_values[f]) <= tol.feature_values_relative,
          `${L}: ${f}`);
      }
    }
    if (a.mean_rms !== null && e.mean_rms !== null) {
      check(Math.abs(a.mean_rms - e.mean_rms) / Math.abs(e.mean_rms) <= tol.mean_rms_relative, `${L}: mean_rms`);
    } else check(a.mean_rms === e.mean_rms, `${L}: mean_rms presence`);
    check((a.feature_deviations === null) === (e.feature_deviations === null), `${L}: deviations presence`);
    if (a.feature_deviations && e.feature_deviations) {
      for (const f of V2_FEATURE_ORDER) {
        check(Math.abs(a.feature_deviations[f] - e.feature_deviations[f]) <= tol.feature_z_scores_abs, `${L}: deviation ${f}`);
      }
    }
    check((a.aggregate_deviation === null) === (e.aggregate_deviation === null), `${L}: aggregate presence`);
    if (a.aggregate_deviation !== null && e.aggregate_deviation !== null) {
      check(Math.abs(a.aggregate_deviation - e.aggregate_deviation) <= tol.anomaly_score_abs,
        `${L}: aggregate_deviation ${a.aggregate_deviation} vs ${e.aggregate_deviation}`);
      if (!nearCalibration(e.aggregate_deviation)) {
        check(a.reference_tail_probability === e.reference_tail_probability, `${L}: tail probability exact`);
        check(a.reason === e.reason, `${L}: reason "${a.reason}"`);
      } else {
        check(Math.abs(a.reference_tail_probability - e.reference_tail_probability) <= 3 / 319, `${L}: tail probability near a calibration score`);
      }
      a.segmentation_deviation_range.forEach((v, j) => {
        check(Math.abs(v - e.segmentation_deviation_range[j]) <= tol.anomaly_score_abs, `${L}: segmentation range ${j}`);
      });
      check(Math.abs(a.dominant_share - e.dominant_share) <= 1e-3, `${L}: dominant_share`);
    } else {
      check(a.reference_tail_probability === null && a.segmentation_deviation_range === null && a.reason === e.reason,
        `${L}: not assessed`);
    }
  });
}

async function goldenCases() {
  console.log("3. Golden cases (run() + assessRecording())");
  const pipeline = await createNodePipeline();
  const outputs = {};
  for (const c of manifest.cases) {
    const expected = readJson(new URL(c.expected, GOLDEN));
    checkOutput(expected, `${c.case} (expected file)`);
    let pcm;
    if (c.input.type === "synthetic_wav") {
      const url = new URL(c.input.path, V2_GOLDEN);
      check(crypto.createHash("sha256").update(fs.readFileSync(url)).digest("hex") === c.input.sha256, `${c.case}: input sha256`);
      pcm = await new WavPcmSource(fs.readFileSync(url), { inputDomain: c.input_domain, sourceId: path.basename(c.input.path) }).acquire();
    } else if (c.input.type === "dataset_wav") {
      const file = path.join(DATA_DIR, c.input.file);
      if (!fs.existsSync(file)) {
        skipped++;
        console.log(`  SKIPPED ${c.case}: ${c.input.file} not found in ${DATA_DIR}`);
        continue;
      }
      const bytes = fs.readFileSync(file);
      check(crypto.createHash("sha256").update(bytes).digest("hex") === c.input.sha256, `${c.case}: input sha256`);
      pcm = await new WavPcmSource(bytes, { inputDomain: c.input_domain, sourceId: c.input.file }).acquire();
    } else if (c.case === "input_error_sample_rate_16k") {
      pcm = { samples: new Float32Array(16000), sampleRate: 16000 };
    } else if (c.case === "input_error_too_short") {
      pcm = { samples: new Float32Array(1535), sampleRate: 8000 };
    } else {
      check(false, `unknown golden case ${c.case}`);
      continue;
    }
    const inference = await pipeline.run(new ArrayPcmSource(pcm));
    const output = await assessRecording(pipeline, inference, inference.recording_status === "INPUT_ERROR" ? null : pcm, reference);
    compare(output, expected, c.case);
    checkOutput(output, c.case);
    outputs[c.case] = output;
    const ev = output.events.map((e) => `${e.assessment}${e.assessment_reliability ? `/${e.assessment_reliability}` : ""}`);
    console.log(`  ${c.case}: ${output.recording_status}, ${output.n_events} event(s) ${ev.join(", ")}`);
  }
  return outputs;
}

// ─── 4. Refusals ─────────────────────────────────────────────────────────────
function refusals(outputs) {
  console.log("4. Tampered outputs and references are refused");
  const scored = outputs.single_scored_event;
  if (scored) {
    const flip = structuredClone(scored);
    flip.events[0].assessment = "OUTSIDE_REFERENCE_RANGE";
    flip.n_outside_reference_range = 1;
    refuses(() => validateAssessmentOutput(flip), "an assessment that disagrees with the cut");
    const noRel = structuredClone(scored);
    noRel.events[0].assessment_reliability = null;
    refuses(() => validateAssessmentOutput(noRel), "a categorical assessment without reliability");
    const badScore = structuredClone(scored);
    badScore.events[0].aggregate_deviation += 0.5;
    refuses(() => validateAssessmentOutput(badScore), "an aggregate deviation that is not rms(z)");
    const label = structuredClone(scored);
    label.events[0].assessment = "ANOMALY";
    refuses(() => validateAssessmentOutput(label), "a NORMAL/ANOMALY-style label");
    const extra = structuredClone(scored);
    extra.quality = 87;
    refuses(() => validateAssessmentOutput(extra), "an extra output field");
  }
  const ns = outputs.close_neighbors_not_scoreable;
  if (ns) {
    const t = structuredClone(ns);
    const i = t.events.findIndex((e) => e.scoreability === "NOT_SCOREABLE");
    t.events[i].aggregate_deviation = 1.0;
    refuses(() => validateAssessmentOutput(t), "a not-scoreable event with a deviation");
  }
  const badCut = structuredClone(referenceRaw);
  badCut.cut = 1.5;
  refuses(() => loadAssessmentReference(badCut), "a reference whose cut is not the calibration's upper limit");
  const unsorted = structuredClone(referenceRaw);
  [unsorted.calibration[0], unsorted.calibration[1]] = [unsorted.calibration[1], unsorted.calibration[0]];
  if (unsorted.calibration[0].score !== unsorted.calibration[1].score) {
    refuses(() => loadAssessmentReference(unsorted), "unsorted calibration scores");
  }
  const version = structuredClone(referenceRaw);
  version.contract_version = "prism-assessment-v0.9";
  refuses(() => loadAssessmentReference(version), "a reference for another contract version");
}

const outputs = await goldenCases();
refusals(outputs);
const dataMissing = skipped > 0 && process.env.PRISM_REQUIRE_DATASET === "1";
if (dataMissing) check(false, `${skipped} golden case(s) skipped but PRISM_REQUIRE_DATASET=1`);
console.log(`\n${passed} checks passed, ${failed} failed, ${skipped} golden case(s) skipped`);
process.exit(failed === 0 ? 0 : 1);
