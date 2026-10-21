/**
 * services/analysisAudio.js — the app side of services/analysisRecordings.js: the bundled analysis
 * recordings (Metro assets), loaded with expo-asset as services/demoRecordings.js does.
 *
 * Used for the analysis input of a Start Event session and for the waveform of its analysis.
 * Playback never comes from here: it plays the device recording (services/audioFiles.js).
 */

import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { analysisRecordingOf, ANALYSIS_RECORDINGS } from "./analysisRecordings";
import { waveformEnvelope } from "./demoSession";

/* eslint-disable no-undef -- Metro asset references (resolved at bundle time) */
const ASSETS = {
  "demo_recordings/demo_01.wav": require("../assets/demo_recordings/demo_01.wav"),
  "demo_recordings/demo_02.wav": require("../assets/demo_recordings/demo_02.wav"),
  "demo_recordings/demo_03.wav": require("../assets/demo_recordings/demo_03.wav"),
  "demo_recordings/demo_04.wav": require("../assets/demo_recordings/demo_04.wav"),
  "demo_recordings/demo_05.wav": require("../assets/demo_recordings/demo_05.wav"),
  "demo_recordings/demo_06.wav": require("../assets/demo_recordings/demo_06.wav"),
  "demo_recordings/demo_07.wav": require("../assets/demo_recordings/demo_07.wav"),
  "demo_recordings/demo_08.wav": require("../assets/demo_recordings/demo_08.wav"),
  "analysis_recordings/no_inhalation_01.wav": require("../assets/analysis_recordings/no_inhalation_01.wav"),
};
/* eslint-enable no-undef */

/**
 * @param {Object} recording - one of ANALYSIS_RECORDINGS (or a selector result)
 * @returns {Promise<Uint8Array>} the bundled WAV's bytes
 * @throws when the recording is not bundled or cannot be read
 */
export async function loadAnalysisBytes(recording) {
  const module = ASSETS[recording?.asset];
  if (!module || !ANALYSIS_RECORDINGS.some((r) => r.id === recording.id)) {
    throw new Error(`analysis recording ${recording?.id ?? "?"} is not bundled with the app`);
  }
  const asset = Asset.fromModule(module);
  await asset.downloadAsync();
  const uri = asset.localUri ?? asset.uri;
  if (!uri) throw new Error(`analysis recording ${recording.id} has no local URI`);
  return new Uint8Array(await new File(uri).arrayBuffer());
}

/**
 * The waveform of the recording a Start Event session was analysed from.
 * @param {Object} session - history item
 * @param {number} [bins]
 * @returns {Promise<{ peaks: number[], durationS: number }|null>} null when the session names no
 *   configured analysis recording
 */
export async function loadAnalysisWaveform(session, bins) {
  const recording = analysisRecordingOf(session);
  if (!recording) return null;
  return waveformEnvelope(await loadAnalysisBytes(recording), bins);
}
