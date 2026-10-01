import InferencePipeline from '../pipeline/InferencePipeline.js';
import SessionAggregator from '../pipeline/SessionAggregator.js';

/**
 * simulationService.js
 *
 * Generates a mock inhalation session by executing the real ML pipeline
 * against a synthetic audio signal. Ensures all domains and schema logic are exercised.
 */

export async function generateMockSession() {
  // 1. Generate 6 seconds of synthetic audio (mix of sine waves + noise)
  const sampleRate = 8000;
  const durationS = 6;
  const nSamples = sampleRate * durationS;
  const samples = new Float32Array(nSamples);
  
  for (let i = 0; i < nSamples; i++) {
    const t = i / sampleRate;
    // Add some noise
    let val = (Math.random() * 2 - 1) * 0.1;
    // Add a dominant frequency during the "inhale" (1.0s to 3.5s)
    if (t > 1.0 && t < 3.5) {
        val += Math.sin(2 * Math.PI * 440 * t) * 0.3;
    }
    samples[i] = val;
  }

  const pcmData = {
    sampleRate,
    samples,
    recordingId: `sim_rec_${Date.now()}`,
    recordedAt: new Date().toISOString()
  };

  // 2. Instantiate real pipeline
  const pipeline = new InferencePipeline();
  
  // Inject mock ONNX inference to guarantee an Inhale is detected from the synthetic signal
  // (In production with real WAVs, ONNX handles this)
  pipeline.runInference = async (windows) => {
    return windows.map(w => ({
        windowIndex: w.windowIndex,
        predictedClass: (w.startTime >= 1.0 && w.endTime <= 3.5) ? 2 : 0, // 2 = Inhale, 0 = Noise
        startTime: w.startTime,
        endTime: w.endTime,
        probabilities: new Float32Array([0.1, 0.1, 0.8, 0.0]), // Fake probabilities
        predictedLabel: (w.startTime >= 1.0 && w.endTime <= 3.5) ? 'Inhale' : 'Noise'
    }));
  };

  // Run the full pipeline (extracts DSP features, checks scoreability, calculates z-scores)
  const recordingResult = await pipeline.run(pcmData);

  // 3. Aggregate into a Session
  const aggregator = new SessionAggregator();
  const sessionResult = aggregator.aggregate(`sim_sess_${Date.now()}`, [recordingResult]);

  // Return the new schema format, attaching 'source' for the UI
  return {
    ...sessionResult,
    timestamp: sessionResult.sessionTimestamp,
    deviceId: null,
    source: "simulation"
  };
}
