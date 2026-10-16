/**
 * services/sessionWaveform.js — the waveform of a session's recording, for the session screen:
 *   - a bundled demo recording: from the app's assets (services/demoRecordings.js);
 *   - a PRISM device recording: from the WAV kept on this phone (services/audioFiles.js).
 * A device recording made on another phone (or whose file was removed) has no waveform here:
 * raw audio is never uploaded, so the result says so instead of drawing anything else.
 */

import { loadDemoWaveform } from "./demoRecordings";
import { loadRecordingAudio } from "./audioFiles";
import { waveformEnvelope } from "./demoSession";

/**
 * @param {Object} session - history item
 * @param {number} [bins]
 * @returns {Promise<{ label: string, peaks: number[], durationS: number }|{ missing: string }|null>}
 *   null when the session has no recording to draw (simulated, legacy)
 */
export async function loadSessionWaveform(session, bins) {
  const demo = await loadDemoWaveform(session, bins);
  if (demo) return { label: demo.recordingId, peaks: demo.peaks, durationS: demo.durationS };
  if (session?.source !== "ble") return null;
  const file = session.capture?.audio?.stored === "local_only" ? session.capture.audio.file : null;
  if (!file) return { missing: "The raw audio of this recording was not kept." };
  const bytes = await loadRecordingAudio(file);
  if (!bytes) return { missing: "The raw audio is kept only on the phone that made the recording." };
  return { label: file, ...waveformEnvelope(bytes, bins) };
}
