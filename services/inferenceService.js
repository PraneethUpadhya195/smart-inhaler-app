import { createReactNativePipeline } from '../pipeline/runtime/reactNative';

/**
 * inferenceService.js — the app's single inference pipeline (React Native runtime).
 *
 * The pipeline is created once: the ONNX model is loaded from the bundled asset, its SHA-256 is
 * verified against the contract, and the frozen V2 baseline is validated on first use.
 */

let pipelinePromise = null;

/** @returns {Promise<import('../pipeline/InferencePipeline').default>} */
export function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = createReactNativePipeline();
    pipelinePromise.catch(() => { pipelinePromise = null; }); // allow a retry
  }
  return pipelinePromise;
}
