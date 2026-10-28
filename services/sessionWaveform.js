/**
 * services/sessionWaveform.js — the waveform of a session's recording, for the session screen:
 *   - a bundled demo recording: from the app's assets (services/demoRecordings.js);
 *   - a PRISM device recording: from the WAV kept on this phone (services/audioFiles.js).
 *   - a Start Event session: the reference recording its analysis ran on (services/analysisAudio.js),
 *     because the events drawn on it come from that analysis. Its device recording is played back
 *     (components/RecordingPlayback.js), not drawn; neither replaces the other when one is missing.
 * A device recording made on another phone (or whose file was removed) has no waveform here:
 * raw audio is never uploaded, so the result says so instead of drawing anything else.
 */

import { loadDemoWaveform } from "./demoRecordings";
import { loadRecordingAudio } from "./audioFiles";
import { waveformEnvelope } from "./demoSession";
import { loadAnalysisWaveform } from "./analysisAudio";
import { usesReferenceInput } from "./analysisRecordings";

/**
 * @param {Object} session - history item
 * @param {number} [bins]
 * @returns {Promise<{ label: string, peaks: number[], durationS: number }|{ missing: string }|null>}
 *   null when the session has no recording to draw (simulated, legacy); label null for a Start Event session
 */
export async function loadSessionWaveform(session, bins) {
  if (usesReferenceInput(session)) {
    const analysis = await loadAnalysisWaveform(session, bins);
    return analysis ? { label: null, ...analysis } : { missing: "The waveform of this session's analysis is not available." };
  }
  const demo = await loadDemoWaveform(session, bins);
  if (demo) return { label: demo.recordingId, peaks: demo.peaks, durationS: demo.durationS };
  if (session?.source !== "ble") return null;
  const file = session.capture?.audio?.stored === "local_only" ? session.capture.audio.file : null;
  if (!file) return { missing: "The raw audio of this recording was not kept." };
  const bytes = await loadRecordingAudio(file);
  if (!bytes) return { missing: "The raw audio is kept only on the phone that made the recording." };
  return { label: file, ...waveformEnvelope(bytes, bins) };
}
