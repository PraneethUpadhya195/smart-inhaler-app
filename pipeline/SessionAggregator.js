/**
 * Stage 13: Session adapter.
 *
 * Groups one or more canonical recording outputs (InferencePipeline.run(), i.e.
 * inference_output.schema.json) into an app session. This is the boundary between the
 * research contract and the app: the outputs are kept verbatim under `recordings`, and the
 * session adds only counts, chronological event references and one summary state.
 *
 * Everything returned is plain JSON (safe for Firestore). Nothing here is a contract output:
 * `session_status` is an app-level summary of contract states, not a quality, technique or
 * clinical judgement, and `diagnostics` is internal (not for display; no threshold exists).
 */

/** App-level session states. Each maps to one contract state; they are never merged. */
export const SESSION_STATUS = Object.freeze({
  /** at least one event was scored (event status SCORE_ONLY) */
  SCORE_ONLY: "SCORE_ONLY",
  /** inhalation events were detected, but none was scoreable (all NOT_SCOREABLE) */
  NOT_SCOREABLE: "NOT_SCOREABLE",
  /** recording state NO_INHALATION_DETECTED: the detector found no inhalation (not an error) */
  NO_INHALATION_DETECTED: "NO_INHALATION_DETECTED",
  /** recording state INPUT_ERROR: the audio violated the contract (see input_errors) */
  INPUT_ERROR: "INPUT_ERROR",
  /** the pipeline could not run at all (model, runtime or decoding failure); no contract output */
  PROCESSING_ERROR: "PROCESSING_ERROR",
});

const toMs = (iso) => {
  if (iso == null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

export default class SessionAggregator {
  /**
   * @param {string} sessionId
   * @param {Object[]} recordingResults - canonical outputs from InferencePipeline.run()
   * @param {Object} [options]
   * @param {{ recording_id: string|null, message: string }[]} [options.processingErrors] -
   *   recordings for which run() threw (no canonical output exists for them)
   * @returns {Object} session (plain JSON)
   */
  aggregate(sessionId, recordingResults, { processingErrors = [] } = {}) {
    const recordingStatuses = { EVENTS_DETECTED: 0, NO_INHALATION_DETECTED: 0, INPUT_ERROR: 0 };
    const inputErrors = [];
    const events = [];
    const scores = [];
    let nEvents = 0;
    let nScored = 0;

    recordingResults.forEach((rec, recordingIndex) => {
      if (!rec || typeof rec.recording_status !== "string" || !rec.input) {
        throw new TypeError("SessionAggregator expects canonical outputs of InferencePipeline.run()");
      }
      recordingStatuses[rec.recording_status] += 1;
      if (rec.recording_status === "INPUT_ERROR") {
        inputErrors.push({ recording_id: rec.input.recording_id, error: rec.error });
      }
      nEvents += rec.n_events;
      nScored += rec.n_scored;
      for (const ev of rec.events) {
        events.push({
          recording_index: recordingIndex,
          recording_id: rec.input.recording_id,
          recorded_at: rec.input.recorded_at,
          event_id: ev.event_id,
          start_time: ev.start_time,
          end_time: ev.end_time,
          duration_s: ev.duration_s,
          status: ev.status,
          not_scoreable_reasons: [...ev.not_scoreable_reasons],
        });
        if (ev.status === "SCORE_ONLY") scores.push(ev.anomaly_score);
      }
    });

    // Chronological order: absolute time = recorded_at + start_time (contract event_timestamp).
    // Recordings without recorded_at keep their order, after the timed ones.
    const absolute = (e) => {
      const base = toMs(e.recorded_at);
      return base === null ? Infinity : base + e.start_time * 1000;
    };
    events.sort((a, b) => (absolute(a) - absolute(b)) || (a.recording_index - b.recording_index)
      || (a.start_time - b.start_time));

    const times = recordingResults.map((r) => toMs(r.input.recorded_at)).filter((t) => t !== null);
    const recordedAt = times.length > 0 ? new Date(Math.min(...times)).toISOString() : null;

    let status;
    if (processingErrors.length > 0) status = SESSION_STATUS.PROCESSING_ERROR;
    else if (recordingStatuses.INPUT_ERROR > 0) status = SESSION_STATUS.INPUT_ERROR;
    else if (nScored > 0) status = SESSION_STATUS.SCORE_ONLY;
    else if (nEvents > 0) status = SESSION_STATUS.NOT_SCOREABLE;
    else if (recordingResults.length > 0) status = SESSION_STATUS.NO_INHALATION_DETECTED;
    else throw new Error("a session needs at least one recording result or processing error");

    return {
      session_id: sessionId,
      session_status: status,
      recorded_at: recordedAt,
      n_recordings: recordingResults.length,
      recording_statuses: recordingStatuses,
      n_events: nEvents,
      n_scored: nScored,
      n_not_scoreable: nEvents - nScored,
      input_errors: inputErrors,
      processing_errors: processingErrors.map((e) => ({ recording_id: e.recording_id ?? null, message: String(e.message) })),
      events,
      // Internal/diagnostic only while the contract is DRAFT_NOT_FROZEN: not displayed, no threshold.
      diagnostics: {
        anomaly_score_summary: scores.length > 0
          ? { n: scores.length, min: Math.min(...scores), max: Math.max(...scores),
              mean: scores.reduce((a, b) => a + b, 0) / scores.length }
          : null,
      },
      recordings: recordingResults,
    };
  }
}
