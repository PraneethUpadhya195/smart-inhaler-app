import { InferenceSession, Tensor } from "onnxruntime-node";
import fs from "fs";

async function test() {
  try {
    const modelPath = "./assets/ml/inhaler_cnn.onnx";
    console.log(`Loading model from: ${modelPath}`);
    
    // Check if file exists
    if (!fs.existsSync(modelPath)) {
      throw new Error(`Model file not found at ${modelPath}`);
    }

    const session = await InferenceSession.create(modelPath);
    console.log("Model loaded successfully.");
    console.log("Input names:", session.inputNames);
    console.log("Output names:", session.outputNames);

    // Construct a deterministic [1, 25, 124] float32 tensor (all zeros)
    // 1 * 25 * 124 = 3100 elements
    const float32Data = new Float32Array(3100);
    
    // Fill with deterministic values (e.g., small numbers) to see valid logits
    for (let i = 0; i < float32Data.length; i++) {
      float32Data[i] = (i % 124) * 0.01;
    }

    // "features" is the expected input name based on inference_contract_v2.json
    const inputName = session.inputNames[0]; // Should be "features"
    const tensor = new Tensor("float32", float32Data, [1, 25, 124]);
    
    console.log(`Executing inference with input tensor shape: [${tensor.dims}]`);
    
    const feeds = {};
    feeds[inputName] = tensor;

    const results = await session.run(feeds);
    
    const outputName = session.outputNames[0];
    const outputTensor = results[outputName];
    
    console.log(`Inference successful.`);
    console.log(`Output shape: [${outputTensor.dims}]`);
    console.log(`Output dtype: ${outputTensor.type}`);
    
    const logits = outputTensor.data;
    console.log(`Logits:`, logits);

    // Apply Softmax to get probabilities
    let maxLogit = -Infinity;
    for (let i = 0; i < logits.length; i++) {
      if (logits[i] > maxLogit) maxLogit = logits[i];
    }
    
    let sumExp = 0;
    const probs = new Float32Array(logits.length);
    for (let i = 0; i < logits.length; i++) {
      probs[i] = Math.exp(logits[i] - maxLogit);
      sumExp += probs[i];
    }
    
    let predictedClass = -1;
    let maxProb = -1;
    for (let i = 0; i < logits.length; i++) {
      probs[i] /= sumExp;
      if (probs[i] > maxProb) {
        maxProb = probs[i];
        predictedClass = i;
      }
    }
    
    const classOrder = ["Drug", "Exhale", "Inhale", "Noise"];
    console.log(`Probabilities:`, probs);
    console.log(`Predicted class: ${predictedClass} (${classOrder[predictedClass]})`);

  } catch (error) {
    console.error("Test failed:", error);
  }
}

test();
