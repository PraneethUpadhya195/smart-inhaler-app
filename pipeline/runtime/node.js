/**
 * pipeline/runtime/node.js
 *
 * Node.js wiring of the inference pipeline (tests, parity tools, offline runs).
 * NOT for the React Native app: it imports onnxruntime-node and node:fs. App code must use
 * pipeline/runtime/reactNative.js instead, so neither package enters the Metro bundle.
 */

import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-node";
import InferencePipeline from "../InferencePipeline.js";
import OnnxDetector from "../OnnxDetector.js";

/** Model path resolved from this file, not from the working directory. */
export const MODEL_URL = new URL("../../assets/ml/inhaler_cnn.onnx", import.meta.url);

let detectorPromise = null;

/** @returns {Promise<OnnxDetector>} one shared, verified detector per process */
export function createNodeDetector() {
  if (!detectorPromise) {
    detectorPromise = OnnxDetector.create(ort, new Uint8Array(readFileSync(MODEL_URL)));
    detectorPromise.catch(() => { detectorPromise = null; });
  }
  return detectorPromise;
}

/**
 * @param {Object} [options] - passed to the InferencePipeline constructor (e.g. a baseline)
 * @returns {Promise<InferencePipeline>}
 */
export async function createNodePipeline(options = {}) {
  return new InferencePipeline({ ...options, detector: await createNodeDetector() });
}
