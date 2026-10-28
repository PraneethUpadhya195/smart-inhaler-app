import InferencePipeline from './InferencePipeline.js';

async function test() {
    console.log("Starting Stage 12 Score Engine Test");
    
    const pipeline = new InferencePipeline();
    
    const pcmData = {
        sampleRate: 8000,
        samples: new Float32Array(80000) // 10 seconds
    };
    
    // Create dummy events
    const e1 = { eventId: 0, startS: 1.0, endS: 1.8, durationS: 0.8 }; // Valid
    const e2 = { eventId: 1, startS: 1.9, endS: 2.5, durationS: 0.6 }; // Close neighbor to e1 (gap 0.1)
    const e3 = { eventId: 2, startS: 4.0, endS: 4.3, durationS: 0.3 }; // Short duration
    const e4 = { eventId: 3, startS: 0.005, endS: 0.8, durationS: 0.795 }; // Boundary
    
    const allEvents = [e1, e2, e3, e4];
    
    const dummyFeatures = {
        version: 'prism-inference-v2.0',
        features: new Float64Array([0.3705, 0.1322, 0.0394, 0.0807]), // exactly the median values
        mean_rms: 0.5
    };
    
    console.log("Checking Scoreability constraints...");
    const s1 = pipeline.checkScoreability(e1, allEvents, pcmData, dummyFeatures);
    const s2 = pipeline.checkScoreability(e2, allEvents, pcmData, dummyFeatures);
    const s3 = pipeline.checkScoreability(e3, allEvents, pcmData, dummyFeatures);
    const s4 = pipeline.checkScoreability(e4, allEvents, pcmData, dummyFeatures);
    
    console.log(`e1 scoreable: ${s1.isScoreable} (Expected: false, due to e2 close neighbor)`);
    if (s1.isScoreable || !s1.reasons.includes('close_neighbor')) throw new Error("e1 failed check");
    
    console.log(`e2 scoreable: ${s2.isScoreable} (Expected: false, due to e1 close neighbor)`);
    if (s2.isScoreable || !s2.reasons.includes('close_neighbor')) throw new Error("e2 failed check");
    
    console.log(`e3 scoreable: ${s3.isScoreable} (Expected: false, due to short_duration)`);
    if (s3.isScoreable || !s3.reasons.includes('short_duration')) throw new Error("e3 failed check");
    
    console.log(`e4 scoreable: ${s4.isScoreable} (Expected: false, due to recording_boundary)`);
    if (s4.isScoreable || !s4.reasons.includes('recording_boundary')) throw new Error("e4 failed check");
    
    // Re-check e1 alone without neighbors
    const s1alone = pipeline.checkScoreability(e1, [e1], pcmData, dummyFeatures);
    console.log(`e1 standalone scoreable: ${s1alone.isScoreable} (Expected: true)`);
    if (!s1alone.isScoreable) throw new Error("e1 alone should be scoreable");
    
    console.log("\nCalculating Z-Scores (perfect median)...");
    const scoreRes = await pipeline.scoreEvent(dummyFeatures);
    console.log(`Anomaly Score: ${scoreRes.anomalyScore}`);
    
    if (Math.abs(scoreRes.anomalyScore - 0) > 0.01) {
        throw new Error("Score should be near 0 for median values");
    }
    
    console.log("\nCalculating Z-Scores (1 MAD offset)...");
    const offsetFeats = {
        version: 'prism-inference-v2.0',
        features: new Float64Array([
            0.37053 + 0.027867, // center + scale
            0.13224 + 0.029707,
            0.03940 + 0.008977,
            0.08070 + 0.016905
        ]),
        mean_rms: 0.5
    };
    const scoreRes2 = await pipeline.scoreEvent(offsetFeats);
    console.log(`Anomaly Score: ${scoreRes2.anomalyScore}`);
    
    if (Math.abs(scoreRes2.anomalyScore - 1.0) > 0.01) {
        throw new Error("Score should be near 1.0 for exactly 1 scale deviation in all features");
    }
    
    console.log("\nSUCCESS: Scoreability constraints and Anomaly math verified.");
}

test().catch(console.error);
