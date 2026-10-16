/**
 * pipeline/PersonalReferenceStatus.js — the state of the V3 personal reference (Stage 10,
 * contract prism-personal-reference-v3.0-draft) for this phone's PRISM device, reported as
 * UNAVAILABLE. No personal deviation is computed.
 *
 * Why the personal channel is not active (research results/personal_reference/README.md and
 * assets/ml/personal_reference/personal_contract_v3.json, copied verbatim):
 *   - NOT_VALIDATED: the contract status is IMPLEMENTED_MECHANICALLY_VERIFIED_NOT_VALIDATED; it was
 *     evaluated on proxy/synthetic data only and has no calibrated personal cut-off.
 *   - SITTING_DEFINITION_INCOMPATIBLE: a sitting qualifies with >= 10 scoreable inhalations
 *     (min_events_per_sitting) within recordings <= 25 min apart, and 10 qualifying sittings
 *     (s_min) are needed before anything personal is reported. Real inhaler use gives one or two
 *     inhalations per dose, so this definition can never complete; the research README says the
 *     sitting definition must change before any deployment.
 *   - HARDWARE_REFERENCE_MISSING: its coordinates are the Stage 9 population reference, which is
 *     not validated for PRISM hardware audio.
 *
 * What is ported faithfully: the V3 sitting rule and the warm-up rule (personal_reference.py
 * observe_recording: a new sitting starts when a recording is more than sitting_gap_minutes after
 * the previous one; a sitting qualifies with >= min_events_per_sitting scoreable events; the status
 * is WARMUP while fewer than s_min sittings qualified). In WARMUP the V3 baseline is B = 0 and every
 * scoreable event gets POPULATION_ONLY (NOT_ASSESSED if not scoreable), exactly as V3 reports it.
 * The consensus-gated baseline update is not ported: under the rules above it cannot run, and
 * running it would need the validation that is missing.
 */

import { personalContractV3 } from "./contractAssets.js";

export const PERSONAL_CONTRACT_VERSION = "prism-personal-reference-v3.0-draft";

export const PERSONAL_BLOCKERS = Object.freeze({
  NOT_VALIDATED: "NOT_VALIDATED",
  SITTING_DEFINITION_INCOMPATIBLE: "SITTING_DEFINITION_INCOMPATIBLE",
  HARDWARE_REFERENCE_MISSING: "HARDWARE_REFERENCE_MISSING",
  WARMUP: "WARMUP",
  NO_DEVICE: "NO_DEVICE",
  UPDATE_RULE_NOT_PORTED: "UPDATE_RULE_NOT_PORTED", // only if s_min sittings ever qualified
});

const config = personalContractV3.config;

/** ISO 8601 → ms. A timestamp without a zone is read as UTC (only differences are used). */
function toMs(iso) {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const zoned = /([zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(zoned);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * V3 sittings of one user/device (personal_reference.observe_recording): chronological recordings,
 * a new sitting when the gap to the previous recording exceeds sitting_gap_minutes.
 * @param {{ recordedAt: string, nScoreable: number, nEvents?: number }[]} recordings - chronological;
 *   entries without a usable recordedAt are ignored (V3 requires the time)
 * @param {Object} [cfg] - V3 configuration (default: the primary 9-of-10 configuration)
 * @returns {{ sittingIndex: number, startedAt: string, endedAt: string, nRecordings: number,
 *   nEventsTotal: number, nScoreable: number, qualifying: boolean }[]}
 */
export function segmentSittings(recordings, cfg = config) {
  const gapMs = cfg.sitting_gap_minutes * 60 * 1000;
  const sittings = [];
  let current = null;
  let lastMs = null;
  for (const r of recordings) {
    const ms = toMs(r.recordedAt);
    if (ms === null) continue;
    if (lastMs !== null && ms < lastMs) throw new RangeError("recordings must be in chronological order");
    if (current === null || ms - lastMs > gapMs) {
      current = { sittingIndex: sittings.length, startedAt: r.recordedAt, endedAt: r.recordedAt, nRecordings: 0,
        nEventsTotal: 0, nScoreable: 0, qualifying: false };
      sittings.push(current);
    }
    current.endedAt = r.recordedAt;
    current.nRecordings += 1;
    current.nEventsTotal += r.nEvents ?? 0;
    current.nScoreable += r.nScoreable;
    current.qualifying = current.nScoreable >= cfg.min_events_per_sitting;
    lastMs = ms;
  }
  return sittings;
}

/**
 * The personal-reference state for one recording of a device, given that device's earlier recordings.
 *
 * @param {Object} args
 * @param {string|null} args.deviceId - the PRISM device (V3 keeps one reference per user AND device)
 * @param {{ recordedAt: string, nScoreable: number, nEvents?: number }[]} args.history - this device's
 *   earlier recordings, any order
 * @param {{ recordedAt: string, events: { event_id: number, status: string }[] }} args.current - the
 *   canonical V2 output's events of the new recording, with its start time
 * @returns {Object} plain JSON
 */
export function personalReferenceStatus({ deviceId, history, current }) {
  const scoreable = (current.events ?? []).filter((e) => e.status === "SCORE_ONLY").length;
  const all = [...history, { recordedAt: current.recordedAt, nScoreable: scoreable, nEvents: (current.events ?? []).length }]
    .filter((r) => toMs(r.recordedAt) !== null)
    .sort((a, b) => toMs(a.recordedAt) - toMs(b.recordedAt));
  const sittings = deviceId ? segmentSittings(all) : [];
  const nQualifying = sittings.filter((s) => s.qualifying).length;
  const status = nQualifying < config.s_min ? "WARMUP" : "ESTABLISHED";
  const blockers = [
    PERSONAL_BLOCKERS.NOT_VALIDATED,
    PERSONAL_BLOCKERS.SITTING_DEFINITION_INCOMPATIBLE,
    PERSONAL_BLOCKERS.HARDWARE_REFERENCE_MISSING,
    ...(deviceId ? [] : [PERSONAL_BLOCKERS.NO_DEVICE]),
    ...(status === "WARMUP" ? [PERSONAL_BLOCKERS.WARMUP] : [PERSONAL_BLOCKERS.UPDATE_RULE_NOT_PORTED]),
  ];
  const last = sittings[sittings.length - 1] ?? null;
  return {
    contract_version: PERSONAL_CONTRACT_VERSION,
    contract_status: personalContractV3.status,
    config_id: config.config_id,
    available: false,
    device_id: deviceId ?? null,
    personal_status: status,
    n_recordings: all.length,
    n_sittings: sittings.length,
    n_qualifying_sittings: nQualifying,
    s_min: config.s_min,
    min_events_per_sitting: config.min_events_per_sitting,
    sitting_gap_minutes: config.sitting_gap_minutes,
    current_sitting: last ? { sitting_index: last.sittingIndex, n_recordings: last.nRecordings, n_scoreable_events: last.nScoreable } : null,
    blockers,
    // V3 in WARMUP: scoreable events are POPULATION_ONLY. Beyond warm-up V3 would need the
    // (unported) baseline update, so nothing personal is stated: NOT_ASSESSED.
    events: (current.events ?? []).map((e) => ({
      event_id: e.event_id,
      personal_assessment: status === "WARMUP" && e.status === "SCORE_ONLY" ? "POPULATION_ONLY" : "NOT_ASSESSED",
      personal_deviation: null,
    })),
  };
}
