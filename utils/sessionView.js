/**
 * utils/sessionView.js — what the UI may show about a session.
 *
 * Screens render only the view built here (research ARCHITECTURE.md §9.4; contract
 * prism-inference-v2.0 is DRAFT_NOT_FROZEN). It is a whitelist:
 *   - session and recording status (contract states, never a quality or clinical judgement);
 *   - counts of recordings and events;
 *   - event start/end times and durations;
 *   - not-scoreable reasons, phrased as measurement conditions;
 *   - input and processing errors;
 *   - whether the session is simulated or legacy, synced or waiting to sync.
 * Nothing else from the record is copied into the view, so per-event measurements and the
 * internal diagnostics cannot reach a screen. No threshold exists and none is applied here.
 */

import { isLegacyRecord } from "../services/sessionRecord.js";

/** Session states (pipeline/SessionAggregator SESSION_STATUS) as shown to the user. */
export const SESSION_STATUS_TEXT = Object.freeze({
  SCORE_ONLY: {
    label: "Events detected",
    description: "Inhalation events were detected in the recording.",
  },
  NOT_SCOREABLE: {
    label: "Events not scoreable",
    description: "Inhalation events were detected, but none met the measurement conditions for scoring. The reasons are listed with each event.",
  },
  NO_INHALATION_DETECTED: {
    label: "No inhalation detected",
    description: "The detector found no inhalation in the recording. This describes the recording only; it is not an error.",
  },
  INPUT_ERROR: {
    label: "Input error",
    description: "The audio did not meet the input requirements, so it was not analysed.",
  },
  PROCESSING_ERROR: {
    label: "Processing error",
    description: "The analysis could not run on this phone, so no result exists for this session.",
  },
});

export const LEGACY_STATUS = Object.freeze({
  key: "LEGACY",
  label: "Legacy record",
  description: "Stored by an earlier app version in an older format. It is kept but not interpreted.",
});

const UNKNOWN_STATUS = Object.freeze({ label: "Unknown status", description: "This session has no recognised status." });

/** Event states of the contract. */
export const EVENT_STATUS_TEXT = Object.freeze({
  SCORE_ONLY: "Scoreable",
  NOT_SCOREABLE: "Not scoreable",
});

/** Contract not_scoreable_reasons (scoreability rule v1) as measurement conditions. */
export const NOT_SCOREABLE_REASON_TEXT = Object.freeze({
  short_duration: "Segment shorter than 0.5 s, the minimum length for measurement",
  close_neighbor: "Another event less than 0.2 s away, so the segments cannot be measured separately",
  recording_boundary: "Segment touches the start or end of the recording and may be cut off",
  nonfinite_feature: "The segment's features could not be measured",
});

/** Contract INPUT_ERROR codes. */
export const INPUT_ERROR_TEXT = Object.freeze({
  unsupported_sample_rate: "The audio sample rate is not 8 kHz.",
  invalid_shape: "The audio is not a single (mono) channel.",
  empty_audio: "The audio contains no samples.",
  nonfinite_audio: "The audio contains invalid sample values.",
  amplitude_out_of_range: "The audio samples exceed full scale.",
  shorter_than_one_detector_window: "The audio is shorter than one detector window.",
  detector_feature_extraction_failed: "Audio features could not be computed.",
});

export const SOURCE_TEXT = Object.freeze({
  simulation: "Simulation (synthetic test audio)",
  wav: "WAV file",
  ble: "Inhaler device",
});

export const SYNC_TEXT = Object.freeze({
  synced: "Synced",
  pending: "Not synced yet",
});

const finiteOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const countOrNull = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const dateOrNull = (v) => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const textOrNull = (v) => (typeof v === "string" && v.length > 0 ? v : null);

function describeSync(sync) {
  const state = sync?.state === "synced" ? "synced" : "pending";
  return {
    state,
    label: SYNC_TEXT[state],
    detail: state === "pending" ? textOrNull(sync?.last_error) : null,
  };
}

/**
 * @param {Object} session - a history item (services/syncService.mergeSessionLists)
 * @returns {Object} the display view (plain values only)
 */
export function describeSession(session) {
  const legacy = session?.legacy === true || isLegacyRecord(session);
  const source = textOrNull(session?.source);
  const base = {
    id: session?.id ?? session?.session_id ?? null,
    legacy,
    simulated: !legacy && session?.simulated === true,
    source,
    sourceLabel: SOURCE_TEXT[source] ?? (source ? source : "Unknown source"),
    savedAt: dateOrNull(session?.timestamp),
    sync: describeSync(session?.sync),
  };

  if (legacy) {
    return {
      ...base,
      status: { key: LEGACY_STATUS.key, label: LEGACY_STATUS.label, description: LEGACY_STATUS.description },
      note: null,
      recordedAt: null,
      deviceId: null,
      counts: null,
      events: [],
      problems: [],
    };
  }

  const key = session.session_status;
  const text = SESSION_STATUS_TEXT[key] ?? UNKNOWN_STATUS;
  const nRecordings = countOrNull(session.n_recordings);

  const events = (Array.isArray(session.events) ? session.events : []).map((ev, i) => {
    const recordingIndex = countOrNull(ev?.recording_index);
    return {
      key: `${recordingIndex ?? 0}-${countOrNull(ev?.event_id) ?? i}-${i}`,
      number: i + 1,
      recordingNumber: nRecordings > 1 && recordingIndex !== null ? recordingIndex + 1 : null,
      startTime: finiteOrNull(ev?.start_time),
      endTime: finiteOrNull(ev?.end_time),
      durationS: finiteOrNull(ev?.duration_s),
      scoreable: ev?.status === "SCORE_ONLY",
      statusLabel: EVENT_STATUS_TEXT[ev?.status] ?? "Unknown",
      reasons: (Array.isArray(ev?.not_scoreable_reasons) ? ev.not_scoreable_reasons : [])
        .map((r) => NOT_SCOREABLE_REASON_TEXT[r] ?? String(r)),
    };
  });

  const problems = [
    ...(Array.isArray(session.input_errors) ? session.input_errors : []).map((e) => ({
      kind: "input",
      text: INPUT_ERROR_TEXT[e?.error] ?? `Input error: ${e?.error ?? "unknown"}`,
    })),
    ...(Array.isArray(session.processing_errors) ? session.processing_errors : []).map((e) => ({
      kind: "processing",
      text: `The analysis could not run: ${textOrNull(e?.message) ?? "unknown error"}`,
    })),
  ];

  return {
    ...base,
    status: { key: SESSION_STATUS_TEXT[key] ? key : "UNKNOWN", label: text.label, description: text.description },
    note: textOrNull(session.note),
    recordedAt: dateOrNull(session.recorded_at),
    deviceId: textOrNull(session.device_id),
    counts: {
      recordings: nRecordings,
      events: countOrNull(session.n_events),
      notScoreable: countOrNull(session.n_not_scoreable),
    },
    events,
    problems,
  };
}

/**
 * One line about cloud sync for the Dashboard.
 * @param {Object} status - syncService.getStatus()
 * @param {number} pendingCount - sessions on this phone not yet synced
 * @returns {string}
 */
export function describeSyncStatus(status, pendingCount) {
  if (status?.running) return "Syncing…";
  const waiting = pendingCount === 1 ? "1 session is waiting to sync" : `${pendingCount} sessions are waiting to sync`;
  if (!pendingCount) return "All sessions on this phone are synced.";
  switch (status?.lastOutcome) {
    case "not_signed_in":
      return `${waiting}. Cloud sync is unavailable (offline, or Firebase not configured); sessions stay on this phone.`;
    case "no_confirmation":
      return `${waiting}. The server did not confirm the upload (offline?); it will be retried.`;
    case "partial":
    case "error":
      return `${waiting}. Last sync error: ${status.lastError ?? "unknown"}`;
    default:
      return `${waiting}.`;
  }
}
