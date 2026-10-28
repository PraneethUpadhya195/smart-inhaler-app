/**
 * utils/recordingView.js — what the Dashboard shows about an on-board recording in progress
 * (services/recordingWorkflow.js state). Pure: tested in utils/test_recording_view.js.
 *
 * Every state shown is the workflow's real state (device status, samples captured and received);
 * nothing advances on a timer. Errors are shown with their reason and the next useful action:
 * "Connect device" when the link is the problem, "Try again" otherwise.
 */

export const STEPS = Object.freeze([
  { phase: "CONNECTING", label: "Connect" },
  { phase: "RECORDING", label: "Record" },
  { phase: "TRANSFERRING", label: "Transfer" },
  { phase: "ANALYSING", label: "Analyse" },
  { phase: "COMPLETED", label: "Done" },
]);

const STEP_INDEX = { IDLE: -1, CONNECTING: 0, READY: 0, RECORDING: 1, TRANSFERRING: 2, SAVING: 2, ANALYSING: 3, COMPLETED: 4 };

/** Recorder and workflow error codes → what the user can do about them. */
export const ERROR_TEXT = Object.freeze({
  BLUETOOTH_UNAVAILABLE: "Bluetooth is off or unavailable on this phone.",
  PERMISSION_DENIED: "PRISM needs the Nearby devices (Bluetooth) permission to reach the device.",
  DEVICE_NOT_FOUND: "No PRISM device was found nearby. Check that it is powered and close to the phone.",
  CONNECT_FAILED: "The PRISM device could not be connected.",
  NOT_CONNECTED: "No PRISM device is connected.",
  DISCONNECTED: "The connection to the PRISM device was lost.",
  PROTOCOL_MISMATCH: "The device firmware and this app use different protocol versions.",
  UNSUPPORTED_DEVICE: "This device cannot be used for the analysis.",
  BUSY: "The device is busy with another recording.",
  START_REFUSED: "The device did not start the recording.",
  DEVICE_ERROR: "The device reported an error.",
  TIMEOUT: "The device stopped answering.",
  TRANSFER_INCOMPLETE: "The recording did not arrive complete, so it was not analysed.",
  CRC_MISMATCH: "The received audio failed its checksum, so it was not analysed.",
  ABORTED: "The recording was stopped.",
  ANALYSIS_FAILED: "The recording could not be analysed or saved.",
  SELECTION_FAILED: "The analysis could not be prepared, so no recording was started.",
  STORAGE_FAILED: "The recording could not be saved on this phone, so it was not analysed.",
});

const seconds = (samples) => (Number.isFinite(samples) ? samples / 8000 : null);
// The device's own message is shown under the summary unless it only repeats it.
const letters = (t) => String(t ?? "").toLowerCase().replace(/\bwas\b|[^a-z]/g, "");
const repeats = (reason, text) => letters(reason) === "" || letters(text).includes(letters(reason)) || letters(reason).includes(letters(text));
const fmt = (s) => (s === null ? "—" : `${s.toFixed(1)} s`);

/**
 * @param {Object} state - recordingWorkflow state
 * @returns {{ active: boolean, phase: string, step: number, title: string, detail: string|null,
 *   progress: { value: number, label: string }|null, error: { text: string, reason: string, code: string }|null,
 *   actions: { start: boolean, retry: boolean, connect: boolean, viewResult: boolean, dismiss: boolean } }}
 */
export function describeRecordingState(state) {
  const phase = state?.phase ?? "IDLE";
  const deviceName = state?.device?.name ?? "the PRISM device";
  const requested = seconds(state?.requestedSamples);
  const base = { phase, step: STEP_INDEX[phase] ?? -1, progress: null, error: null, detail: null,
    actions: { start: false, retry: false, connect: false, viewResult: false, dismiss: false } };
  switch (phase) {
    case "IDLE":
      return { ...base, active: false, title: "Ready to record", actions: { ...base.actions, start: true } };
    case "CONNECTING":
      return { ...base, active: true, title: "Connecting to the PRISM device…" };
    case "READY":
      return { ...base, active: true, title: `Connected to ${deviceName}`, detail: "Starting the recording…" };
    case "RECORDING": {
      const captured = seconds(state.capturedSamples) ?? 0;
      return {
        ...base,
        active: true,
        title: "Recording…",
        detail: `Use the inhaler now. ${fmt(captured)} of ${fmt(requested)} recorded; ${fmt(seconds(state.receivedSamples) ?? 0)} received.`,
        progress: requested ? { value: Math.min(1, captured / requested), label: `${fmt(captured)} / ${fmt(requested)}` } : null,
      };
    }
    case "TRANSFERRING": {
      const received = seconds(state.receivedSamples) ?? 0;
      return {
        ...base,
        active: true,
        title: state.verified ? "Recording received and verified" : state.verifying ? "Verifying the recording…" : "Receiving the rest of the recording…",
        detail: state.verified
          ? "Sample count and checksum match the device."
          : state.missingPackets ? `${state.missingPackets} lost packet(s) are being sent again.` : null,
        progress: requested ? { value: Math.min(1, received / requested), label: `${fmt(received)} / ${fmt(requested)} received` } : null,
      };
    }
    case "SAVING":
      return { ...base, active: true, title: "Saving the recording on this phone…", detail: "Sample count and checksum match the device." };
    case "ANALYSING":
      return { ...base, active: true, title: "Analysing on this phone…", detail: state.step ? `Now ${state.step}.` : null };
    case "COMPLETED":
      return { ...base, active: false, title: "Recording analysed and saved",
        detail: "The result is saved on this phone and will sync to the cloud when a connection is available.",
        actions: { ...base.actions, viewResult: true, dismiss: true, start: true } };
    case "ERROR": {
      const code = state.error?.code ?? "ANALYSIS_FAILED";
      const failedAt = STEPS.find((s) => s.phase === (state.failedPhase === "READY" ? "CONNECTING" : state.failedPhase));
      return {
        ...base,
        active: false,
        step: STEP_INDEX[state.failedPhase] ?? -1,
        title: failedAt ? `${failedAt.label} failed` : "Recording failed",
        error: {
          code,
          text: ERROR_TEXT[code] ?? "The recording failed.",
          reason: repeats(state.error?.message, ERROR_TEXT[code] ?? "") ? "" : state.error?.message ?? "",
        },
        detail: "Nothing was saved from this attempt.",
        actions: { ...base.actions, retry: !state.error?.needsConnection, connect: Boolean(state.error?.needsConnection), dismiss: true },
      };
    }
    default:
      return { ...base, active: false, title: "Ready to record", actions: { ...base.actions, start: true } };
  }
}
