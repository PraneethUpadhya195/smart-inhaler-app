/**
 * services/hardwareSession.js — turns a verified PRISM device recording into a session record.
 *
 *   PrismRecorder.record() result (int16 samples, 8000 Hz, CRC-verified)
 *     → BlePcmSource (float32 = int16 / 32768, input_domain "prism_hardware")
 *     → InferencePipeline.run()            V2 contract output, unchanged, kept under `recordings`
 *     → assessRecording()                  Stage 9 output, kept under `assessments`
 *     → personalReferenceStatus()          V3 state (UNAVAILABLE), kept under `personal`
 *     → SessionAggregator + buildSessionRecord (source "ble", simulated false)
 *
 * The three results stay separate objects. Nothing is mocked: whatever the pipeline returns for the
 * recording is stored, including NO_INHALATION_DETECTED. If the pipeline cannot run, the session is
 * stored as a PROCESSING_ERROR (as for the other sources) so that the recording is not silently lost.
 *
 * Pure (no React Native import): the Node tests run it with the Node pipeline.
 */

import SessionAggregator from "../pipeline/SessionAggregator.js";
import BlePcmSource from "../pipeline/sources/BlePcmSource.js";
import { assessRecording } from "../pipeline/ReferenceAssessment.js";
import { personalReferenceStatus } from "../pipeline/PersonalReferenceStatus.js";
import { buildSessionRecord } from "./sessionRecord.js";

export const CAPTURE_SCHEMA = "prism-ble-capture-v1";

export const HARDWARE_NOTE =
  "Recorded with the PRISM device (ESP32 + INMP441 microphone) and analysed on this phone. The detector and the " +
  "reference were developed on recordings made with a different microphone; they are not validated for this device.";

/** Capture checks the device reports (META), copied when present. */
const META_FIELDS = ["rate_hz", "elapsed_us", "raw_or", "raw_and", "low_byte_nonzero", "min", "max", "clipped", "jumps",
  "mean", "short_reads", "dma_overflows", "ring_overruns", "ring_n", "preroll_ms"];

const isoOrNull = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

/**
 * Earlier recordings of this device, from the stored history (for the V3 sitting rule).
 * @param {Object[]} sessions - history items (AppContext.sessions)
 * @param {string|null} deviceId
 */
export function deviceHistory(sessions, deviceId) {
  if (!deviceId) return [];
  return (sessions ?? [])
    .filter((s) => s?.source === "ble" && s.device_id === deviceId && !s.legacy && isoOrNull(s.recorded_at))
    .map((s) => ({ recordedAt: s.recorded_at, nScoreable: Number.isInteger(s.n_scored) ? s.n_scored : 0,
      nEvents: Number.isInteger(s.n_events) ? s.n_events : 0 }));
}

/**
 * @param {() => Promise<Object>} getPipeline - the platform's pipeline factory
 * @param {Object} recording - PrismRecorder.record() result
 * @param {Object} [options]
 * @param {Object[]} [options.history] - deviceHistory() of the earlier sessions
 * @param {string|null} [options.audioFile] - name of the WAV kept on this phone, if any
 * @param {() => number} [options.now]
 * @returns {Promise<Object>} session record (plain JSON, ready to persist)
 */
export async function analyseHardwareRecording(getPipeline, recording, { history = [], audioFile = null, now = Date.now } = {}) {
  const { pcm, sampleRate, recordedAt, device } = recording;
  const deviceId = device?.deviceId ?? null;
  const recordingId = `prism_${recording.recordingId ?? now().toString(16)}`;
  const sessionId = `ble_sess_${now()}`;
  const pcmData = await new BlePcmSource(pcm, { sampleRate, sourceId: recordingId, recordedAt }).acquire();

  const outputs = [];
  const processingErrors = [];
  let assessment = null;
  let assessmentError = null;
  try {
    const pipeline = await getPipeline();
    const inference = await pipeline.run({ acquire: async () => pcmData });
    outputs.push(inference);
    try {
      assessment = await assessRecording(pipeline, inference, inference.recording_status === "INPUT_ERROR" ? null : pcmData);
    } catch (e) {
      assessmentError = e?.message ?? String(e); // the V2 result stands on its own
    }
  } catch (e) {
    processingErrors.push({ recording_id: recordingId, message: e?.message ?? String(e) });
  }

  const session = new SessionAggregator().aggregate(sessionId, outputs, { processingErrors });
  const personal = outputs.length > 0
    ? personalReferenceStatus({ deviceId, history, current: { recordedAt, events: outputs[0].events } })
    : null;
  const meta = recording.meta ?? {};
  const capture = {
    schema: CAPTURE_SCHEMA,
    device: {
      device_id: deviceId,
      name: device?.name ?? null,
      firmware: device?.firmware ?? null,
      protocol: device?.protocol ?? null,
      microphone: device?.microphone ?? null,
      i2s: device?.i2s ?? null,
      conversion: device?.conversion ?? null,
    },
    recording_id: recordingId,
    device_recording_id: recording.recordingId ?? null,
    recorded_at: recordedAt ?? null,
    sample_rate: sampleRate,
    n_samples: pcm.length,
    duration_s: pcm.length / sampleRate,
    integrity: { ...recording.transfer, failures: [...(recording.transfer?.failures ?? [])] },
    device_checks: Object.fromEntries(META_FIELDS.filter((k) => meta[k] !== undefined).map((k) => [k, meta[k]])),
    audio: audioFile ? { stored: "local_only", file: audioFile } : { stored: "not_stored", file: null },
    assessment_error: assessmentError,
  };
  return buildSessionRecord(session, {
    source: "ble",
    simulated: false,
    deviceId,
    note: HARDWARE_NOTE,
    capture,
    assessments: assessment ? [assessment] : null,
    personal,
  });
}
