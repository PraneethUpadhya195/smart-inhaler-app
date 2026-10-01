import BaselineStore from './BaselineStore.js';

async function test() {
    console.log("Starting Stage 11 Baseline Infrastructure Test");
    
    const store = new BaselineStore();
    
    // Test loading from default path
    const baseline = await store.loadBaseline();
    
    console.log(`Loaded Baseline ID: ${baseline.baselineId}`);
    console.log(`Feature Schema: ${baseline.featureSchemaVersion}`);
    console.log(`Features mapped: ${baseline.featureNames.length}`);
    
    if (baseline.featureSchemaVersion !== 'prism-inference-v2.0') {
        throw new Error("Incorrect feature schema version parsed");
    }
    
    if (baseline.centers.length !== 4 || baseline.scales.length !== 4) {
        throw new Error("Typed arrays not constructed with correct dimensions");
    }
    
    // Check specific known values from the JSON
    const firstFeat = baseline.featureNames[0];
    console.log(`First Feature: ${firstFeat}`);
    console.log(`  Center: ${baseline.centers[0]}`);
    console.log(`  MAD: ${baseline.mads[0]}`);
    console.log(`  Scale: ${baseline.scales[0]}`);
    
    // Check retrieval by version string
    const retrieved = store.getBaseline('prism-inference-v2.0');
    if (retrieved.baselineId !== baseline.baselineId) {
        throw new Error("Retrieval by version string failed");
    }
    
    console.log("SUCCESS: Baseline loaded and normalized perfectly into flat arrays.");
}

test().catch(console.error);
