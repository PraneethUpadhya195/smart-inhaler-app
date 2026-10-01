import fs from 'fs';
import WavPcmSource from './sources/WavPcmSource.js';
import InferencePipeline from './InferencePipeline.js';
import BaselineStore from './BaselineStore.js';
import SessionAggregator from './SessionAggregator.js';

function assert(condition, message) {
    if (!condition) {
        console.error(`❌ FAIL: ${message}`);
        process.exit(1);
    }
}

function assertClose(actual, expected, tol = 1e-4, message = "") {
    if (Math.abs(actual - expected) > tol) {
        console.error(`❌ FAIL: ${message} (Expected ${expected}, got ${actual}, diff ${Math.abs(actual-expected)})`);
        process.exit(1);
    }
}

async function testHarness() {
    console.log("=== PRISM ML Regression Harness (Stage 15) ===\n");
    
    const pipeline = new InferencePipeline();
    
    // 1. WAV Parsing & Frame Extraction
    console.log("1. Testing WavPcmSource and Frame Extraction...");
    const wavSource = new WavPcmSource('assets/ml/v2_validation/golden/inputs/white_noise_3s_minus20dBFS.wav');
    const pcmData = await wavSource.acquire();
    assert(pcmData.samples.length === 24000, "WAV should have 24000 samples");
    assert(pcmData.sampleRate === 8000, "WAV should be 8000 Hz");
    
    const frames = await pipeline.extractFrameFeatures(pcmData);
    assert(frames.length === 376, "Should extract 376 frames");
    
    // 2. Windows Extraction
    console.log("2. Testing Window Construction...");
    const windows = pipeline.buildWindows(frames);
    assert(windows.length === 176, "Should construct 176 windows");
    assert(windows[0].tensor.length === 25 * 124, "Window tensor should be 25 * 124");
    
    // 3. ONNX Logit Parity
    console.log("3. Testing ONNX Logit Parity against Librosa/Python golden vectors...");
    const predictions = await pipeline.runInference(windows);
    assert(predictions.length === 176, "Should have 176 predictions");
    
    const refData = JSON.parse(fs.readFileSync('pipeline/wav_parity_reference.json', 'utf8'));
    assertClose(predictions[0].logits[0], refData.first_window_logits[0], 1e-3, "Logit 0 mismatch");
    assertClose(predictions[0].logits[1], refData.first_window_logits[1], 1e-3, "Logit 1 mismatch");
    assertClose(predictions[0].logits[2], refData.first_window_logits[2], 1e-3, "Logit 2 mismatch");
    assertClose(predictions[0].logits[3], refData.first_window_logits[3], 1e-3, "Logit 3 mismatch");
    
    const lastP = predictions[predictions.length - 1];
    assertClose(lastP.logits[0], refData.last_window_logits[0], 1e-3, "Last Logit 0 mismatch");
    
    // 4. Event Decoding (Synthetic override for regression)
    console.log("4. Testing Temporal Event Decoding...");
    const mockPredictions = [];
    // Inject 100 windows of Inhale
    for (let i = 0; i < 200; i++) {
        mockPredictions.push({
            windowIndex: i,
            predictedClass: (i >= 50 && i <= 150) ? 2 : 0,
            probabilities: [0.1, 0.1, 0.8, 0.0],
            startTime: i * 0.032,
            endTime: i * 0.032 + 0.4
        });
    }
    const events = pipeline.decodeEvents(mockPredictions, pcmData);
    assert(events.length === 1, "Should decode exactly 1 grouped event");
    assertClose(events[0].durationS, 3.6, 0.01, "Event duration should match group size");
    assertClose(events[0].detectorConfidence, 0.8, 0.01, "Mean confidence should match");
    
    // 5. Event Feature Extraction (Golden synthetic vector)
    console.log("5. Testing Localized Feature Extraction...");
    // 440Hz sine wave exactly 1 second
    const sinePcm = new Float32Array(8000);
    for (let i = 0; i < 8000; i++) {
        sinePcm[i] = Math.sin(2 * Math.PI * 440 * i / 8000) * 0.5;
    }
    const features = await pipeline.extractEventFeatures(sinePcm);
    assert(features.version === 'prism-inference-v2.0', "Schema version check");
    assertClose(features.mean_rms, 0.3535, 0.001, "Golden mean_rms for sine wave");
    assertClose(features.features[0], 0.1106, 0.001, "Golden centroid mean");
    
    // 6. Scoreability and Z-Scoring
    console.log("6. Testing V1 Scoreability Rules and Z-Scoring...");
    // Overlap events
    const e1 = { eventId: 0, startS: 1.0, endS: 1.8, durationS: 0.8 }; 
    const e2 = { eventId: 1, startS: 1.9, endS: 2.5, durationS: 0.6 }; 
    const scoreability = pipeline.checkScoreability(e1, [e1, e2], pcmData, features);
    assert(scoreability.isScoreable === false, "Should detect overlapping close neighbor");
    
    const dummyFeatures = {
        version: 'prism-inference-v2.0',
        features: new Float64Array([0.3705, 0.1322, 0.0394, 0.0807]), // exactly the median values
        mean_rms: 0.5
    };
    const scoring = await pipeline.scoreEvent(dummyFeatures);
    assertClose(scoring.anomalyScore, 0.0, 0.01, "Median features should score exactly 0");
    
    // 7. Session Aggregation
    console.log("7. Testing Session Aggregation...");
    const rec1 = { input: { recording_id: "rec_1" }, nEvents: 2, nScored: 1, events: [
        { eventId: 0, startTime: 1.0, status: 'SCORE_ONLY', anomalyScore: 2.0 },
        { eventId: 1, startTime: 2.0, status: 'NOT_SCOREABLE' }
    ]};
    const rec2 = { input: { recording_id: "rec_2" }, nEvents: 1, nScored: 1, events: [
        { eventId: 0, startTime: 5.0, status: 'SCORE_ONLY', anomalyScore: 1.0 }
    ]};
    const aggregator = new SessionAggregator();
    const sess = aggregator.aggregate("sess_golden", [rec1, rec2]);
    assert(sess.nEvents === 3, "Should aggregate 3 events");
    assert(sess.nScored === 2, "Should aggregate 2 scored events");
    assertClose(sess.aggregateScores.mean, 1.5, 0.01, "Golden mean session score");
    assertClose(sess.aggregateScores.min, 1.0, 0.01, "Golden min session score");
    assertClose(sess.aggregateScores.max, 2.0, 0.01, "Golden max session score");
    
    console.log("\n✅ ALL REGRESSION TESTS PASSED (100%)");
}

testHarness().catch(err => {
    console.error("❌ HARNESS FATAL ERROR:", err);
    process.exit(1);
});
