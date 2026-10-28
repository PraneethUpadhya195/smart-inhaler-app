import InferencePipeline from './InferencePipeline.js';

function createDummyWin(idx, start, end, pClass, pInhale) {
    const probs = new Float32Array(4);
    probs[2] = pInhale; // P(Inhale)
    return {
        windowIndex: idx,
        startTime: start,
        endTime: end,
        predictedClass: pClass,
        predictedLabel: pClass === 2 ? 'Inhale' : 'Noise',
        probabilities: probs,
        logits: new Float32Array(4)
    };
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function test() {
    console.log("Starting Stage 8 Decoder Test");
    
    const pipeline = new InferencePipeline();
    
    // Windows:
    // W0: 0.0s to 0.2s (Noise)
    // W1: 0.1s to 0.3s (Inhale) -> Event 0
    // W2: 0.2s to 0.4s (Inhale) -> Event 0 (0.2 <= 0.3)
    // W3: 0.35s to 0.55s (Inhale) -> Event 0 (0.35 <= 0.4)
    // W4: 0.6s to 0.8s (Inhale) -> Event 1 (0.6 > 0.55)
    // W5: 0.7s to 0.9s (Noise)
    
    const predictions = [
        createDummyWin(0, 0.0, 0.2, 3, 0.1),
        createDummyWin(1, 0.1, 0.3, 2, 0.8),
        createDummyWin(2, 0.2, 0.4, 2, 0.9),
        createDummyWin(3, 0.35, 0.55, 2, 0.7),
        createDummyWin(4, 0.6, 0.8, 2, 0.6),
        createDummyWin(5, 0.7, 0.9, 3, 0.2)
    ];
    
    const events = pipeline.decodeEvents(predictions, null);
    
    console.log(`Generated ${events.length} events.`);
    assert(events.length === 2, `Expected 2 events, got ${events.length}`);
    
    // Check Event 0
    const e0 = events[0];
    console.log("Event 0:");
    console.log(`  Windows: ${e0.windowPredictions.length} (Expected: 3)`);
    console.log(`  Start: ${e0.startS.toFixed(3)}s (Expected: 0.100s)`);
    console.log(`  End: ${e0.endS.toFixed(3)}s (Expected: 0.550s)`);
    console.log(`  Duration: ${e0.durationS.toFixed(3)}s (Expected: 0.450s)`);
    console.log(`  Mean Prob: ${e0.detectorConfidence.toFixed(3)} (Expected: 0.800)`);
    console.log(`  Max Prob: ${e0.detectorMaxConfidence.toFixed(3)} (Expected: 0.900)`);
    
    assert(e0.windowPredictions.length === 3, "E0 windows length mismatch");
    assert(e0.startS === 0.1, "E0 start mismatch");
    assert(e0.endS === 0.55, "E0 end mismatch");
    assert(Math.abs(e0.durationS - 0.45) < 1e-6, "E0 duration mismatch");
    assert(Math.abs(e0.detectorConfidence - 0.8) < 1e-6, "E0 mean prob mismatch");
    assert(Math.abs(e0.detectorMaxConfidence - 0.9) < 1e-6, "E0 max prob mismatch");
    assert(e0.eventId === 0, "E0 eventId mismatch");
    
    // Check Event 1
    const e1 = events[1];
    console.log("\nEvent 1:");
    console.log(`  Windows: ${e1.windowPredictions.length} (Expected: 1)`);
    console.log(`  Start: ${e1.startS.toFixed(3)}s (Expected: 0.600s)`);
    console.log(`  End: ${e1.endS.toFixed(3)}s (Expected: 0.800s)`);
    console.log(`  Duration: ${e1.durationS.toFixed(3)}s (Expected: 0.200s)`);
    
    assert(e1.windowPredictions.length === 1, "E1 windows length mismatch");
    assert(e1.startS === 0.6, "E1 start mismatch");
    assert(e1.endS === 0.8, "E1 end mismatch");
    assert(Math.abs(e1.durationS - 0.2) < 1e-6, "E1 duration mismatch");
    assert(e1.eventId === 1, "E1 eventId mismatch");
    
    console.log("\nSUCCESS: All decoder assertions passed!");
}

test();
