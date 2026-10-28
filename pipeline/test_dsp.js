import { DspEngine } from './dsp.js';

function test() {
  const engine = new DspEngine();
  console.log("DSP Engine loaded successfully.");
  
  // Create deterministic synthetic PCM
  const durationS = 0.5;
  const sampleRate = 8000;
  const nSamples = Math.floor(durationS * sampleRate);
  const pcm = new Float32Array(nSamples);
  for (let i = 0; i < nSamples; i++) {
    pcm[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  
  console.log(`Processing ${nSamples} samples...`);
  const frames = engine.processPcm(pcm);
  
  console.log(`Produced ${frames.length} frames.`);
  if (frames.length > 0) {
    const firstFrame = frames[0];
    console.log(`First frame feature vector length: ${firstFrame.features.length}`);
    console.log(`First frame features (first 5):`, firstFrame.features.subarray(0, 5));
    console.log(`First frame features (last 5):`, firstFrame.features.subarray(119, 124));
  }
}

test();
