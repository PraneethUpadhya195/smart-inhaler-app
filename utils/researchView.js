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
