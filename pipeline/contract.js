/**
 * pipeline/contract.js
 *
 * Executable form of the PRISM V2 inference contract (prism-inference-v2.0) on the app side.
 * Mirrors the reference implementation `prism_inference.py` in the research repository:
 *   - checkInput      ↔ prism_inference.check_input     (INPUT_ERROR codes, same order)
 *   - validateOutput  ↔ prism_inference.validate_output (plus the JSON-schema field types)
 *   - roundHalfEven   ↔ numpy.round(x, decimals)         (used by the usability rule)
 *
 * The canonical output is the object described by
 * assets/ml/v2_validation/inference_output.schema.json. No other result schema exists in the app.
 */

import {
  INFERENCE_CONTRACT_VERSION,
  SCORE_INTERPRETATION,
  V2_FEATURE_ORDER,
  RECORDING_STATUS,
  EVENT_STATUS,
  NOT_SCOREABLE_REASONS,
  INPUT_ERRORS,
  INPUT_DOMAINS,
  MIN_SAMPLES,
  PIPELINE_CONFIG,
  OUTPUT_KEYS,
  INPUT_KEYS,
  EVENT_KEYS,
} from "./versions.js";

/** Input, baseline or output does not satisfy the inference contract (prism_inference.ContractError). */
export class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractError";
  }
}

const REASONS = Object.values(NOT_SCOREABLE_REASONS);
const RECORDING_STATUSES = Object.values(RECORDING_STATUS);
const EVENT_STATUSES = Object.values(EVENT_STATUS);

// ─── Numerics ────────────────────────────────────────────────────────────────

/** numpy.rint: round to nearest, ties to even. */
export function rint(y) {
  if (Math.abs(y - Math.trunc(y)) === 0.5) return 2 * Math.round(y / 2);
  return Math.round(y);
}

/** numpy.round(x, decimals) for decimals >= 0: rint(x * 10**d) / 10**d. */
export function roundHalfEven(x, decimals) {
  const f = 10 ** decimals;
  return rint(x * f) / f;
}

/** math.isclose with Python's defaults (rel_tol 1e-9, abs_tol 0) unless overridden. */
export function isClose(a, b, { relTol = 1e-9, absTol = 0 } = {}) {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= Math.max(relTol * Math.max(Math.abs(a), Math.abs(b)), absTol);
}

/** anomaly_score = sqrt(mean_j z_j^2), summed in V2 order as numpy does for 4 values. */
export function rmsZ(z) {
  let sum = 0;
  for (let i = 0; i < z.length; i++) sum += z[i] * z[i];
  return Math.sqrt(sum / z.length);
}

// ─── Input ───────────────────────────────────────────────────────────────────

function asFloat32Vector(values) {
  if (values instanceof Float32Array) return values;
  if (Array.isArray(values) || values instanceof Float64Array) {
    if (Array.isArray(values) && !values.every((v) => typeof v === "number")) return null;
    return Float32Array.from(values); // numpy astype(float32)
  }
  return null;
}

/**
 * Contract input check (prism_inference.check_input), on the app's PcmData.
 *
 * Sources deliver mono audio (`channels === 1`); a multi-channel source must average its
 * channels first (WavPcmSource does). Any other shape is `invalid_shape`.
 *
 * @param {import('./types').PcmData} pcm
 * @returns {{ error: string|null, samples: Float32Array|null, nSamples: number }}
 *   `samples` is the validated float32 waveform when `error` is null.
 *   `nSamples` is the value reported in output.input.n_samples.
 */
export function checkInput(pcm) {
  const raw = pcm?.samples;
  const rawLength = raw != null && Number.isInteger(raw.length) ? raw.length : 0;
  const fail = (error) => ({ error, samples: null, nSamples: rawLength });

  if (pcm.sampleRate !== PIPELINE_CONFIG.sampleRate) return fail("unsupported_sample_rate");
  const samples = asFloat32Vector(raw);
  if (samples === null || pcm.channels !== 1) return fail("invalid_shape");
  if (samples.length === 0) return fail("empty_audio");
  let maxAbs = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (!Number.isFinite(v)) return fail("nonfinite_audio");
    const a = Math.abs(v);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs > 1.0) return fail("amplitude_out_of_range");
  if (samples.length < MIN_SAMPLES) return fail("shorter_than_one_detector_window");
  return { error: null, samples, nSamples: samples.length };
}

/**
 * `recorded_at` is caller-supplied ISO 8601 text (or null). A Date is converted with toISOString().
 * @param {Date|string|null|undefined} value
 * @returns {string|null}
 */
export function toIsoOrNull(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new ContractError("recorded_at is an invalid Date");
    return value.toISOString();
  }
  if (typeof value === "string") return value;
  throw new ContractError("recorded_at must be an ISO 8601 string, a Date or null");
}

/**
 * @param {string|undefined} inputDomain
 * @returns {string}
 */
export function checkInputDomain(inputDomain) {
  const domain = inputDomain ?? "unknown";
  if (!INPUT_DOMAINS.includes(domain)) {
    throw new ContractError(`input_domain must be one of ${INPUT_DOMAINS.join(", ")}, got ${domain}`);
  }
  return domain;
}

// ─── Output validation ───────────────────────────────────────────────────────

function ensure(condition, message) {
  if (!condition) throw new ContractError(message);
}

function sameKeys(object, keys) {
  const actual = Object.keys(object);
  return actual.length === keys.length && actual.every((k, i) => k === keys[i]);
}

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const isNullableString = (v) => v === null || typeof v === "string";

/**
 * Throw ContractError unless `value` is plain JSON data: null, booleans, finite numbers,
 * strings, plain arrays and plain objects. Rejects undefined, NaN/Infinity, typed arrays,
 * Dates and other class instances (prism_inference: json.dumps(output, allow_nan=False)).
 */
export function assertPlainJson(value, path = "output") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    ensure(Number.isFinite(value), `${path} is not a finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertPlainJson(item, `${path}[${i}]`));
    return;
  }
  ensure(
    typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype,
    `${path} is not plain JSON data (${value === undefined ? "undefined" : value?.constructor?.name ?? typeof value})`
  );
  for (const [k, v] of Object.entries(value)) assertPlainJson(v, `${path}.${k}`);
}

/**
 * Raise ContractError unless `output` satisfies the V2 output contract
 * (prism_inference.validate_output, plus the field types of inference_output.schema.json).
 * @param {Object} output
 */
export function validateOutput(output) {
  ensure(sameKeys(output, OUTPUT_KEYS), `output keys must be exactly ${OUTPUT_KEYS.join(", ")}`);
  ensure(output.contract_version === INFERENCE_CONTRACT_VERSION, "wrong contract_version");
  ensure(typeof output.baseline_id === "string", "baseline_id must be a string");
  ensure(/^[0-9a-f]{64}$/.test(output.detector_model_sha256), "detector_model_sha256 must be 64 hex digits");
  ensure(RECORDING_STATUSES.includes(output.recording_status), "unknown recording_status");

  const input = output.input;
  ensure(input !== null && typeof input === "object" && sameKeys(input, INPUT_KEYS),
    `input keys must be exactly ${INPUT_KEYS.join(", ")}`);
  ensure(Number.isInteger(input.sample_rate), "input.sample_rate must be an integer");
  ensure(Number.isInteger(input.n_samples) && input.n_samples >= 0, "input.n_samples must be an integer >= 0");
  ensure(input.duration_s === null || isFiniteNumber(input.duration_s), "input.duration_s must be a number or null");
  ensure(INPUT_DOMAINS.includes(input.input_domain), "unknown input_domain");
  ensure(isNullableString(input.recording_id), "input.recording_id must be a string or null");
  ensure(isNullableString(input.recorded_at), "input.recorded_at must be a string or null");
  ensure(output.baseline_domain_validated === (input.input_domain === "reference_dataset"),
    "baseline_domain_validated must be true only for the reference dataset");
  ensure(Array.isArray(output.feature_order) && output.feature_order.length === V2_FEATURE_ORDER.length
    && output.feature_order.every((f, i) => f === V2_FEATURE_ORDER[i]), "feature_order must equal the V2 order");

  const events = output.events;
  ensure(Array.isArray(events), "events must be an array");
  ensure(output.n_events === events.length, "n_events must equal the number of events");
  ensure(output.n_scored === events.filter((e) => e.status === EVENT_STATUS.SCORE_ONLY).length, "n_scored mismatch");
  const status = output.recording_status;
  if (status === RECORDING_STATUS.INPUT_ERROR) {
    ensure(INPUT_ERRORS.includes(output.error) && events.length === 0, "INPUT_ERROR needs a known error and no events");
  } else {
    ensure(output.error === null, "error must be null unless recording_status is INPUT_ERROR");
    ensure((status === RECORDING_STATUS.EVENTS_DETECTED) === (events.length > 0),
      "EVENTS_DETECTED needs >= 1 event; NO_INHALATION_DETECTED needs none");
  }

  let previousStart = -Infinity;
  events.forEach((event, position) => {
    ensure(event !== null && typeof event === "object" && sameKeys(event, EVENT_KEYS),
      `event keys must be exactly ${EVENT_KEYS.join(", ")}`);
    ensure(event.event_id === position, "event_id must be 0, 1, ... in chronological order");
    ensure(isFiniteNumber(event.start_time) && isFiniteNumber(event.end_time)
      && 0 <= event.start_time && event.start_time < event.end_time, "event times must satisfy 0 <= start < end");
    ensure(event.start_time >= previousStart, "events must be chronological");
    previousStart = event.start_time;
    ensure(isClose(event.duration_s, event.end_time - event.start_time, { absTol: 1e-9 }),
      "duration_s must equal end_time - start_time");
    for (const key of ["detector_confidence", "detector_max_confidence"]) {
      ensure(isFiniteNumber(event[key]) && event[key] >= 0 && event[key] <= 1, `${key} must lie in [0, 1]`);
    }
    ensure(Number.isInteger(event.window_count) && event.window_count >= 1, "window_count must be >= 1");
    ensure(EVENT_STATUSES.includes(event.status), "unknown event status");
    const reasons = event.not_scoreable_reasons;
    ensure(Array.isArray(reasons) && reasons.every((r) => REASONS.includes(r)) && new Set(reasons).size === reasons.length,
      "unknown or repeated not_scoreable_reasons");
    const values = event.feature_values;
    const z = event.feature_z_scores;
    const isV2Object = (o) => o !== null && typeof o === "object" && sameKeys(o, V2_FEATURE_ORDER)
      && Object.values(o).every(isFiniteNumber);
    if (values !== null) ensure(isV2Object(values), "feature_values must be finite and in V2 order");
    ensure(event.mean_rms === null || (isFiniteNumber(event.mean_rms) && event.mean_rms >= 0),
      "mean_rms must be null or finite and >= 0");
    if (event.status === EVENT_STATUS.SCORE_ONLY) {
      ensure(reasons.length === 0, "SCORE_ONLY events have no not_scoreable_reasons");
      ensure(values !== null && isV2Object(z), "SCORE_ONLY events need finite V2 values and z");
      const score = event.anomaly_score;
      ensure(isFiniteNumber(score) && score >= 0, "anomaly_score must be finite and >= 0");
      ensure(isClose(score, rmsZ(Object.values(z)), { relTol: 1e-12, absTol: 1e-15 }),
        "anomaly_score must equal sqrt(mean z^2)");
    } else {
      ensure(reasons.length > 0, "NOT_SCOREABLE events need at least one reason");
      ensure(event.anomaly_score === null && z === null, "NOT_SCOREABLE events carry no anomaly_score and no z-scores");
      ensure(values !== null || reasons.includes(NOT_SCOREABLE_REASONS.NONFINITE_FEATURE),
        "feature_values may be null only when a feature is non-finite");
    }
  });
  ensure(output.interpretation === SCORE_INTERPRETATION, "interpretation must be the contract text");
  assertPlainJson(output);
}
