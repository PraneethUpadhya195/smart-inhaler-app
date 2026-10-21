/**
 * services/demoBaseline.js — the Demo Baseline: a demonstration of baseline initialization, distance
 * and gradual adaptation, built from the eligible reference inhalations analysed in Start Event sessions.
 * It is NOT a personal baseline: its inputs are bundled reference-dataset recordings, not the user's
 * inhalations. It is separate from Stage 9 (which it only reads) and from the V3 personal-reference
 * status (pipeline/PersonalReferenceStatus.js); it has its own storage key and data model.
 *
 * Input (per newly stored session): the Stage 9 measurements of the session's single scoreable event,
 *   x = feature_values of [spectral_centroid_mean, spectral_flatness_mean, spectral_centroid_std,
 *   spectral_rolloff_std], normalised with the Stage 9 reference parameters (loadAssessmentReference):
 *   z_j = (x_j - center_j) / scale_j  (the formula of ReferenceAssessment; checked against the
 *   assessment's own feature_deviations).
 * Algorithm (prism-demo-baseline-ema-v1):
 *   first eligible session      B = z                                  (no distance: there is no earlier baseline)
 *   later eligible sessions     D = sqrt(mean_j (z_j - B_before_j)^2)  (against the baseline BEFORE the update)
 *                               B = B_before + 0.3 * (z - B_before)
 *   No threshold, no categories. D is a distance in the normalised feature space, not a score.
 * Eligible: a Start Event session (analysis_source "reference_recording", selection "inhalation") whose
 *   reference is one of the eight bundled inhalation references (services/analysisRecordings.js, matched
 *   by id and SHA-256), with a verified capture, status SCORE_ONLY, a Stage 9 assessment against the
 *   bundled reference, and exactly one scoreable event with four finite measurements. Everything else
 *   (the no-inhalation reference, no inhalation detected, errors, invalid values) is skipped.
 * Idempotency: a session contributes at most once (its session_id is recorded with what it did).
 *
 * Pure (no React Native import): storage is injected. Tested in services/test_demo_baseline.js.
 */

import { rmsZ } from "../pipeline/contract.js";
import { V2_FEATURE_ORDER } from "../pipeline/versions.js";
import { ASSESSMENT_CONTRACT_VERSION, loadAssessmentReference } from "../pipeline/ReferenceAssessment.js";
import { analysisRecordingOf, SELECTION } from "./analysisRecordings.js";

export const DEMO_BASELINE_KEY = "@PRISM:demoBaseline";
export const DEMO_BASELINE_SCHEMA = "prism-demo-baseline-v1";
export const DEMO_BASELINE_ALGORITHM = "prism-demo-baseline-ema-v1";
export const DEMO_BASELINE_ETA = 0.3;

/** observe() outcome.action */
export const DEMO_ACTION = Object.freeze({
  INITIALIZED: "initialized",
  UPDATED: "updated",
  SKIPPED: "skipped",
  ALREADY_PROCESSED: "already_processed",
});

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isVector = (v) => Array.isArray(v) && v.length === V2_FEATURE_ORDER.length && v.every((x) => typeof x === "number" && Number.isFinite(x));
const sessionIdOf = (record) => record?.session_id ?? null;

/** An empty (not initialized) demo baseline. */
export function emptyDemoBaseline(referenceId) {
  return {
    schema: DEMO_BASELINE_SCHEMA,
    algorithm: DEMO_BASELINE_ALGORITHM,
    eta: DEMO_BASELINE_ETA,
    coordinates: { population_reference_id: referenceId, features: [...V2_FEATURE_ORDER] },
    initialized: false,
    baseline: null,
    sessions_processed: 0,
    unique_reference_ids: [],
    last_session_id: null,
    last_reference_id: null,
    last_deviation: null,
    updated_at: null,
    contributions: {},
  };
}

/**
 * Whether a stored session may update the demo baseline, and its normalised measurements.
 * @param {Object} record - session record (services/sessionRecord.buildSessionRecord) or history item
 * @param {Object} reference - loadAssessmentReference()
 * @returns {{ eligible: boolean, reason: string|null, referenceId?: string, z?: number[] }}
 */
export function demoBaselineInput(record, reference) {
  const no = (reason) => ({ eligible: false, reason });
  if (!isObject(record) || record.legacy === true) return no("not a current session record");
  if (!sessionIdOf(record)) return no("the session has no identifier");
  const src = record.analysis_source;
  if (record.source !== "ble" || src?.type !== "reference_recording") return no("not a Start Event analysis of a reference recording");
  if (src.selection !== SELECTION.INHALATION) return no("the no-inhalation reference is not an inhalation");
  const ref = analysisRecordingOf(record);
  if (!ref || ref.selection !== SELECTION.INHALATION) return no("the analysed recording is not one of the eligible inhalation references");
  if (record.capture?.integrity?.verified !== true) return no("the session did not complete with a verified recording");
  if (record.session_status !== "SCORE_ONLY") return no(`no measured inhalation (status ${record.session_status ?? "unknown"})`);
  const input = Array.isArray(record.recordings) ? record.recordings[0]?.input : null;
  if (record.recordings?.length !== 1 || input?.input_domain !== "reference_dataset" || input?.recording_id !== ref.recordingId) {
    return no("the analysis input does not match the selected reference");
  }
  const assessment = Array.isArray(record.assessments) ? record.assessments[0] : null;
  if (!assessment || assessment.contract_version !== ASSESSMENT_CONTRACT_VERSION || assessment.reference_id !== reference.referenceId) {
    return no("no Stage 9 assessment against the bundled reference");
  }
  const scoreable = (assessment.events ?? []).filter((e) => e?.scoreability === "SCOREABLE");
  if (scoreable.length !== 1) return no(`${scoreable.length} scoreable events (exactly one is required)`);
  const ev = scoreable[0];
  const x = V2_FEATURE_ORDER.map((f) => ev.feature_values?.[f]);
  if (!isVector(x)) return no("missing or invalid measurements");
  const z = x.map((v, j) => (v - reference.centers[j]) / reference.scales[j]);
  const stage9 = V2_FEATURE_ORDER.map((f) => ev.feature_deviations?.[f]);
  if (!isVector(z) || !isVector(stage9) || !z.every((v, j) => v === stage9[j])) return no("measurements are not consistent with the Stage 9 assessment");
  return { eligible: true, reason: null, referenceId: ref.id, z };
}

/**
 * Apply one eligible session to the demo baseline (pure).
 * @returns {{ state: Object, contribution: Object }}
 */
export function applyDemoBaseline(state, sessionId, referenceId, z, at) {
  if (!state.initialized) {
    const contribution = { action: DEMO_ACTION.INITIALIZED, reference_id: referenceId, z: [...z], baseline_before: null,
      baseline_after: [...z], deviation: null, at };
    return { contribution, state: { ...state, initialized: true, baseline: [...z], sessions_processed: state.sessions_processed + 1,
      unique_reference_ids: [...new Set([...state.unique_reference_ids, referenceId])], last_session_id: sessionId,
      last_reference_id: referenceId, last_deviation: null, updated_at: at, contributions: { ...state.contributions, [sessionId]: contribution } } };
  }
  const before = state.baseline;
  const deviation = rmsZ(z.map((v, j) => v - before[j]));
  const after = before.map((b, j) => b + DEMO_BASELINE_ETA * (z[j] - b));
  const contribution = { action: DEMO_ACTION.UPDATED, reference_id: referenceId, z: [...z], baseline_before: [...before],
    baseline_after: after, deviation, at };
  return { contribution, state: { ...state, baseline: after, sessions_processed: state.sessions_processed + 1,
    unique_reference_ids: [...new Set([...state.unique_reference_ids, referenceId])], last_session_id: sessionId,
    last_reference_id: referenceId, last_deviation: deviation, updated_at: at, contributions: { ...state.contributions, [sessionId]: contribution } } };
}

/** Throw unless `raw` is a stored demo baseline that this version can use. */
export function validateDemoBaseline(raw, referenceId) {
  const fail = (m) => { throw new Error(`invalid demo baseline: ${m}`); };
  if (!isObject(raw) || raw.schema !== DEMO_BASELINE_SCHEMA || raw.algorithm !== DEMO_BASELINE_ALGORITHM || raw.eta !== DEMO_BASELINE_ETA) fail("format");
  if (raw.coordinates?.population_reference_id !== referenceId) fail("another reference");
  if (typeof raw.initialized !== "boolean" || !Number.isInteger(raw.sessions_processed) || raw.sessions_processed < 0) fail("counters");
  if (!Array.isArray(raw.unique_reference_ids) || !isObject(raw.contributions)) fail("lists");
  const contributions = Object.values(raw.contributions);
  if (contributions.length !== raw.sessions_processed) fail("processed sessions do not match the counter");
  if (raw.initialized ? !isVector(raw.baseline) : raw.baseline !== null || raw.sessions_processed !== 0) fail("baseline vector");
  if (contributions.some((c) => !isVector(c?.z) || !isVector(c?.baseline_after))) fail("contribution vectors");
  return raw;
}

/**
 * The demo baseline on this phone.
 * @param {Object} deps
 * @param {{ getItem: Function, setItem: Function }} deps.storage - AsyncStorage (app) or an in-memory object (tests)
 * @param {Object} [deps.reference] - loadAssessmentReference() (default: the bundled Stage 9 reference)
 * @param {() => Date} [deps.now]
 * @param {{ warn: Function }} [deps.log]
 */
export function createDemoBaselineStore({ storage, reference = loadAssessmentReference(), now = () => new Date(), log = console }) {
  let chain = Promise.resolve();
  const serialized = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  /** @returns {Promise<{ state: Object, error: string|null }>} an unreadable entry is reported, never used */
  async function load() {
    try {
      const raw = await storage.getItem(DEMO_BASELINE_KEY);
      if (raw == null) return { state: emptyDemoBaseline(reference.referenceId), error: null };
      return { state: validateDemoBaseline(JSON.parse(raw), reference.referenceId), error: null };
    } catch (e) {
      log.warn?.("[demoBaseline] stored demo baseline not usable:", e?.message ?? e);
      return { state: emptyDemoBaseline(reference.referenceId), error: "The personal baseline could not be read. Reset it to start again." };
    }
  }

  return {
    load,

    /**
     * After a session record was stored: let it update the demo baseline once, if it is eligible.
     * Never throws; storage problems are returned as `error` and change nothing.
     * @returns {Promise<{ outcome: { action: string, reason: string|null, deviation: number|null }, state: Object, error: string|null }>}
     */
    observe(record) {
      return serialized(async () => {
        const loaded = await load();
        if (loaded.error) {
          return { outcome: { action: DEMO_ACTION.SKIPPED, reason: "the demo baseline could not be read", deviation: null }, ...loaded };
        }
        const sessionId = sessionIdOf(record);
        if (sessionId && loaded.state.contributions[sessionId]) {
          return { outcome: { action: DEMO_ACTION.ALREADY_PROCESSED, reason: null, deviation: loaded.state.contributions[sessionId].deviation },
            state: loaded.state, error: null };
        }
        const input = demoBaselineInput(record, reference);
        if (!input.eligible) return { outcome: { action: DEMO_ACTION.SKIPPED, reason: input.reason, deviation: null }, state: loaded.state, error: null };
        const { state, contribution } = applyDemoBaseline(loaded.state, sessionId, input.referenceId, input.z, now().toISOString());
        try {
          await storage.setItem(DEMO_BASELINE_KEY, JSON.stringify(state));
        } catch (e) {
          log.warn?.("[demoBaseline] demo baseline not saved:", e?.message ?? e);
          return { outcome: { action: DEMO_ACTION.SKIPPED, reason: "the demo baseline could not be saved", deviation: null },
            state: loaded.state, error: "The personal baseline could not be saved." };
        }
        return { outcome: { action: contribution.action, reason: null, deviation: contribution.deviation }, state, error: null };
      });
    },

    /** Clear the demo baseline and its processing record only (one storage key). */
    reset() {
      return serialized(async () => {
        const state = emptyDemoBaseline(reference.referenceId);
        await storage.setItem(DEMO_BASELINE_KEY, JSON.stringify(state));
        return { state, error: null };
      });
    },
  };
}
