/**
 * services/demoRecordings.js — the app side of services/demoSession.js.
 *
 * The bundled demo recordings (assets/demo_recordings/, Metro assets) are resolved to local files
 * with expo-asset and read as bytes, the same way pipeline/runtime/reactNative.js loads the model.
 */

import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { analyseDemoRecording, demoRecordingOf, pickDemoRecording, waveformEnvelope } from "./demoSession";

/* eslint-disable no-undef -- Metro asset references (resolved at bundle time) */
const DEMO_ASSETS = {
  "demo_01.wav": require("../assets/demo_recordings/demo_01.wav"),
  "demo_02.wav": require("../assets/demo_recordings/demo_02.wav"),
  "demo_03.wav": require("../assets/demo_recordings/demo_03.wav"),
  "demo_04.wav": require("../assets/demo_recordings/demo_04.wav"),
  "demo_05.wav": require("../assets/demo_recordings/demo_05.wav"),
  "demo_06.wav": require("../assets/demo_recordings/demo_06.wav"),
  "demo_07.wav": require("../assets/demo_recordings/demo_07.wav"),
  "demo_08.wav": require("../assets/demo_recordings/demo_08.wav"),
};
/* eslint-enable no-undef */

/** @param {Object} recording - one of DEMO_RECORDINGS @returns {Promise<Uint8Array>} */
async function loadDemoBytes(recording) {
  const asset = Asset.fromModule(DEMO_ASSETS[recording.file]);
  await asset.downloadAsync(); // dev builds fetch it from Metro; release builds copy it out of the APK
  const uri = asset.localUri ?? asset.uri;
  if (!uri) throw new Error(`demo recording ${recording.file} has no local URI`);
  return new Uint8Array(await new File(uri).arrayBuffer());
}

/**
 * Analyse a randomly chosen bundled recording with the on-device pipeline.
 * @param {() => Promise<Object>} getPipeline
 * @returns {Promise<Object>} session record, ready for AppContext.addNewSession
 */
export async function runDemoSession(getPipeline) {
  const recording = pickDemoRecording();
  return analyseDemoRecording(getPipeline, recording, await loadDemoBytes(recording));
}

/**
 * The waveform of the bundled recording a session was made from.
 * @param {Object} session - history item
 * @param {number} [bins]
 * @returns {Promise<{ recordingId: string, peaks: number[], durationS: number }|null>} null when
 *   the session was not made from a bundled demo recording
 */
export async function loadDemoWaveform(session, bins) {
  const recording = demoRecordingOf(session);
  if (!recording) return null;
  return { recordingId: recording.recordingId, ...waveformEnvelope(await loadDemoBytes(recording), bins) };
}
