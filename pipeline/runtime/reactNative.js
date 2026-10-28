/**
 * pipeline/runtime/reactNative.js
 *
 * React Native wiring of the inference pipeline (the app). Metro-only: it uses
 * onnxruntime-react-native (a native module, so it needs a development build, not Expo Go),
 * expo-asset and expo-file-system. Node tests use pipeline/runtime/node.js instead.
 *
 * The model (assets/ml/inhaler_cnn.onnx, bundled as a Metro asset: metro.config.js adds the
 * "onnx" extension) is resolved to a local file with expo-asset, read as bytes, verified
 * against the contract's SHA-256 (OnnxDetector.create) and loaded from the bytes.
 */

import * as ort from "onnxruntime-react-native";
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import InferencePipeline from "../InferencePipeline.js";
import OnnxDetector from "../OnnxDetector.js";

// eslint-disable-next-line no-undef -- Metro asset reference (resolved at bundle time)
const MODEL_ASSET = require("../../assets/ml/inhaler_cnn.onnx");

/** @returns {Promise<Uint8Array>} the bundled model file's bytes */
export async function loadModelBytes() {
  const asset = Asset.fromModule(MODEL_ASSET);
  await asset.downloadAsync(); // dev builds fetch it from Metro; release builds copy it out of the APK
  const uri = asset.localUri ?? asset.uri;
  if (!uri) throw new Error("model asset has no local URI");
  return new Uint8Array(await new File(uri).arrayBuffer());
}

let detectorPromise = null;

/** @returns {Promise<OnnxDetector>} one shared, verified detector per app process */
export function createReactNativeDetector() {
  if (!detectorPromise) {
    detectorPromise = loadModelBytes().then((bytes) => OnnxDetector.create(ort, bytes));
    detectorPromise.catch(() => { detectorPromise = null; }); // allow a retry after a failure
  }
  return detectorPromise;
}

/**
 * @param {Object} [options] - passed to the InferencePipeline constructor
 * @returns {Promise<InferencePipeline>}
 */
export async function createReactNativePipeline(options = {}) {
  return new InferencePipeline({ ...options, detector: await createReactNativeDetector() });
}
