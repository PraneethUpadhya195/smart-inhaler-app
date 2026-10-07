/**
 * pipeline/PcmSource.js
 *
 * Abstract base class for all PCM audio sources.
 * Every source (simulation, WAV file, BLE) must extend this class
 * and implement the acquire() method.
 *
 * This abstraction ensures the rest of the pipeline never needs to know
 * whether audio came from a file, a simulated signal, or a Bluetooth device.
 *
 * acquire() must resolve to PcmData: mono float32 samples, sampleRate, channels = 1,
 * sourceType, sourceId (recording_id or null), recordedAt (ISO 8601 / Date / null) and
 * inputDomain ('reference_dataset' | 'prism_hardware' | 'unknown').
 */

import { checkInput } from "./contract.js";

/**
 * @abstract
 */
export default class PcmSource {
  /**
   * @param {string} sourceType - 'simulation' | 'wav' | 'ble'
   */
  constructor(sourceType) {
    if (new.target === PcmSource) {
      throw new Error("PcmSource is abstract — use a concrete subclass.");
    }
    /** @type {string} */
    this.sourceType = sourceType;
  }

  /**
   * Acquire PCM audio data from this source.
   * Subclasses must implement this method.
   *
   * @abstract
   * @returns {Promise<import('./types').PcmData>}
   */
  async acquire() {
    throw new Error("acquire() must be implemented by subclass.");
  }

  /**
   * @returns {string} The source type identifier
   */
  getSourceType() {
    return this.sourceType;
  }

  /**
   * Validate that the acquired PCM data meets the inference contract's input rules.
   * Same check as InferencePipeline.run() (contract.checkInput / prism_inference.check_input).
   *
   * @param {import('./types').PcmData} pcmData
   * @returns {{ valid: boolean, errors: string[] }} errors holds the contract INPUT_ERROR code
   */
  static validate(pcmData) {
    if (!pcmData) {
      return { valid: false, errors: ["invalid_shape"] };
    }
    const { error } = checkInput(pcmData);
    return { valid: error === null, errors: error === null ? [] : [error] };
  }
}
