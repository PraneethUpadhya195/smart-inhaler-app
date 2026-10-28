/**
 * services/recordingWorkflow.js — the lifecycle of one on-board recording:
 *
 *   IDLE → CONNECTING → READY → RECORDING → TRANSFERRING → ANALYSING → COMPLETED
 *                                       ↘ ERROR (from any step; the step and a retry hint are kept)
 *
 * It composes the device recorder (services/ble/PrismRecorder.js), the analysis
 * (services/hardwareSession.analyseHardwareRecording) and the app's storage, all injected, so the
 * same code runs in the app and in the Node tests. It never substitutes other audio: if the device
 * is not available the workflow ends in ERROR, and demo recordings stay a separate action.
 *
 * Order of persistence: the verified audio is written to the phone first (when a writer is given),
 * then analysed, then the session record is stored locally (the cloud upload is the sync service's
 * job, in the background). A failure after the audio was kept leaves the file on the phone.
 *
 * Start Event (run({ analysis })): the analysis recording is chosen first (selectAnalysis, before
 * any capture), then the device records as above. Then:
 *
 *   TRANSFERRING (verified) → SAVING (the device recording is written to the phone; required)
 *     → ANALYSING (the chosen recording, never the capture) → COMPLETED
 *
 * Nothing is analysed unless the capture was received, verified and saved. If no session record can
 * be stored, the saved capture is removed (discardAudio) so that no file is left without a session.
 */

import { RECORDER_ERROR, RecorderError } from "./ble/PrismRecorder.js";

export const LIFECYCLE = Object.freeze({
  IDLE: "IDLE",
  CONNECTING: "CONNECTING",
  READY: "READY",
  RECORDING: "RECORDING",
  TRANSFERRING: "TRANSFERRING",
  SAVING: "SAVING",
  ANALYSING: "ANALYSING",
  COMPLETED: "COMPLETED",
  ERROR: "ERROR",
});

/** Workflow error codes (besides the recorder's). */
export const WORKFLOW_ERROR = Object.freeze({
  SELECTION_FAILED: "SELECTION_FAILED",
  STORAGE_FAILED: "STORAGE_FAILED",
  ANALYSIS_FAILED: "ANALYSIS_FAILED",
});

class WorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

/** Errors after which "Connect device" (not "Try again") is the useful next action. */
const NEEDS_CONNECTION = new Set([RECORDER_ERROR.NOT_CONNECTED, RECORDER_ERROR.DISCONNECTED,
  RECORDER_ERROR.CONNECT_FAILED, RECORDER_ERROR.DEVICE_NOT_FOUND, RECORDER_ERROR.BLUETOOTH_UNAVAILABLE,
  RECORDER_ERROR.PERMISSION_DENIED]);

/**
 * @param {Object} deps
 * @param {Object} deps.recorder - createPrismRecorder()
 * @param {(recording: Object, ctx: { audioFile: string|null }) => Promise<Object>} deps.analyse - builds the session record
 * @param {(record: Object) => Promise<string>} deps.save - stores it on the phone; resolves with the session id
 * @param {(recording: Object) => Promise<string|null>} [deps.keepAudio] - writes the WAV locally; resolves with its name
 * @param {(selection: string) => Promise<Object>} [deps.selectAnalysis] - Start Event: chooses the analysis recording
 * @param {(name: string) => Promise<void>} [deps.discardAudio] - Start Event: removes a saved capture no session refers to
 * @param {(state: Object) => void} [deps.onState]
 * @param {{ warn: Function }} [deps.log]
 */
export function createRecordingWorkflow({ recorder, analyse, save, keepAudio = async () => null, selectAnalysis = null,
  discardAudio = async () => {}, onState = () => {}, log = console }) {
  let state = { phase: LIFECYCLE.IDLE };
  let running = false;

  const set = (next) => {
    state = Object.freeze({ ...next, at: Date.now() });
    try {
      onState(state);
    } catch (e) {
      log.warn?.("[recordingWorkflow] state listener failed:", e?.message ?? e);
    }
  };

  function fail(phase, error) {
    const code = error instanceof RecorderError || error instanceof WorkflowError ? error.code : WORKFLOW_ERROR.ANALYSIS_FAILED;
    set({
      phase: LIFECYCLE.ERROR,
      failedPhase: phase,
      error: {
        code,
        message: error?.message ?? String(error),
        needsConnection: NEEDS_CONNECTION.has(code),
        transfer: error?.details?.transfer ?? null,
        deviceError: error?.details?.deviceError ?? null,
      },
    });
  }

  /**
   * @param {Object} [options]
   * @param {string|null} [options.deviceId] - BLE id of the device to connect to (null: first found)
   * @param {number} [options.nSamples]
   * @param {string} [options.analysis] - Start Event: services/analysisRecordings SELECTION value
   * @returns {Promise<{ sessionId: string, record: Object }|null>} null when it ended in ERROR
   */
  async function run({ deviceId = null, nSamples, analysis } = {}) {
    if (running) throw new Error("a recording is already in progress");
    running = true;
    let phase = LIFECYCLE.CONNECTING;
    try {
      let analysisRecording = null;
      if (analysis !== undefined) {
        try {
          if (!selectAnalysis) throw new Error("no analysis selection is configured");
          analysisRecording = await selectAnalysis(analysis);
        } catch (e) {
          throw new WorkflowError(WORKFLOW_ERROR.SELECTION_FAILED, e?.message ?? String(e));
        }
      }
      if (!recorder.isConnected()) {
        set({ phase: LIFECYCLE.CONNECTING });
        await recorder.connect({ deviceId });
      }
      const device = recorder.getDevice();
      set({ phase: LIFECYCLE.READY, device });
      phase = LIFECYCLE.RECORDING;
      const requested = nSamples ?? device.defaultSamples;
      set({ phase, device, requestedSamples: requested, capturedSamples: 0, receivedSamples: 0 });
      const recording = await recorder.record({
        nSamples: requested,
        onProgress: (p) => {
          if (p.phase === "RECORDING") {
            set({ phase: LIFECYCLE.RECORDING, device, requestedSamples: p.requestedSamples,
              capturedSamples: p.capturedSamples, receivedSamples: p.receivedSamples });
          } else if (p.phase === "TRANSFERRING" || p.phase === "VERIFYING") {
            phase = LIFECYCLE.TRANSFERRING;
            set({ phase, device, requestedSamples: p.requestedSamples, receivedSamples: p.receivedSamples,
              missingPackets: p.missingPackets ?? 0, verifying: p.phase === "VERIFYING" });
          }
        },
      });
      phase = LIFECYCLE.TRANSFERRING;
      set({ phase, device, requestedSamples: requested, receivedSamples: recording.nSamples, verified: true,
        transfer: recording.transfer });

      if (analysisRecording) return await analyseWithReference(recording, device, analysisRecording, (p) => { phase = p; });

      phase = LIFECYCLE.ANALYSING;
      set({ phase, device, step: "keeping the audio on this phone" });
      let audioFile = null;
      try {
        audioFile = await keepAudio(recording);
      } catch (e) {
        log.warn?.("[recordingWorkflow] audio not kept on the phone:", e?.message ?? e);
      }
      set({ phase, device, step: "running the on-device analysis" });
      const record = await analyse(recording, { audioFile });
      set({ phase, device, step: "saving the session" });
      const sessionId = await save(record);
      set({ phase: LIFECYCLE.COMPLETED, device, sessionId, sessionStatus: record.session_status, record });
      return { sessionId, record };
    } catch (e) {
      fail(phase, e);
      return null;
    } finally {
      running = false;
    }
  }

  /** Start Event after a verified capture: save it (required), then analyse the chosen recording. */
  async function analyseWithReference(recording, device, analysisRecording, setPhase) {
    setPhase(LIFECYCLE.SAVING);
    set({ phase: LIFECYCLE.SAVING, device });
    let audioFile = null;
    try {
      audioFile = await keepAudio(recording);
    } catch (e) {
      throw new WorkflowError(WORKFLOW_ERROR.STORAGE_FAILED, e?.message ?? String(e));
    }
    if (!audioFile) throw new WorkflowError(WORKFLOW_ERROR.STORAGE_FAILED, "the recording could not be saved on this phone");

    setPhase(LIFECYCLE.ANALYSING);
    let record;
    let sessionId;
    try {
      set({ phase: LIFECYCLE.ANALYSING, device, step: "running the on-device analysis" });
      record = await analyse(recording, { audioFile, analysisRecording });
      set({ phase: LIFECYCLE.ANALYSING, device, step: "saving the session" });
      sessionId = await save(record);
    } catch (e) {
      try {
        await discardAudio(audioFile);
      } catch (d) {
        log.warn?.("[recordingWorkflow] unsaved recording not removed:", d?.message ?? d);
      }
      throw e;
    }
    set({ phase: LIFECYCLE.COMPLETED, device, sessionId, sessionStatus: record.session_status, record });
    return { sessionId, record };
  }

  return {
    run,
    getState: () => state,
    isRunning: () => running,
    /** Back to IDLE after COMPLETED or ERROR (the UI dismissed the result). */
    reset() {
      if (!running) set({ phase: LIFECYCLE.IDLE });
    },
  };
}
