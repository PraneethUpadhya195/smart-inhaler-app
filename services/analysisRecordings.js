/**
 * services/analysisRecordings.js — the analysis input of a device session started with "Start Event".
 *
 * Such a session has two audio sources, kept apart in the record and never substituted for each other:
 *   - capture: the recording the PRISM device made in this session (BLE, CRC-verified), saved on the
 *     phone and used for playback (session.capture.audio);
 *   - analysis input: a bundled reference-dataset recording chosen here, run through the unchanged
 *     pipeline and Stage 9 (session.analysis_source; session.recordings[0].input).
 *
 *   short press → one of INHALATION_RECORDINGS, at random, never the previous one when there are two or more
 *   long press  → NO_INHALATION_RECORDING
 *
 * The previous short-press choice is kept on the phone (injected key-value storage), so the no-repeat
 * rule holds across app restarts. session.analysis_source names the recording by its id, dataset
 * recording id and SHA-256, never by file name alone. Sessions without analysis_source (all earlier
 * sessions) are analyses of their own audio and are never reinterpreted.
 *
 * Pure (no React Native import): tested in services/test_split_source.js.
 */

import { DEMO_RECORDINGS } from "./demoSession.js";
import { sha256Hex } from "../pipeline/sha256.js";

export const ANALYSIS_SOURCE_SCHEMA = "prism-analysis-source-v1";

/** session.analysis_source.type */
export const ANALYSIS_SOURCE_TYPE = Object.freeze({
  /** the pipeline ran on the audio captured in this session */
  DEVICE_CAPTURE: "device_capture",
  /** the pipeline ran on a bundled reference recording chosen at Start Event */
  REFERENCE_RECORDING: "reference_recording",
});

/** What Start Event asks for: short press / long press. */
export const SELECTION = Object.freeze({ INHALATION: "inhalation", NO_INHALATION: "no_inhalation" });

/**
 * The eight demo recordings (assets/demo_recordings/), each analysed to one scoreable inhalation by
 * the unchanged pipeline (claude_implementation.md Entry 8; services/test_split_source.js).
 */
export const INHALATION_RECORDINGS = Object.freeze(DEMO_RECORDINGS.map((r, i) => Object.freeze({
  id: `ref-inhalation-${String(i + 1).padStart(2, "0")}`,
  selection: SELECTION.INHALATION,
  asset: `demo_recordings/${r.file}`,
  recordingId: r.recordingId,
  sha256: r.sha256,
})));

/** The recording of the research golden case no_inhalation_detected (assets/analysis_recordings/). */
export const NO_INHALATION_RECORDING = Object.freeze({
  id: "ref-no-inhalation-01",
  selection: SELECTION.NO_INHALATION,
  asset: "analysis_recordings/no_inhalation_01.wav",
  recordingId: "rec2018-01-23_11h00m33.928s.wav",
  sha256: "9d99aa359f02666344eef83f4d0b118cf90830f381619d6d0da37a3974391181",
});

export const ANALYSIS_RECORDINGS = Object.freeze([...INHALATION_RECORDINGS, NO_INHALATION_RECORDING]);

export const SELECTION_STATE_KEY = "@PRISM:analysisSelection";

/**
 * Pick the analysis recording for one Start Event.
 * @param {string} selection - SELECTION.INHALATION | SELECTION.NO_INHALATION
 * @param {Object} [options]
 * @param {string|null} [options.previousId] - the previous short-press choice
 * @param {() => number} [options.random]
 * @param {Object[]} [options.inhalation] - the short-press set (tests)
 * @returns {Object} one of ANALYSIS_RECORDINGS
 */
export function pickAnalysisRecording(selection, { previousId = null, random = Math.random, inhalation = INHALATION_RECORDINGS } = {}) {
  if (selection === SELECTION.NO_INHALATION) return NO_INHALATION_RECORDING;
  if (selection !== SELECTION.INHALATION) throw new Error(`unknown analysis selection ${selection}`);
  if (inhalation.length === 0) throw new Error("no inhalation recording is configured");
  const candidates = inhalation.length > 1 ? inhalation.filter((r) => r.id !== previousId) : inhalation;
  return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
}

/**
 * The selection with its state kept on the phone.
 * @param {Object} deps
 * @param {{ getItem(k: string): Promise<string|null>, setItem(k: string, v: string): Promise<void> }} deps.storage
 * @param {() => number} [deps.random]
 * @param {() => Date} [deps.now]
 * @param {{ warn: Function }} [deps.log]
 */
export function createAnalysisSelector({ storage, random = Math.random, now = () => new Date(), log = console }) {
  async function previousId() {
    try {
      const state = JSON.parse((await storage.getItem(SELECTION_STATE_KEY)) ?? "null");
      const id = state?.last_inhalation_id;
      return INHALATION_RECORDINGS.some((r) => r.id === id) ? id : null; // unknown or stale ids are ignored
    } catch (e) {
      log.warn?.("[analysisRecordings] selection state unreadable; starting afresh:", e?.message ?? e);
      return null;
    }
  }

  return {
    /**
     * @param {string} selection - SELECTION.INHALATION | SELECTION.NO_INHALATION
     * @returns {Promise<Object>} the chosen recording plus selected_at (ISO)
     */
    async select(selection) {
      const recording = pickAnalysisRecording(selection, { previousId: selection === SELECTION.INHALATION ? await previousId() : null, random });
      if (selection === SELECTION.INHALATION) {
        try {
          await storage.setItem(SELECTION_STATE_KEY, JSON.stringify({ last_inhalation_id: recording.id }));
        } catch (e) {
          log.warn?.("[analysisRecordings] selection state not kept:", e?.message ?? e);
        }
      }
      return { ...recording, selectedAt: now().toISOString() };
    },
  };
}

/**
 * The analysis_source block of a session record.
 * @param {Object|null} recording - selector result, or null for an analysis of the captured audio
 */
export function analysisSourceBlock(recording) {
  if (!recording) return { schema: ANALYSIS_SOURCE_SCHEMA, type: ANALYSIS_SOURCE_TYPE.DEVICE_CAPTURE };
  return {
    schema: ANALYSIS_SOURCE_SCHEMA,
    type: ANALYSIS_SOURCE_TYPE.REFERENCE_RECORDING,
    selection: recording.selection,
    reference_id: recording.id,
    recording_id: recording.recordingId,
    sha256: recording.sha256,
    input_domain: "reference_dataset",
    selected_at: recording.selectedAt ?? null,
  };
}

/** True when the session's analysis input was a reference recording (explicit metadata only). */
export function usesReferenceInput(session) {
  return session?.analysis_source?.type === ANALYSIS_SOURCE_TYPE.REFERENCE_RECORDING;
}

/** The configured recording a session's analysis_source names, or null. */
export function analysisRecordingOf(session) {
  if (!usesReferenceInput(session)) return null;
  const src = session.analysis_source;
  return ANALYSIS_RECORDINGS.find((r) => r.id === src.reference_id && r.sha256 === src.sha256) ?? null;
}

/**
 * Throw unless the bytes are the configured recording (they are analysed only if they match).
 * @param {Object} recording
 * @param {Uint8Array} bytes
 */
export function verifyAnalysisBytes(recording, bytes) {
  const actual = sha256Hex(bytes);
  if (actual !== recording.sha256) {
    throw new Error(`analysis recording ${recording.id} does not match its SHA-256 (${actual.slice(0, 8)}…)`);
  }
}
