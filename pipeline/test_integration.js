import InferencePipeline from './InferencePipeline.js';
import SimulatedPcmSource from './sources/SimulatedPcmSource.js';

async function testIntegration() {
    console.log("Starting Stage 6 DSP -> ONNX Integration Test");
    
    const pipeline = new InferencePipeline();
    // 0.5s of audio @ 8000Hz = 4000 samples
    const source = new SimulatedPcmSource({ durationS: 0.5, pattern: 'sine' });
    
    console.log("\n[1/4] Acquiring PCM...");
    const pcmData = await source.acquire();
    console.log(`PCM length: ${pcmData.samples.length} samples (${pcmData.samples.length / pcmData.sampleRate}s)`);
    
    console.log("\n[2/4] Extracting Frame Features (DSP)...");
    const frameFeatures = await pipeline.extractFrameFeatures(pcmData);
    console.log(`Generated ${frameFeatures.length} frames.`);
    if (frameFeatures.length > 0) {
        console.log(`First frame feature vector length: ${frameFeatures[0].features.length}`);
    }
    
    console.log("\n[3/4] Building CNN Windows...");
    const windows = pipeline.buildWindows(frameFeatures);
    console.log(`Generated ${windows.length} windows.`);
    if (windows.length > 0) {
        console.log(`First window tensor length: ${windows[0].tensor.length}`);
    }
    
    console.log("\n[4/4] Executing ONNX Inference...");
    const predictions = await pipeline.runInference(windows);
    console.log(`Received ${predictions.length} predictions.`);
    
    if (predictions.length > 0) {
        console.log("\nPrediction 0 (First window):");
        console.log(`Window Index: ${predictions[0].windowIndex}`);
        console.log(`Time span: ${predictions[0].startTime.toFixed(3)}s to ${predictions[0].endTime.toFixed(3)}s`);
        console.log(`Logits:`, predictions[0].logits);
        console.log(`Probabilities:`, predictions[0].probabilities);
        console.log(`Predicted Class: ${predictions[0].predictedClass} (${predictions[0].predictedLabel})`);
        
        console.log("\nPrediction 1 (Second window):");
        console.log(`Logits:`, predictions[1].logits);
        console.log(`Predicted Class: ${predictions[1].predictedClass} (${predictions[1].predictedLabel})`);
    }
    
    console.log("\nSUCCESS: End-to-end feature extraction and inference executed without errors.");
}

testIntegration().catch(err => {
    console.error("Test failed:", err);
});
