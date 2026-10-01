import fs from 'fs';
import { DspEngine } from './dsp.js';

function computeMAE(arr1, arr2) {
    if (arr1.length !== arr2.length) return Infinity;
    let sum = 0;
    for (let i = 0; i < arr1.length; i++) {
        sum += Math.abs(arr1[i] - arr2[i]);
    }
    return sum / arr1.length;
}

function testParity() {
    console.log("Loading parity data...");
    const data = JSON.parse(fs.readFileSync('pipeline/parity_data.json', 'utf8'));
    const pcm = new Float32Array(data.pcm);
    const ref = data.features;
    
    console.log(`Processing ${pcm.length} samples in DspEngine...`);
    const engine = new DspEngine();
    const frames = engine.processPcm(pcm);
    
    const numFrames = frames.length;
    console.log(`Generated ${numFrames} frames.`);
    
    let maxMae = 0;
    const errors = {
        mfcc: 0, delta: 0, delta2: 0,
        centroid: 0, flatness: 0, rolloff: 0, zcr: 0
    };
    
    for (let i = 0; i < numFrames; i++) {
        // Expected
        const expectedMfcc = ref.mfcc[i];
        const expectedDelta = ref.delta[i];
        const expectedDelta2 = ref.delta2[i];
        const expectedCentroid = ref.centroid[i];
        const expectedFlatness = ref.flatness[i];
        const expectedRolloff = ref.rolloff[i];
        const expectedZcr = ref.zcr[i];
        
        // Actual
        const features = frames[i].features;
        const actualMfcc = features.subarray(0, 40);
        const actualDelta = features.subarray(40, 80);
        const actualDelta2 = features.subarray(80, 120);
        
        const actualCentroid = features[120];
        const actualFlatness = features[121];
        const actualRolloff = features[122];
        const actualZcr = features[123];
        
        errors.mfcc = Math.max(errors.mfcc, computeMAE(expectedMfcc, actualMfcc));
        errors.delta = Math.max(errors.delta, computeMAE(expectedDelta, actualDelta));
        errors.delta2 = Math.max(errors.delta2, computeMAE(expectedDelta2, actualDelta2));
        errors.centroid = Math.max(errors.centroid, Math.abs(expectedCentroid - actualCentroid));
        errors.flatness = Math.max(errors.flatness, Math.abs(expectedFlatness - actualFlatness));
        errors.rolloff = Math.max(errors.rolloff, Math.abs(expectedRolloff - actualRolloff));
        errors.zcr = Math.max(errors.zcr, Math.abs(expectedZcr - actualZcr));
    }
    
    const totalMax = Math.max(...Object.values(errors));
    console.log("Maximum Absolute Errors per dimension group:");
    console.log(errors);
    console.log(`Overall Max MAE: ${totalMax}`);
    
    if (totalMax < 0.001) {
        console.log("SUCCESS: Mobile DSP Parity achieved! MAE < 0.001");
    } else {
        console.error("FAILED: Parity failed. MAE >= 0.001.");
    }
}

testParity();
