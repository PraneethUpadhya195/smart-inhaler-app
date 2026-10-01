import { FeatureExtractor } from './FeatureExtractor.js';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function test() {
    console.log("Starting Stage 10 Feature Extractor Test");
    
    const extractor = new FeatureExtractor();
    
    // Create dummy PCM segment
    const pcm = new Float32Array(8000); // 1 sec
    for (let i = 0; i < pcm.length; i++) {
        pcm[i] = Math.sin(2 * Math.PI * 440 * i / 8000) * 0.5;
    }
    
    console.log("Extracting features from 1s synthetic sine wave...");
    const res = extractor.extractFeatures(pcm);
    
    console.log(`Version: ${res.version}`);
    console.log(`Mean RMS: ${res.mean_rms}`);
    console.log(`Features Array: [${res.features.join(', ')}]`);
    
    assert(res.version === 'prism-inference-v2.0', "Version mismatch");
    assert(res.features.length === 4, "Should have 4 features");
    assert(res.mean_rms > 0, "Mean RMS should be > 0");
    assert(!isNaN(res.features[0]), "Features should not be NaN");
    
    console.log("SUCCESS: Feature extraction executed without errors and mapped to schema.");
}

test();
