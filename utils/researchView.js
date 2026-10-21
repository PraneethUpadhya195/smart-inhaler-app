/**
 * utils/researchView.js — the research measurements of a session, for the separate, collapsed
 * "Research measurements" section of the session screen. Pure: tested in utils/test_recording_view.js.
 *
 * Shown on explicit request of the project owner, under the research display rules
 * (research ARCHITECTURE.md §9.4):
 *   - the acoustic deviation of each scoreable event (Stage 9 aggregate deviation, = V2 anomaly_score):
 *     a distance from a reference corpus, not a health or technique signal; no threshold of our own;
 *   - the Stage 9 statement, phrased only as "acoustically within / outside the range of the
 *     reference recordings", with its stability label;
 *   - on PRISM hardware (baseline_domain_validated false) the caveat that the reference was not
 *     recorded with this microphone, shown before any number;
 *   - the personal baseline (V3) only as its availability and the reasons it is unavailable.
 * The session list, the status badge and the event list (utils/sessionView.js) never show these.
 */

import { loadAssessmentReference } from "../pipeline/ReferenceAssessment.js";
import { demoBaselineInput } from "../services/demoBaseline.js";
import { ANALYSIS_RECORDINGS, SELECTION } from "../services/analysisRecordings.js";
import { formatTimestamp } from "./formatters.js";

export const RANGE_TEXT = Object.freeze({
  WITHIN_REFERENCE_RANGE: "Acoustically within the range of the reference recordings",
  OUTSIDE_REFERENCE_RANGE: "Acoustically outside the range of the reference recordings",
  CONTINUOUS_ONLY: "No within/outside statement (deviation only)",
  NOT_ASSESSED: "Not measured (the event is not scoreable)",
});

export const RELIABILITY_TEXT = Object.freeze({
  STABLE: "stable: unchanged when the reference sample or the event boundaries vary slightly",
  BORDERLINE: "borderline: changes when the reference sample or the event boundaries vary slightly",
});

export const FEATURE_TEXT = Object.freeze({
  spectral_centroid_mean: "spectral centre (average)",
  spectral_flatness_mean: "spectral flatness (average)",
  spectral_centroid_std: "spectral centre (variation)",
  spectral_rolloff_std: "spectral roll-off (variation)",
});

export const PERSONAL_BLOCKER_TEXT = Object.freeze({
  NOT_VALIDATED: "The personal-baseline method has only been tested on constructed data, not validated on people.",
  SITTING_DEFINITION_INCOMPATIBLE: "It needs sittings of at least 10 measurable inhalations within 25 minutes; normal inhaler use gives one or two.",
  HARDWARE_REFERENCE_MISSING: "Its reference was not recorded with the PRISM device's microphone.",
  WARMUP: "Not enough qualifying sittings yet.",
  NO_DEVICE: "The recording has no device identifier.",
  UPDATE_RULE_NOT_PORTED: "The baseline update of the research method is not part of this app.",
});

export const INTERPRETATION =
  "These numbers compare the sound of each measured inhalation with recordings from a research reference dataset. " +
  "Larger deviation means the sound differs more from those recordings. They do not say whether an inhalation was done " +
  "well and are not a medical result.";

export const HARDWARE_CAVEAT =
  "Recorded with the PRISM device. The reference recordings were made with a different microphone and the comparison " +
  "has not been validated for this device, so differences can come from the microphone itself.";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * @param {Object} session - history item
 * @returns {{ available: boolean, hardware: boolean, caveat: string|null, interpretation: string,
 *   events: Object[], personal: { available: boolean, status: string, reasons: string[], detail: string|null }|null }}
 */
export function describeResearch(session) {
  const assessment = Array.isArray(session?.assessments) ? session.assessments[0] : null;
  // A Start Event session's analysis input is a reference recording, not the device's audio.
  const referenceInput = session?.analysis_source?.type === "reference_recording";
  const hardware = !referenceInput && (session?.source === "ble" || assessment?.input?.input_domain === "prism_hardware");
  const events = (assessment?.events ?? []).map((ev, i) => {
    const deviation = num(ev.aggregate_deviation);
    const p = num(ev.reference_tail_probability);
    return {
      key: `${ev.event_id ?? i}`,
      number: i + 1,
      measured: ev.scoreability === "SCOREABLE" && deviation !== null,
      deviation: deviation === null ? null : deviation.toFixed(2),
      rangeText: RANGE_TEXT[ev.assessment] ?? "Unknown",
      reliabilityText: RELIABILITY_TEXT[ev.assessment_reliability] ?? null,
      // p = (1 + #{reference deviations >= this one}) / (n + 1)
      tailText: p === null ? null : `${Math.round(p * (assessment.reference.n_reference_events + 1)) - 1} of ${assessment.reference.n_reference_events} reference inhalations deviate at least as much (empirical tail probability ${p.toFixed(3)})`,
      largestContribution: FEATURE_TEXT[ev.dominant_feature] ?? null,
    };
  });
  const personal = session?.personal;
  return {
    available: assessment !== null && assessment !== undefined,
    hardware,
    caveat: hardware ? HARDWARE_CAVEAT : null,
    interpretation: INTERPRETATION,
    referenceLimit: num(assessment?.reference?.cut)?.toFixed(2) ?? null,
    events,
    personal: personal ? {
      available: personal.available === true,
      status: personal.available === true ? "Available" : "Not available",
      reasons: (personal.blockers ?? []).map((b) => PERSONAL_BLOCKER_TEXT[b] ?? String(b)),
      detail: Number.isInteger(personal.n_sittings)
        ? `${personal.n_qualifying_sittings} of ${personal.s_min} qualifying sittings (${personal.n_sittings} sitting(s) recorded with this device)`
        : null,
    } : null,
  };
}

// ─── Personal Baseline (services/demoBaseline.js) ────────────────────────────
// Shown to users as "Personal Baseline". Internally it is still the demo baseline (module, storage key and
// data model unchanged): derived from reference recordings, not from the user's own inhalations, and kept
// apart from the per-user baseline (V3, pipeline/PersonalReferenceStatus.js).

export const DEMO_BASELINE_EXPLANATION =
  "Preliminary baseline derived from reference inhalation recordings. It demonstrates baseline initialization and " +
  "adaptation and is not yet personalized to an individual's inhalation patterns.";

/** The reference dataset names each recording by its recording time, recYYYY-MM-DD_HHhMMmSS.sss.wav (no time zone). */
const DATASET_RECORDING_TIME = /^rec(\d{4})-(\d{2})-(\d{2})_(\d{2})h(\d{2})m(\d{2})\.(\d{3})s\.wav$/;

/**
 * When a reference recording was originally recorded, from its dataset recording id: the dataset's only
 * time metadata (research PRISM_RESEARCH_LOG.md, metadata audit: the WAVs carry no metadata, file names
 * are timestamps). The dataset gives no time zone, so the time is kept as written, not converted.
 * @param {string} recordingId - e.g. "rec2018-01-23_11h00m14.641s.wav"
 * @returns {Date|null} null when the id does not follow the pattern or is not a valid time
 */
export function referenceRecordedAt(recordingId) {
  const m = DATASET_RECORDING_TIME.exec(typeof recordingId === "string" ? recordingId : "");
  if (!m) return null;
  const [y, mo, d, h, mi, s, ms] = m.slice(1).map(Number);
  const t = new Date(y, mo - 1, d, h, mi, s, ms);
  const valid = t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d
    && t.getHours() === h && t.getMinutes() === mi && t.getSeconds() === s;
  return valid ? t : null;
}

/**
 * The user-facing name of a bundled reference recording (services/analysisRecordings.js) in place of its
 * internal id: its kind and its original recording time, e.g. "Inhalation reference — Jan 23, 2018, 11:00 AM".
 * Without a usable recording time, a generic name; never a session's time. Presentational only: the id
 * stays the key everywhere.
 * @param {string|null} referenceId - e.g. "ref-inhalation-06"
 * @param {Object[]} [registry] - ANALYSIS_RECORDINGS (tests)
 */
export function referenceRecordingLabel(referenceId, registry = ANALYSIS_RECORDINGS) {
  if (referenceId == null) return "—";
  const r = registry.find((x) => x.id === referenceId);
  const kind = r?.selection === SELECTION.INHALATION ? "Inhalation reference"
    : r?.selection === SELECTION.NO_INHALATION ? "No-inhalation reference" : "Reference";
  const at = r ? referenceRecordedAt(r.recordingId) : null;
  return at ? `${kind} — ${formatTimestamp(at)}` : `${kind} recording`;
}

/**
 * The Personal Baseline summary of the Dashboard: the stored state as it is, never recalculated, and
 * read-only (the baseline changes only when a session is stored, context/AppContext.js `save`).
 * Counts, distance and time are given only once the baseline is initialized.
 * @param {{ state: Object|null, error: string|null }} demo - AppContext.demoBaseline
 * @returns {Object|null} null until the baseline has been loaded
 */
export function describeBaselineSummary(demo) {
  const state = demo?.state;
  if (!state) return null;
  const initialized = state.initialized === true;
  return {
    explanation: DEMO_BASELINE_EXPLANATION,
    error: demo.error ?? null,
    initialized,
    stateLabel: initialized ? "Initialized" : "Not initialized",
    sessionsProcessed: initialized ? state.sessions_processed : null,
    uniqueReferences: initialized ? state.unique_reference_ids.length : null,
    lastDistance: initialized ? (num(state.last_deviation)?.toFixed(3) ?? "—") : null,
    lastUpdated: initialized && state.updated_at ? formatTimestamp(state.updated_at) : null,
  };
}

let demoReference = null;

/**
 * The Personal Baseline section of a session screen: the baseline's state and what this session did to it.
 * Read-only: it never updates the baseline (that happens once, when a session is stored).
 * @param {{ state: Object|null, error: string|null }} demo - AppContext.demoBaseline
 * @param {Object} session - history item
 * @returns {Object|null} null until the demo baseline has been loaded
 */
export function describeDemoBaseline(demo, session) {
  const state = demo?.state;
  if (!state) return null;
  if (!demoReference) demoReference = loadAssessmentReference();
  const sessionId = session?.session_id ?? session?.id ?? null;
  const c = sessionId ? state.contributions?.[sessionId] : null;
  let thisSession;
  if (c?.action === "initialized") {
    thisSession = "This session initialized the personal baseline. No distance was calculated: there was no earlier baseline.";
  } else if (c?.action === "updated") {
    thisSession = `This session updated the personal baseline. Distance from the baseline before the update: ${num(c.deviation)?.toFixed(3) ?? "—"}.`;
  } else {
    const input = demoBaselineInput(session, demoReference);
    thisSession = input.eligible
      ? "This session was not processed by the current personal baseline (it was recorded before the baseline started or before its last reset)."
      : `This session was skipped: ${input.reason}.`;
  }
  return {
    explanation: DEMO_BASELINE_EXPLANATION,
    error: demo.error ?? null,
    stateLabel: state.initialized ? "Initialized" : "Not initialized",
    sessionsProcessed: state.sessions_processed,
    uniqueReferences: state.unique_reference_ids.length,
    lastReference: referenceRecordingLabel(state.last_reference_id),
    lastDistance: num(state.last_deviation)?.toFixed(3) ?? "—",
    thisSession,
  };
}
