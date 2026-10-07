/**
 * pipeline/OnnxDetector.js
 *
 * The CNN event detector (assets/ml/inhaler_cnn.onnx) behind one small interface, independent
 * of the ONNX Runtime package. The platform supplies the runtime module and the model bytes:
 *   - Node (tests, parity tools): onnxruntime-node      → pipeline/runtime/node.js
 *   - React Native (the app):     onnxruntime-react-native → pipeline/runtime/reactNative.js
 * Both packages expose the same InferenceSession / Tensor API (onnxruntime-common).
 *
 * The model bytes are hashed and must equal the contract's model_sha256 before a session is
 * created; the verified hash is what the output reports as detector_model_sha256.
 */

import { sha256Hex } from "./sha256.js";
import { MODEL_SHA256, PIPELINE_CONFIG } from "./versions.js";

const WINDOW_SIZE = PIPELINE_CONFIG.windowSize; // 25 frames
const FEATURE_DIM = PIPELINE_CONFIG.featureDim; // 124
const N_CLASSES = PIPELINE_CONFIG.nClasses; // 4

export class ModelLoadError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelLoadError";
  }
}

export default class OnnxDetector {
  /**
   * @param {Object} ort - onnxruntime module (InferenceSession, Tensor)
   * @param {Object} session - InferenceSession
   * @param {string} modelSha256 - verified SHA-256 of the model bytes
   */
  constructor(ort, session, modelSha256) {
    this.ort = ort;
    this.session = session;
    this.modelSha256 = modelSha256;
    this.inputName = session.inputNames[0];
    this.outputName = session.outputNames[0];
  }

  /**
   * Verify the model bytes against the contract and create an inference session.
   * @param {Object} ort - onnxruntime-node or onnxruntime-react-native
   * @param {Uint8Array} modelBytes
   * @returns {Promise<OnnxDetector>}
   */
  static async create(ort, modelBytes) {
    const sha = sha256Hex(modelBytes);
    if (sha !== MODEL_SHA256) {
      throw new ModelLoadError(`model SHA-256 ${sha} does not match the contract's ${MODEL_SHA256}`);
    }
    let session;
    try {
      session = await ort.InferenceSession.create(modelBytes);
    } catch (e) {
      throw new ModelLoadError(`ONNX Runtime could not load the model: ${e?.message ?? e}`);
    }
    if (session.inputNames.length !== 1 || session.outputNames.length !== 1) {
      throw new ModelLoadError("expected exactly one ONNX input and one output");
    }
    return new OnnxDetector(ort, session, sha);
  }

  /**
   * Raw logits for one window (input [1, 25, 124] float32 → output [1, 4] float32).
   * @param {Float32Array} windowTensor - 25 × 124 values, frame-major
   * @returns {Promise<Float32Array>} 4 logits in the contract class order
   */
  async logits(windowTensor) {
    const tensor = new this.ort.Tensor("float32", windowTensor, [1, WINDOW_SIZE, FEATURE_DIM]);
    const results = await this.session.run({ [this.inputName]: tensor });
    const data = results[this.outputName].data;
    if (data.length !== N_CLASSES) throw new Error(`expected ${N_CLASSES} logits, got ${data.length}`);
    return Float32Array.from(data);
  }
}
