import SessionAggregator from '../pipeline/SessionAggregator.js';
import WavPcmSource from '../pipeline/sources/WavPcmSource.js';
import { decodeWav } from '../pipeline/wav.js';
import { buildSessionRecord } from './sessionRecord.js';

/**
 * demoSession.js
 *
 * "Analyse Demo Recording" runs the REAL pipeline and the REAL CNN detector on a recording from
 * the PRISM reference dataset that is bundled with the app (assets/demo_recordings/, byte-identical
 * copies of files in `../PRISM smart inhaler/data`). Nothing is mocked: whatever the pipeline
 * returns for that recording is what is stored. The session is stored and uploaded like any other
 * (source "wav", simulated false: the audio is a real recording), with input_domain
 * "reference_dataset" and a note saying that the audio is a bundled dataset recording, not one made
 * with this phone.
 *
 * Pure (no React Native import), so it runs in the Node tests. services/demoRecordings.js loads the
 * bundled files in the app.
 */

/** The bundled recordings: app asset file → dataset recording, with the SHA-256 of both. */
export const DEMO_RECORDINGS = Object.freeze([
  { file: 'demo_01.wav', recordingId: 'rec2018-01-23_11h00m14.641s.wav', sha256: '66b67d3ae138c52e0c6f3108f71fd3ebf86b47179cd5e9a5fde865b9eb8209f7' },
  { file: 'demo_02.wav', recordingId: 'rec2018-01-23_12h57m37.371s.wav', sha256: '184f384d3b73ffc3bc71d1830c997ef683c4b7fb537c2c92e5d45fc1d2c61e23' },
  { file: 'demo_03.wav', recordingId: 'rec2018-02-05_10h54m35.447s.wav', sha256: 'b1943b88c9bdbe1416374c9a6ec7867f11a4341b87aa31c7a6a5e07336634564' },
  { file: 'demo_04.wav', recordingId: 'rec2018-02-05_10h58m35.817s.wav', sha256: '873491f91f0368b9017b5c72af24bcdf3b011ae961501d7471dc83718844b981' },
  { file: 'demo_05.wav', recordingId: 'rec2018-02-06_10h28m57.917s.wav', sha256: 'bb9432ffaf4cfc511d723aecdd7caa54ec77a3131ae83696444e771d8a06ea01' },
  { file: 'demo_06.wav', recordingId: 'rec2018-05-03_11h43m36.628s.wav', sha256: 'bb7d411945ddf1c748701b202e9911bff3ca55624e978147f8da368c8a056253' },
  { file: 'demo_07.wav', recordingId: 'rec2018-05-03_15h31m15.084s.wav', sha256: 'cbc8fa5173c88674d3df6bd8217836d238d6f6473d3c90179cf0fd12cb5b6384' },
  { file: 'demo_08.wav', recordingId: 'rec2018-05-03_15h44m07.780s.wav', sha256: 'cd170d88f3a46fbdfc0814a8cb0edbc0b3028a038f66e37f3ccd90b75086605b' },
].map(Object.freeze));

/** @param {string} recordingId */
export const demoNote = (recordingId) =>
  `Demo: PRISM reference dataset recording ${recordingId}, bundled with the app and analysed on this phone. ` +
  'It was not recorded with this phone.';

/** @param {() => number} [random] @returns {Object} one of DEMO_RECORDINGS */
export function pickDemoRecording(random = Math.random) {
  return DEMO_RECORDINGS[Math.min(DEMO_RECORDINGS.length - 1, Math.floor(random() * DEMO_RECORDINGS.length))];
}

/**
 * @param {() => Promise<import('../pipeline/InferencePipeline').default>} getPipeline -
 *   the platform's pipeline factory (app: services/inferenceService.getPipeline)
 * @param {Object} recording - one of DEMO_RECORDINGS
 * @param {Uint8Array} bytes - the recording's WAV file
 * @param {Object} [options]
 * @param {() => number} [options.now=Date.now]
 * @returns {Promise<Object>} session record (plain JSON, ready to persist)
 */
export async function analyseDemoRecording(getPipeline, recording, bytes, { now = Date.now } = {}) {
  const source = new WavPcmSource(bytes, { inputDomain: 'reference_dataset', sourceId: recording.recordingId });
  const outputs = [];
  const processingErrors = [];
  try {
    const pipeline = await getPipeline();
    outputs.push(await pipeline.run(source));
  } catch (e) {
    // The pipeline could not run (e.g. model or runtime failure). Recorded as such, not as a result.
    processingErrors.push({ recording_id: recording.recordingId, message: e?.message ?? String(e) });
  }
  const session = new SessionAggregator().aggregate(`demo_sess_${now()}`, outputs, { processingErrors });
  return buildSessionRecord(session, { source: 'wav', simulated: false, note: demoNote(recording.recordingId) });
}

/**
 * The bundled recording a stored session was made from, or null for any other session.
 * @param {Object} session - a session record or history item
 * @returns {Object|null} one of DEMO_RECORDINGS
 */
export function demoRecordingOf(session) {
  if (session?.source !== 'wav' || !Array.isArray(session.recordings) || session.recordings.length !== 1) return null;
  const input = session.recordings[0]?.input;
  if (input?.input_domain !== 'reference_dataset') return null;
  return DEMO_RECORDINGS.find((r) => r.recordingId === input.recording_id) ?? null;
}

/**
 * Peak envelope of a WAV file for drawing: the largest absolute sample in each of `bins` equal
 * slices, scaled so that the loudest slice is 1.
 * @param {Uint8Array} bytes
 * @param {number} [bins=96]
 * @returns {{ peaks: number[], durationS: number }}
 */
export function waveformEnvelope(bytes, bins = 96) {
  const { samples, sampleRate } = decodeWav(bytes);
  const peaks = new Array(bins).fill(0);
  for (let i = 0; i < samples.length; i++) {
    const bin = Math.min(bins - 1, Math.floor((i * bins) / samples.length));
    const v = Math.abs(samples[i]);
    if (v > peaks[bin]) peaks[bin] = v;
  }
  const max = Math.max(...peaks);
  return {
    peaks: max > 0 ? peaks.map((p) => p / max) : peaks,
    durationS: samples.length / sampleRate,
  };
}
