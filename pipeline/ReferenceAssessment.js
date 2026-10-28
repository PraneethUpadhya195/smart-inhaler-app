/**
 * pipeline/ReferenceAssessment.js
 *
 * Stage 9 final event-level assessment (contract prism-assessment-v1.0) on the device.
 * Port of `prism_assessment.py` in the research repository (assess_event, assess_recording,
 * validate_assessment_output); the reference is assets/ml/final_assessment/assessment_reference_v1.json,
 * a verbatim copy of the research output (reference_id prism-assessment-ref-2026-10-06).
 *
 *   canonical V2 output (InferencePipeline.run) + the recording's waveform
 *   -> per scoreable event: aggregate deviation a = sqrt(mean z^2) in the reference coordinates
 *   -> empirical reference-tail probability p = (1 + #{i : c_i >= a}) / (n + 1)
 *   -> WITHIN_REFERENCE_RANGE / OUTSIDE_REFERENCE_RANGE against the one-sided 95% upper reference
 *      limit c* (a > c*), because the Stage 9 gate adopted the categorical statement
 *   -> STABLE / BORDERLINE: the event's deviation and its +/-1 detector-stride segmentation
 *      variants all lie on one side of the session-bootstrap band of c*, or not
 *
 * Meaning (contract): acoustic deviation relative to the PRISM reference corpus only. It is not a
 * normal/abnormal, anomaly, technique-quality or clinical classification. Its calibration was
 * checked held-out by recording session on the same corpus; it is not validated for PRISM
 * hardware (input_domain "prism_hardware": baseline_domain_validated = false).
 *
 * Kept separate from the V2 inference output: run() is unchanged and its output stays verbatim
 * under the session's `recordings`; this module returns a second object per recording.
 */

import { assessmentReferenceV1 } from "./contractAssets.js";
import { assertPlainJson, isClose, rmsZ } from "./contract.js";
import { INFERENCE_CONTRACT_VERSION, PIPELINE_CONFIG, V2_FEATURE_ORDER, MAD_SCALE } from "./versions.js";

export const ASSESSMENT_CONTRACT_VERSION = "prism-assessment-v1.0";
export const ASSESSMENT_REFERENCE_SHA256 = "32ada36c21fc66c331618a9182d79f1d81d7b18a65a4dc73022a044a11cdcca8";

export const ASSESSMENT_CATEGORIES = Object.freeze([
  "WITHIN_REFERENCE_RANGE", "OUTSIDE_REFERENCE_RANGE", "CONTINUOUS_ONLY", "NOT_ASSESSED",
]);
export const ASSESSMENT_RELIABILITY = Object.freeze(["STABLE", "BORDERLINE"]);

// Detector timing written as post_event.generate_window_predictions computes it, so that the
// segmentation variants reproduce the detector's float bounds bit for bit.
const SR = PIPELINE_CONFIG.sampleRate;
const STRIDE_S = PIPELINE_CONFIG.windowStride * PIPELINE_CONFIG.hopLength / SR; // 0.016 s
const WINDOW_S = PIPELINE_CONFIG.windowSize * PIPELINE_CONFIG.hopLength / SR; // 0.2 s
const VARIANT_SHIFTS = [-1, 0, 1].flatMap((ds) => [-1, 0, 1].map((de) => [ds, de]))
  .filter(([ds, de]) => ds !== 0 || de !== 0);

export const ASSESSMENT_INTERPRETATION =
  "aggregate_deviation a is the root-mean-square of robust z-scores of four spectral features relative to a " +
  "global reference baseline. reference_tail_probability is the empirical reference-tail probability " +
  "p = (1 + #{i : c_i >= a}) / (n + 1), where c_1..c_n are the reference deviations (n = n_reference_events; " +
  "each reference inhalation scored by a baseline fitted without its own recording session): an empirical " +
  "upper-tail probability of the reference deviation distribution with the +1 correction, not a hypothesis-test " +
  "p-value. OUTSIDE_REFERENCE_RANGE means p <= 0.05, equivalently a above the one-sided 95% upper reference limit " +
  "(reference.cut); WITHIN_REFERENCE_RANGE means p > 0.05. STABLE means the category is unchanged under " +
  "resampling of the reference sessions and +/-1 detector-window boundary shifts; BORDERLINE means it changes " +
  "under at least one of them. These statements describe acoustic deviation relative to the PRISM reference " +
  "corpus only; they are not normal/abnormal, anomaly, technique-quality or clinical classifications.";

const OUTPUT_KEYS = ["contract_version", "inference_contract_version", "reference_id", "baseline_id",
  "detector_model_sha256", "recording_status", "error", "input", "baseline_domain_validated", "feature_order",
  "reference", "n_events", "n_scoreable", "n_outside_reference_range", "events", "interpretation"];
const REFERENCE_KEYS = ["alpha", "categorical", "cut", "band", "n_reference_events", "n_reference_sessions",
  "feature_center", "feature_scale"];
const EVENT_KEYS = ["event_id", "start_time", "end_time", "duration_s", "start_sample", "end_sample",
  "detector_confidence", "detector_max_confidence", "window_count", "scoreability", "not_scoreable_reasons",
  "feature_values", "mean_rms", "feature_deviations", "aggregate_deviation", "reference_tail_probability",
  "assessment", "assessment_reliability", "segmentation_variants", "segmentation_deviation_range",
  "dominant_feature", "dominant_share", "reason"];

/** Reference or output does not satisfy the assessment contract (prism_assessment.AssessmentError). */
export class AssessmentError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssessmentError";
  }
}
const require_ = (condition, message) => { if (!condition) throw new AssessmentError(message); };

// ─── Reference statistics ───────────────────────────────────────────────────

/** "1/20" -> { num: 1, den: 20 } (Python Fraction text). */
function parseFraction(text) {
  const m = /^(\d+)\/(\d+)$/.exec(String(text));
  require_(m !== null, `alpha ${text} is not a fraction`);
  return { num: Number(m[1]), den: Number(m[2]) };
}

/** Largest m with (1 + m) / (n + 1) <= alpha, exactly (prism_assessment.tail_count_limit). */
export function tailCountLimit(n, alpha) {
  return Math.floor((alpha.num * (n + 1) - alpha.den) / alpha.den);
}

/** One-sided upper reference limit c*: the (n - m)-th smallest calibration score (+inf if none). */
export function referenceCut(sortedCalibration, alpha) {
  const m = tailCountLimit(sortedCalibration.length, alpha);
  if (m < 0) return Infinity;
  return sortedCalibration[sortedCalibration.length - m - 1];
}

/** (1 + #{c >= s}) / (n + 1) on an ascending array (numpy.searchsorted side="left"). */
export function tailProbability(score, sortedCalibration) {
  let lo = 0;
  let hi = sortedCalibration.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedCalibration[mid] < score) lo = mid + 1;
    else hi = mid;
  }
  const atLeast = sortedCalibration.length - lo;
  return (1 + atLeast) / (sortedCalibration.length + 1);
}

/**
 * Validate the reference JSON (AssessmentReference.from_dict + __post_init__ + FrozenBaseline).
 * @param {Object} [raw] - parsed assessment_reference_v1.json (default: the bundled copy)
 * @returns {Object} frozen reference
 */
export function loadAssessmentReference(raw = assessmentReferenceV1) {
  require_(raw?.contract_version === ASSESSMENT_CONTRACT_VERSION, `reference was issued for ${raw?.contract_version}`);
  const baseline = raw.baseline ?? {};
  require_(baseline.contract_version === INFERENCE_CONTRACT_VERSION, "reference baseline is not for the V2 inference contract");
  require_(Array.isArray(baseline.features) && baseline.features.length === V2_FEATURE_ORDER.length
    && baseline.features.every((f, i) => f === V2_FEATURE_ORDER[i]), "reference baseline features are not in V2 order");
  require_(baseline.mad_scale === MAD_SCALE, "reference baseline mad_scale must be 1.4826");
  const centers = V2_FEATURE_ORDER.map((f) => baseline.parameters?.[f]?.center);
  const scales = V2_FEATURE_ORDER.map((f) => baseline.parameters?.[f]?.scale);
  const mads = V2_FEATURE_ORDER.map((f) => baseline.parameters?.[f]?.mad);
  require_([...centers, ...scales, ...mads].every((v) => typeof v === "number" && Number.isFinite(v)),
    "reference baseline parameters must be finite");
  require_(mads.every((v) => v > 0), "reference baseline MAD must be > 0");
  mads.forEach((mad, i) => require_(isClose(scales[i], MAD_SCALE * mad, { relTol: 1e-12 }), "scale must equal mad_scale * MAD"));

  const calibration = Array.isArray(raw.calibration) ? raw.calibration : [];
  const scores = Float64Array.from(calibration, (c) => c.score);
  const sessions = calibration.map((c) => String(c.session));
  require_(scores.length > 0, "calibration scores must be non-empty");
  require_(scores.every((s) => Number.isFinite(s) && s >= 0), "calibration scores must be finite and >= 0");
  for (let i = 1; i < scores.length; i++) require_(scores[i] >= scores[i - 1], "calibration scores must be sorted ascending");
  const alpha = parseFraction(raw.alpha);
  require_(raw.cut === referenceCut(scores, alpha), "cut does not equal the upper reference limit of the calibration scores");
  const [low, high] = raw.band ?? [];
  require_(Number.isFinite(low) && Number.isFinite(high) && low <= high, "band must be finite with low <= high");

  return Object.freeze({
    referenceId: String(raw.reference_id),
    baselineId: String(baseline.baseline_id),
    centers: Float64Array.from(centers),
    scales: Float64Array.from(scales),
    calibration: scores,
    nSessions: new Set(sessions).size,
    alpha,
    alphaValue: alpha.num / alpha.den,
    cut: raw.cut,
    band: [low, high],
    categorical: raw.categorical === true,
  });
}

// ─── Segmentation variants ──────────────────────────────────────────────────

/** Number of detector windows for n samples (frames = 1 + n // hop). */
export function windowCount(nSamples) {
  const frames = 1 + Math.floor(nSamples / PIPELINE_CONFIG.hopLength);
  return frames < PIPELINE_CONFIG.windowSize ? 0
    : Math.floor((frames - PIPELINE_CONFIG.windowSize) / PIPELINE_CONFIG.windowStride) + 1;
}

/** First and last Inhale window of an event whose end is not clamped at the recording end. */
export function windowIndexBounds(start, end) {
  const first = Math.round(start / STRIDE_S);
  const last = Math.round((end - WINDOW_S) / STRIDE_S);
  require_(first * STRIDE_S === start && last * STRIDE_S + WINDOW_S === end, "event bounds are not the detector's window bounds");
  return [first, last];
}

/** Event bounds moved by one detector stride at the start and/or end (reference float formula). */
export function segmentationVariants(start, end, nSamples) {
  const [first, last] = windowIndexBounds(start, end);
  const duration = nSamples / SR;
  const nWindows = windowCount(nSamples);
  const variants = [];
  for (const [ds, de] of VARIANT_SHIFTS) {
    const a = first + ds;
    const b = last + de;
    if (a < 0 || b >= nWindows || b < a) continue;
    variants.push([a * STRIDE_S, Math.min(b * STRIDE_S + WINDOW_S, duration)]);
  }
  return variants;
}

// ─── Assessment ─────────────────────────────────────────────────────────────

const zScores = (values, reference) => values.map((x, i) => (x - reference.centers[i]) / reference.scales[i]);

/** prism_assessment._reason */
function reasonText(category, p, dominant, reasons, alphaValue) {
  if (category === "NOT_ASSESSED") return `not scoreable: ${reasons.join(", ")}`;
  const limit = `one-sided ${Number((100 * (1 - alphaValue)).toPrecision(6))}% upper reference limit`;
  const text = {
    WITHIN_REFERENCE_RANGE: `deviation at or below the ${limit}`,
    OUTSIDE_REFERENCE_RANGE: `deviation above the ${limit}`,
    CONTINUOUS_ONLY: "no categorical statement (continuous deviation only)",
  }[category];
  return `${text} (empirical reference-tail probability ${p.toFixed(3)}; largest deviation: ${dominant})`;
}

/**
 * Deviation of every segmentation variant (unchanged V2 measurement through the pipeline's own
 * extractEventPcm / extractEventFeatures); empty or non-finite variants are skipped.
 */
async function variantScores(pipeline, pcm, bounds, reference) {
  const scores = [];
  for (const [startS, endS] of bounds) {
    const segment = pipeline.extractEventPcm({ startS, endS }, pcm);
    if (segment.length === 0) continue;
    const measured = await pipeline.extractEventFeatures(segment);
    const values = Array.from(measured.features);
    if (values.every(Number.isFinite)) scores.push(rmsZ(zScores(values, reference)));
  }
  return scores;
}

/**
 * Attach the Stage 9 assessment to one canonical event (prism_assessment.assess_event).
 * @param {import('./InferencePipeline').default} pipeline
 * @param {Object} event - event of the canonical V2 output
 * @param {Object} reference - loadAssessmentReference()
 * @param {{ samples: Float32Array, sampleRate: number }|null} pcm - the validated waveform
 */
export async function assessEvent(pipeline, event, reference, pcm) {
  const nSamples = pcm ? pcm.samples.length : 0;
  const scoreable = event.status === "SCORE_ONLY";
  const values = event.feature_values ? V2_FEATURE_ORDER.map((f) => event.feature_values[f]) : null;
  const z = scoreable ? zScores(values, reference) : null;
  const out = {
    event_id: event.event_id,
    start_time: event.start_time,
    end_time: event.end_time,
    duration_s: event.duration_s,
    start_sample: Math.max(0, Math.floor(event.start_time * SR)),
    end_sample: Math.min(nSamples, Math.ceil(event.end_time * SR)),
    detector_confidence: event.detector_confidence,
    detector_max_confidence: event.detector_max_confidence,
    window_count: event.window_count,
    scoreability: scoreable ? "SCOREABLE" : "NOT_SCOREABLE",
    not_scoreable_reasons: [...event.not_scoreable_reasons],
    feature_values: event.feature_values,
    mean_rms: event.mean_rms,
    feature_deviations: z ? Object.fromEntries(V2_FEATURE_ORDER.map((f, i) => [f, z[i]])) : null,
    aggregate_deviation: z ? rmsZ(z) : null,
    reference_tail_probability: null,
    assessment: "NOT_ASSESSED",
    assessment_reliability: null,
    segmentation_variants: 0,
    segmentation_deviation_range: null,
    dominant_feature: null,
    dominant_share: null,
    reason: "",
  };
  if (!scoreable) {
    out.reason = reasonText("NOT_ASSESSED", null, null, out.not_scoreable_reasons, reference.alphaValue);
    return out;
  }
  const score = out.aggregate_deviation;
  const squared = z.map((v) => v * v);
  let argmax = 0;
  for (let i = 1; i < squared.length; i++) if (squared[i] > squared[argmax]) argmax = i;
  const sumSquared = squared.reduce((a, b) => a + b, 0); // sequential, as numpy for 4 values
  const variants = await variantScores(pipeline, pcm,
    segmentationVariants(event.start_time, event.end_time, nSamples), reference);
  const p = tailProbability(score, reference.calibration);
  let category = "CONTINUOUS_ONLY";
  let reliability = null;
  if (reference.categorical) {
    category = score > reference.cut ? "OUTSIDE_REFERENCE_RANGE" : "WITHIN_REFERENCE_RANGE";
    const all = [score, ...variants];
    const [low, high] = reference.band;
    reliability = all.every((v) => v > high) || all.every((v) => v <= low) ? "STABLE" : "BORDERLINE";
  }
  Object.assign(out, {
    reference_tail_probability: p,
    assessment: category,
    assessment_reliability: reliability,
    segmentation_variants: variants.length,
    segmentation_deviation_range: [Math.min(score, ...variants), Math.max(score, ...variants)],
    dominant_feature: V2_FEATURE_ORDER[argmax],
    dominant_share: sumSquared > 0 ? squared[argmax] / sumSquared : 0,
  });
  out.reason = reasonText(category, p, out.dominant_feature, [], reference.alphaValue);
  return out;
}

/**
 * The Stage 9 assessment of one recording (prism_assessment.assess_recording), from the canonical
 * V2 output of the same waveform. The V2 output is not changed.
 *
 * @param {import('./InferencePipeline').default} pipeline - the pipeline that produced `inference`
 * @param {Object} inference - InferencePipeline.run() output
 * @param {{ samples: Float32Array, sampleRate: number }|null} pcm - the waveform given to run()
 *   (float32 = int16 / 32768); may be null when the recording is an INPUT_ERROR
 * @param {Object} [reference] - loadAssessmentReference() (default: the bundled reference)
 * @returns {Promise<Object>} assessment output (assessment_output.schema.json)
 */
export async function assessRecording(pipeline, inference, pcm, reference = defaultReference()) {
  require_(inference?.contract_version === INFERENCE_CONTRACT_VERSION, "expects a prism-inference-v2.0 output");
  if (inference.events.length > 0) require_(pcm && pcm.samples, "events need the recording's waveform");
  const events = [];
  for (const event of inference.events) events.push(await assessEvent(pipeline, event, reference, pcm));
  const output = {
    contract_version: ASSESSMENT_CONTRACT_VERSION,
    inference_contract_version: inference.contract_version,
    reference_id: reference.referenceId,
    baseline_id: reference.baselineId,
    detector_model_sha256: inference.detector_model_sha256,
    recording_status: inference.recording_status,
    error: inference.error,
    input: { ...inference.input },
    baseline_domain_validated: inference.baseline_domain_validated,
    feature_order: [...inference.feature_order],
    reference: {
      alpha: reference.alphaValue,
      categorical: reference.categorical,
      cut: reference.cut,
      band: [...reference.band],
      n_reference_events: reference.calibration.length,
      n_reference_sessions: reference.nSessions,
      feature_center: Object.fromEntries(V2_FEATURE_ORDER.map((f, i) => [f, reference.centers[i]])),
      feature_scale: Object.fromEntries(V2_FEATURE_ORDER.map((f, i) => [f, reference.scales[i]])),
    },
    n_events: events.length,
    n_scoreable: events.filter((e) => e.scoreability === "SCOREABLE").length,
    n_outside_reference_range: events.filter((e) => e.assessment === "OUTSIDE_REFERENCE_RANGE").length,
    events,
    interpretation: ASSESSMENT_INTERPRETATION,
  };
  validateAssessmentOutput(output);
  return output;
}

let defaultReferenceCache = null;
function defaultReference() {
  if (!defaultReferenceCache) defaultReferenceCache = loadAssessmentReference();
  return defaultReferenceCache;
}

const sameKeys = (object, keys) => {
  const actual = Object.keys(object ?? {});
  return actual.length === keys.length && actual.every((k, i) => k === keys[i]);
};

/** Throw AssessmentError unless `output` satisfies the assessment contract (validate_assessment_output). */
export function validateAssessmentOutput(output) {
  require_(sameKeys(output, OUTPUT_KEYS), `output keys must be exactly ${OUTPUT_KEYS.join(", ")}`);
  require_(output.contract_version === ASSESSMENT_CONTRACT_VERSION, "wrong contract_version");
  require_(output.inference_contract_version === INFERENCE_CONTRACT_VERSION, "wrong inference_contract_version");
  require_(sameKeys(output.reference, REFERENCE_KEYS), `reference keys must be exactly ${REFERENCE_KEYS.join(", ")}`);
  const events = output.events;
  require_(output.n_events === events.length, "n_events mismatch");
  require_(output.n_scoreable === events.filter((e) => e.scoreability === "SCOREABLE").length, "n_scoreable mismatch");
  require_(output.n_outside_reference_range === events.filter((e) => e.assessment === "OUTSIDE_REFERENCE_RANGE").length,
    "n_outside_reference_range mismatch");
  const categorical = output.reference.categorical;
  events.forEach((event, position) => {
    require_(sameKeys(event, EVENT_KEYS), `event keys must be exactly ${EVENT_KEYS.join(", ")}`);
    require_(event.event_id === position, "event_id must be 0, 1, ... in order");
    require_(["SCOREABLE", "NOT_SCOREABLE"].includes(event.scoreability) && ASSESSMENT_CATEGORIES.includes(event.assessment),
      "unknown status");
    require_(event.start_sample >= 0 && event.start_sample < event.end_sample, "sample bounds must satisfy 0 <= start < end");
    if (event.scoreability === "NOT_SCOREABLE") {
      require_(event.assessment === "NOT_ASSESSED" && event.not_scoreable_reasons.length > 0,
        "NOT_SCOREABLE events are NOT_ASSESSED and carry reasons");
      require_(["aggregate_deviation", "feature_deviations", "reference_tail_probability", "assessment_reliability"]
        .every((k) => event[k] === null), "NOT_SCOREABLE events carry no deviation, probability or reliability");
      return;
    }
    require_(event.not_scoreable_reasons.length === 0, "SCOREABLE events have no not_scoreable_reasons");
    const p = event.reference_tail_probability;
    const score = event.aggregate_deviation;
    require_(p !== null && p > 0 && p <= 1 && Number.isFinite(score) && score >= 0, "invalid score or probability");
    const z = V2_FEATURE_ORDER.map((f) => event.feature_deviations[f]);
    require_(isClose(score, rmsZ(z), { relTol: 1e-12, absTol: 1e-15 }), "aggregate_deviation != rms(z)");
    if (categorical) {
      const expected = score > output.reference.cut ? "OUTSIDE_REFERENCE_RANGE" : "WITHIN_REFERENCE_RANGE";
      require_(event.assessment === expected, "assessment disagrees with the reference cut");
      require_(event.assessment !== "OUTSIDE_REFERENCE_RANGE" || p <= output.reference.alpha + 1e-12,
        "OUTSIDE events must have p <= alpha");
      require_(ASSESSMENT_RELIABILITY.includes(event.assessment_reliability), "categorical assessments need a reliability");
    } else {
      require_(event.assessment === "CONTINUOUS_ONLY" && event.assessment_reliability === null,
        "non-categorical references give CONTINUOUS_ONLY without reliability");
    }
    const [low, high] = event.segmentation_deviation_range;
    require_(low <= score && score <= high, "segmentation range must contain the event's own deviation");
  });
  require_(output.interpretation === ASSESSMENT_INTERPRETATION, "interpretation must be the contract text");
  assertPlainJson(output, "assessment");
}
