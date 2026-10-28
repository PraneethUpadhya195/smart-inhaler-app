import InferencePipeline from './InferencePipeline.js';

function test() {
    console.log("Starting Stage 9 Event Extraction Test");
    
    const pipeline = new InferencePipeline();
    
    // Create dummy PCM data: 1 second @ 8000Hz = 8000 samples
    const pcmData = {
        sampleRate: 8000,
        samples: new Float32Array(8000)
    };
    
    // Fill with values equal to index to verify correct slicing
    for (let i = 0; i < 8000; i++) {
        pcmData.samples[i] = i;
    }
    
    // Dummy event 0.1s to 0.5s -> samples 800 to 4000
    const event = {
        startS: 0.1,
        endS: 0.5
    };
    
    const pcmSlice = pipeline.extractEventPcm(event, pcmData);
    
    console.log(`Extracted ${pcmSlice.length} samples.`);
    if (pcmSlice.length !== 3200) {
        throw new Error(`Expected 3200 samples, got ${pcmSlice.length}`);
    }
    
    if (pcmSlice[0] !== 800) {
        throw new Error(`Expected first sample to be 800, got ${pcmSlice[0]}`);
    }
    
    if (pcmSlice[pcmSlice.length - 1] !== 3999) {
        throw new Error(`Expected last sample to be 3999, got ${pcmSlice[pcmSlice.length - 1]}`);
    }
    
    console.log("Testing out of bounds clamping...");
    const badEvent = {
        startS: -0.1,
        endS: 1.5
    };
    const badSlice = pipeline.extractEventPcm(badEvent, pcmData);
    if (badSlice.length !== 8000) {
        throw new Error(`Expected clamped slice to be 8000, got ${badSlice.length}`);
    }
    
    console.log("SUCCESS: Event PCM accurately extracted!");
}

test();
