/**
 * pipeline/types.js
 *
 * JSDoc type definitions for the entire PRISM inference pipeline.
 * These types define the data contract between every pipeline stage.
 *
 * Source of truth: assets/ml/v2_validation/inference_contract_v2.json
 *
 * No implementation logic lives here — only type documentation.
 */

// ─── Audio / PCM ─────────────────────────────────────────────────────────────

/**
 * Raw PCM audio data from any source (simulation, WAV, BLE).
 * Also carries `inputDomain`: 'reference_dataset' | 'prism_hardware' | 'unknown' (default 'unknown').
 *
 * @typedef {Object} PcmData
 * @property {Float32Array} samples - PCM samples normalized to [-1, 1]
 * @property {number} sampleRate - Sample rate in Hz (contract requires 8000)
 * @property {number} channels - Number of channels (contract requires 1 = mono)
 * @property {string} sourceType - Origin: 'simulation' | 'wav' | 'ble'
 * @property {string|null} sourceId - Identifier (filename, device ID, etc.)
 * @property {Date|null} recordedAt - When the audio was recorded (for absolute event timestamps)
 */

// ─── Frame-Level Features ────────────────────────────────────────────────────

/**
 * A single 124-dimensional feature vector extracted from one audio frame.
 *
 * Feature layout (from inference_contract_v2.json):
 *   [0..39]   MFCC (40)
 *   [40..79]  Delta MFCC (40)
 *   [80..119] Delta² MFCC (40)
 *   [120]     Spectral centroid / 4000 Hz
 *   [121]     Spectral flatness
 *   [122]     Spectral rolloff (85%) / 4000 Hz
 *   [123]     Zero crossing rate
 *
 * @typedef {Object} FrameFeatures
 * @property {Float32Array} features - 124-dimensional float32 vector
 * @property {number} frameIndex - 0-based index of this frame
 * @property {number} timestamp - Frame center time in seconds
 */

// ─── CNN Sliding Window ──────────────────────────────────────────────────────

/**
 * A single CNN input window: 25 consecutive frames stacked.
 * Ready to be fed to the ONNX model as [1, 25, 124].
 *
 * @typedef {Object} CnnWindow
 * @property {Float32Array} tensor - Flattened [25 × 124] = 3100 float32 values
 * @property {number} windowIndex - 0-based index of this window
 * @property {number} startTime - Start time in seconds
 * @property {number} endTime - End time in seconds (start + 0.2s, clamped to recording duration)
 */

// ─── CNN Prediction ──────────────────────────────────────────────────────────

/**
 * Per-window CNN prediction result.
 *
 * Class order (from contract):
 *   0 = Drug, 1 = Exhale, 2 = Inhale, 3 = Noise
 *
 * @typedef {Object} WindowPrediction
 * @property {number} windowIndex - Matches CnnWindow.windowIndex
 * @property {Float32Array} logits - Raw model output [4]
 * @property {Float32Array} probabilities - Softmax of logits [4]
 * @property {number} predictedClass - argmax index (0-3)
 * @property {string} predictedLabel - 'Drug' | 'Exhale' | 'Inhale' | 'Noise'
 * @property {number} startTime - Window start time in seconds
 * @property {number} endTime - Window end time in seconds
 */

// ─── Decoded Inhalation Event ────────────────────────────────────────────────

/**
 * An inhalation event decoded from consecutive/overlapping Inhale windows.
 * Produced by temporal event grouping (post_event logic).
 *
 * Internal stage object; run() maps it to the canonical event (start_time, end_time, ...).
 *
 * @typedef {Object} DecodedEvent
 * @property {number} eventId - 0-based chronological index within the recording
 * @property {number} startS - Event start in seconds (first window start)
 * @property {number} endS - Event end in seconds (max window end)
 * @property {number} durationS - endS - startS
 * @property {number} detectorConfidence - Mean P(Inhale) over the event's Inhale windows
 * @property {number} detectorMaxConfidence - Max P(Inhale) over the event's Inhale windows
 * @property {number} windowCount - Number of Inhale windows in this event
 * @property {number[]} windowIndices - Indices of contributing windows
 * @property {WindowPrediction[]} windowPredictions - The grouped Inhale windows
 */

// ─── Event Scoreability ──────────────────────────────────────────────────────

/**
 * Whether an event passes the Stage 1 usability rule for scoring.
 *
 * Scoreability reasons (from contract):
 *   'short_duration'     — duration < 0.5 s
 *   'close_neighbor'     — another event within 0.2 s gap
 *   'recording_boundary' — start <= 0.008 s or end >= duration - 0.008 s
 *   'nonfinite_feature'  — any V2 feature or mean_rms is non-finite
 *
 * @typedef {Object} EventScoreability
 * @property {boolean} isScoreable - true if the event can be scored
 * @property {string[]} reasons - Contract reasons in contract order; empty if scoreable
 */

// ─── Event-Level Features (V2) ───────────────────────────────────────────────

/**
 * The 4 V2 anomaly features + level channel, extracted from a whole event's PCM.
 *
 * Feature order (from v2_feature_schema.json):
 *   0: spectral_centroid_mean
 *   1: spectral_flatness_mean
 *   2: spectral_centroid_std
 *   3: spectral_rolloff_std
 *
 * Internal stage object (FeatureExtractor.extractFeatures).
 *
 * @typedef {Object} EventFeatures
 * @property {string} version - e.g. 'prism-inference-v2.0'
 * @property {Float64Array} features - The 4 V2 features, in V2 order
 * @property {number} mean_rms - Level channel (RMS amplitude, not in anomaly score)
 */

// ─── Anomaly Scoring ─────────────────────────────────────────────────────────

/**
 * Per-feature z-scores against the baseline.
 * z_j = (x_j - center_j) / scale_j
 *
 * @typedef {Object} FeatureZScores
 * @property {number} spectral_centroid_mean
 * @property {number} spectral_flatness_mean
 * @property {number} spectral_centroid_std
 * @property {number} spectral_rolloff_std
 */

// ─── Canonical output (inference_output.schema.json) ────────────────────────

/**
 * The only result schema: InferencePipeline.run() returns this object, validated by
 * contract.validateOutput. Keys and key order are those of prism_inference.OUTPUT_KEYS.
 * Plain JSON only (no typed arrays, no undefined, no NaN).
 *
 * @typedef {Object} RecordingOutput
 * @property {'prism-inference-v2.0'} contract_version
 * @property {string} baseline_id
 * @property {string} detector_model_sha256 - verified SHA-256 of the loaded model bytes
 * @property {'EVENTS_DETECTED'|'NO_INHALATION_DETECTED'|'INPUT_ERROR'} recording_status
 * @property {string|null} error - an INPUT_ERROR code (versions.INPUT_ERRORS), else null
 * @property {RecordingInputMeta} input
 * @property {boolean} baseline_domain_validated - true only for input_domain 'reference_dataset'
 * @property {string[]} feature_order - the V2 order
 * @property {number} n_events
 * @property {number} n_scored
 * @property {EventOutput[]} events - chronological
 * @property {string} interpretation - the contract's SCORE_ONLY text
 */

/**
 * @typedef {Object} RecordingInputMeta
 * @property {number} sample_rate
 * @property {number} n_samples
 * @property {number|null} duration_s
 * @property {'reference_dataset'|'prism_hardware'|'unknown'} input_domain
 * @property {string|null} recording_id
 * @property {string|null} recorded_at - caller-supplied ISO 8601 start time
 */

/**
 * @typedef {Object} EventOutput
 * @property {number} event_id
 * @property {number} start_time - seconds from recording start
 * @property {number} end_time
 * @property {number} duration_s
 * @property {number} detector_confidence - mean P(Inhale) over the event's Inhale windows
 * @property {number} detector_max_confidence
 * @property {number} window_count
 * @property {'SCORE_ONLY'|'NOT_SCOREABLE'} status
 * @property {string[]} not_scoreable_reasons
 * @property {number|null} anomaly_score - SCORE_ONLY only; a distance, no threshold
 * @property {FeatureZScores|null} feature_values - finite V2 values, also for NOT_SCOREABLE events
 * @property {FeatureZScores|null} feature_z_scores - SCORE_ONLY only
 * @property {number|null} mean_rms - diagnostic level channel
 */

// ─── Version Metadata ────────────────────────────────────────────────────────

/**
 * Version identifiers for tracing every result back to the exact
 * model, features, baseline, and scoring used to produce it.
 *
 * @typedef {Object} VersionMetadata
 * @property {string} modelVersion - ONNX model identifier
 * @property {string} inferenceContractVersion - e.g. 'prism-inference-v2.0'
 * @property {string} featureSchemaVersion - Event feature schema version
 * @property {string} baselineVersion - Baseline identifier
 * @property {string} scoringVersion - Scoring algorithm version
 * @property {string} appVersion - Mobile app version
 */

// ─── Technical Errors ────────────────────────────────────────────────────────

/**
 * Technical error (distinct from analytical statuses like NO_INHALATION_DETECTED).
 *
 * @typedef {Object} PipelineError
 * @property {string} code - 'MODEL_LOAD_FAILED' | 'ONNX_RUNTIME_ERROR' | 'DSP_ERROR' | 'BLE_DISCONNECTED' | 'MALFORMED_PCM' | 'PERSISTENCE_ERROR'
 * @property {string} message - Human-readable description
 * @property {string|null} stage - Which pipeline stage failed
 * @property {Error|null} cause - Original error, if any
 */

// ─── Pipeline Configuration ─────────────────────────────────────────────────

/**
 * Static pipeline configuration loaded from ML artifacts.
 *
 * @typedef {Object} PipelineConfig
 * @property {number} sampleRate - 8000
 * @property {number} nFft - 256
 * @property {number} hopLength - 64
 * @property {number} nMels - 128
 * @property {number} fmin - 50
 * @property {number} fmax - 4000
 * @property {number} nMfcc - 40
 * @property {number} deltaWidth - 9
 * @property {number} rolloffPercent - 0.85
 * @property {number} windowSize - 25 frames
 * @property {number} windowStride - 2 frames
 * @property {number} featureDim - 124
 * @property {number} nClasses - 4
 * @property {string[]} classLabels - ['Drug', 'Exhale', 'Inhale', 'Noise']
 */

export {};  // Make this a module
