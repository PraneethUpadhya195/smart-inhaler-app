import SessionAggregator from '../pipeline/SessionAggregator.js';
import SimulatedPcmSource from '../pipeline/sources/SimulatedPcmSource.js';
import { buildSessionRecord } from './sessionRecord.js';

/**
 * simulationService.js
 *
 * "Simulate" runs the REAL pipeline and the REAL CNN detector on SYNTHETIC audio
 * (SimulatedPcmSource: silence, a tone and noise; not an inhalation recording). Nothing is
 * mocked: whatever the detector returns for that signal is what is stored, usually
 * NO_INHALATION_DETECTED. The session is marked `simulated: true` and `source: "simulation"`,
 * and the UI labels it as simulated everywhere.
 */

export const SIMULATION_NOTE =
  "Simulated session: synthetic test audio (not a recording) analysed by the on-device pipeline. " +
  "It does not describe an inhalation.";

/**
 * @param {() => Promise<import('../pipeline/InferencePipeline').default>} getPipeline -
 *   the platform's pipeline factory (app: services/inferenceService.getPipeline)
 * @param {Object} [options]
 * @param {number} [options.durationS=6]
 * @returns {Promise<Object>} session record (plain JSON, ready to persist)
 */
export async function runSimulatedSession(getPipeline, { durationS = 6 } = {}) {
  const stamp = Date.now();
  const source = new SimulatedPcmSource({ durationS, pattern: 'mixed', sourceId: `simulated_${stamp}` });
  const outputs = [];
  const processingErrors = [];
  try {
    const pipeline = await getPipeline();
    outputs.push(await pipeline.run(source));
  } catch (e) {
    // The pipeline could not run (e.g. model or runtime failure). Recorded as such, not as a result.
    processingErrors.push({ recording_id: source.sourceId, message: e?.message ?? String(e) });
  }
  const session = new SessionAggregator().aggregate(`sim_sess_${stamp}`, outputs, { processingErrors });
  return buildSessionRecord(session, { source: 'simulation', simulated: true, note: SIMULATION_NOTE });
}
