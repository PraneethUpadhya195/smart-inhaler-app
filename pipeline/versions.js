/**
 * pipeline/versions.js
 *
 * Version constants and pipeline configuration loaded from the ML handoff artifacts.
 * These values are the single source of truth for all pipeline stages.
 *
 * Source: assets/ml/v2_validation/inference_contract_v2.json
 *         assets/ml/v2_validation/v2_baseline.json
 *         assets/ml/v2_validation/v2_feature_schema.json
 */

// ─── Contract Versions ───────────────────────────────────────────────────────

export const INFERENCE_CONTRACT_VERSION = "prism-inference-v2.0";
export const BASELINE_ID = "prism-v2-global-2026-09-30";
export const MODEL_SHA256 = "2e4e72d3ca040b15718ad6b09ae4ac3069c38f5c1a389327bf6b38c4e2903725";

// ─── Version Metadata (for tracing) ──────────────────────────────────────────

/** @type {import('./types').VersionMetadata} */
export const CURRENT_VERSIONS = {
  modelVersion: "inhaler_cnn_v1",
  inferenceContractVersion: INFERENCE_CONTRACT_VERSION,
  featureSchemaVersion: INFERENCE_CONTRACT_VERSION,
  baselineVersion: BASELINE_ID,
  scoringVersion: "rms_z_v1",
  appVersion: "1.0.0",
};

// ─── DSP Configuration ──────────────────────────────────────────────────────

/** @type {import('./types').PipelineConfig} */
export const PIPELINE_CONFIG = Object.freeze({
  // Audio
  sampleRate: 8000,

  // STFT
  nFft: 256,
  hopLength: 64,

  // Mel filterbank
  nMels: 128,
  fmin: 50,
  fmax: 4000,

  // MFCC
  nMfcc: 40,

  // Deltas
  deltaWidth: 9,

  // Spectral
  rolloffPercent: 0.85,

  // CNN windowing
  windowSize: 25,    // frames per window
  windowStride: 2,   // frames between window starts

  // Feature dimensions
  featureDim: 124,   // per-frame feature vector length
  nClasses: 4,       // Drug, Exhale, Inhale, Noise

  // Class labels (indexed by CNN output position)
  classLabels: Object.freeze(["Drug", "Exhale", "Inhale", "Noise"]),

  // Minimum input length (samples)
  minimumLengthSamples: 1536,
});

// ─── Event Grouping Configuration ────────────────────────────────────────────

export const EVENT_GROUPING_CONFIG = Object.freeze({
  targetLabel: "Inhale",
  smoothingWindow: 1,       // no smoothing
  maxGapS: 0.0,
  minEventDurationS: 0.0,
  minConfidence: null,
});

// ─── Scoreability Rules ─────────────────────────────────────────────────────

export const SCOREABILITY_CONFIG = Object.freeze({
  minDurationS: 0.5,
  minGapS: 0.2,
  boundaryMarginS: 0.008,
});

// ─── V2 Anomaly Feature Order ────────────────────────────────────────────────

export const V2_FEATURE_ORDER = Object.freeze([
  "spectral_centroid_mean",
  "spectral_flatness_mean",
  "spectral_centroid_std",
  "spectral_rolloff_std",
]);

// ─── Recording & Event Status Enums ──────────────────────────────────────────

export const RECORDING_STATUS = Object.freeze({
  EVENTS_DETECTED: "EVENTS_DETECTED",
  NO_INHALATION_DETECTED: "NO_INHALATION_DETECTED",
  INPUT_ERROR: "INPUT_ERROR",
});

export const EVENT_STATUS = Object.freeze({
  SCORE_ONLY: "SCORE_ONLY",
  NOT_SCOREABLE: "NOT_SCOREABLE",
});

export const NOT_SCOREABLE_REASONS = Object.freeze({
  NONFINITE_FEATURE: "nonfinite_feature",
  SHORT_DURATION: "short_duration",
  CLOSE_NEIGHBOR: "close_neighbor",
  RECORDING_BOUNDARY: "recording_boundary",
});

// ─── Technical Error Codes ───────────────────────────────────────────────────

export const ERROR_CODES = Object.freeze({
  MODEL_LOAD_FAILED: "MODEL_LOAD_FAILED",
  ONNX_RUNTIME_ERROR: "ONNX_RUNTIME_ERROR",
  DSP_ERROR: "DSP_ERROR",
  BLE_DISCONNECTED: "BLE_DISCONNECTED",
  MALFORMED_PCM: "MALFORMED_PCM",
  PERSISTENCE_ERROR: "PERSISTENCE_ERROR",
  UNSUPPORTED_SAMPLE_RATE: "unsupported_sample_rate",
  SHORTER_THAN_ONE_WINDOW: "shorter_than_one_detector_window",
});

// ─── Contract input/output vocabulary (prism_inference.py) ──────────────────

/** INPUT_ERROR codes, in the order prism_inference.check_input tests them. */
export const INPUT_ERRORS = Object.freeze([
  "unsupported_sample_rate",
  "invalid_shape",
  "empty_audio",
  "nonfinite_audio",
  "amplitude_out_of_range",
  "shorter_than_one_detector_window",
  "detector_feature_extraction_failed",
]);

/** baseline_domain_validated is true only for "reference_dataset". Device audio is "prism_hardware". */
export const INPUT_DOMAINS = Object.freeze(["reference_dataset", "prism_hardware", "unknown"]);

/** Minimum input length: one full detector window, (25 - 1) * 64 samples. */
export const MIN_SAMPLES = (PIPELINE_CONFIG.windowSize - 1) * PIPELINE_CONFIG.hopLength;

/** Baseline scale = MAD_SCALE * MAD (contract baseline.loading). */
export const MAD_SCALE = 1.4826;

/** Rule-check times are rounded to 6 decimals, as in prism_inference (TIME_DECIMALS). */
export const TIME_DECIMALS = 6;

/** Exact key order of the canonical output (prism_inference.OUTPUT_KEYS / INPUT_KEYS / EVENT_KEYS). */
export const OUTPUT_KEYS = Object.freeze([
  "contract_version", "baseline_id", "detector_model_sha256", "recording_status", "error", "input",
  "baseline_domain_validated", "feature_order", "n_events", "n_scored", "events", "interpretation",
]);
export const INPUT_KEYS = Object.freeze([
  "sample_rate", "n_samples", "duration_s", "input_domain", "recording_id", "recorded_at",
]);
export const EVENT_KEYS = Object.freeze([
  "event_id", "start_time", "end_time", "duration_s", "detector_confidence", "detector_max_confidence",
  "window_count", "status", "not_scoreable_reasons", "anomaly_score", "feature_values",
  "feature_z_scores", "mean_rms",
]);

// ─── Interpretation Text ─────────────────────────────────────────────────────

export const SCORE_INTERPRETATION =
  "SCORE_ONLY: anomaly_score is the root-mean-square of robust z-scores of " +
  "four spectral features relative to a frozen global baseline fitted on the " +
  "reference dataset. It is a distance, not a probability, quality rating, " +
  "NORMAL/ANOMALY decision or clinical assessment. No threshold is defined.";
