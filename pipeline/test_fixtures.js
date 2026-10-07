/**
 * pipeline/test_fixtures.js — canonical outputs (inference_output.schema.json) for tests of
 * code that consumes InferencePipeline.run() results. Every fixture passes validateOutput.
 */
import { validateOutput } from "./contract.js";
import { BASELINE_ID, INFERENCE_CONTRACT_VERSION, MODEL_SHA256, SCORE_INTERPRETATION, V2_FEATURE_ORDER } from "./versions.js";

const named = (v) => Object.fromEntries(V2_FEATURE_ORDER.map((f) => [f, v]));

/**
 * @param {Object} e - { start, end?, score? (SCORE_ONLY when given), reasons? }
 * @param {number} id
 */
export function canonicalEvent(e, id) {
  const end = e.end ?? e.start + 1.0;
  const scored = e.score != null;
  return {
    event_id: id, start_time: e.start, end_time: end, duration_s: end - e.start,
    detector_confidence: 0.9, detector_max_confidence: 0.99, window_count: 10,
    status: scored ? "SCORE_ONLY" : "NOT_SCOREABLE",
    not_scoreable_reasons: scored ? [] : (e.reasons ?? ["short_duration"]),
    anomaly_score: scored ? e.score : null,
    feature_values: named(0.1),
    feature_z_scores: scored ? named(e.score) : null, // rms of four equal z = score
    mean_rms: 0.1,
  };
}

/**
 * @param {string|null} recordingId
 * @param {string|null} recordedAt
 * @param {Object[]} events - see canonicalEvent
 * @param {string|null} [error] - INPUT_ERROR code
 */
export function canonicalOutput(recordingId, recordedAt, events, error = null) {
  const evs = events.map(canonicalEvent);
  const output = {
    contract_version: INFERENCE_CONTRACT_VERSION, baseline_id: BASELINE_ID, detector_model_sha256: MODEL_SHA256,
    recording_status: error ? "INPUT_ERROR" : evs.length ? "EVENTS_DETECTED" : "NO_INHALATION_DETECTED",
    error,
    input: { sample_rate: 8000, n_samples: 96000, duration_s: 12, input_domain: "unknown",
             recording_id: recordingId, recorded_at: recordedAt },
    baseline_domain_validated: false, feature_order: [...V2_FEATURE_ORDER],
    n_events: evs.length, n_scored: evs.filter((e) => e.status === "SCORE_ONLY").length, events: evs,
    interpretation: SCORE_INTERPRETATION,
  };
  validateOutput(output);
  return output;
}
