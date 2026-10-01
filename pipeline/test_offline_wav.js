import fs from 'fs';
import InferencePipeline from './InferencePipeline.js';
import WavPcmSource from './sources/WavPcmSource.js';

function computeMAE(arr1, arr2) {
    if (arr1.length !== arr2.length) return Infinity;
    let sum = 0;
    for (let i = 0; i < arr1.length; i++) {
        sum += Math.abs(arr1[i] - arr2[i]);
    }
    return sum / arr1.length;
}

async function testWavParity() {
    console.log("Starting Stage 7 Offline WAV End-to-End Validation");
    
    const refData = JSON.parse(fs.readFileSync('pipeline/wav_parity_reference.json', 'utf8'));
    
    const pipeline = new InferencePipeline();
    const source = new WavPcmSource('assets/ml/v2_validation/golden/inputs/white_noise_3s_minus20dBFS.wav');
    
    const pcmData = await source.acquire();
    const frameFeatures = await pipeline.extractFrameFeatures(pcmData);
    console.log(`JS frames: ${frameFeatures.length} (Expected: ${refData.frames_count})`);
    
    const windows = pipeline.buildWindows(frameFeatures);
    console.log(`JS windows: ${windows.length} (Expected: ${refData.windows_count})`);
    
    const predictions = await pipeline.runInference(windows);
    console.log(`JS predictions: ${predictions.length} (Expected: ${refData.windows_count})`);
    
    if (predictions.length > 0) {
        const jsFirstLogits = predictions[0].logits;
        const jsLastLogits = predictions[predictions.length - 1].logits;
        
        const firstMae = computeMAE(jsFirstLogits, refData.first_window_logits);
        const lastMae = computeMAE(jsLastLogits, refData.last_window_logits);
        
        console.log(`\nFirst window logits MAE: ${firstMae}`);
        console.log(`Last window logits MAE: ${lastMae}`);
        
        if (firstMae < 0.001 && lastMae < 0.001) {
            console.log("\nSUCCESS: End-to-end WAV validation achieved MAE < 0.001!");
        } else {
            console.error("\nFAILED: End-to-end WAV validation failed MAE < 0.001 requirement.");
            console.error("Expected first logits:", refData.first_window_logits);
            console.error("Actual first logits:", jsFirstLogits);
        }
    }
}

testWavParity().catch(console.error);
