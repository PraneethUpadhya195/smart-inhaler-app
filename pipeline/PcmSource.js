/**
 * pipeline/PcmSource.js
 *
 * Abstract base class for all PCM audio sources.
 * Every source (simulation, WAV file, BLE) must extend this class
 * and implement the acquire() method.
 *
 * This abstraction ensures the rest of the pipeline never needs to know
 * whether audio came from a file, a simulated signal, or a Bluetooth device.
 */

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
   * Validate that the acquired PCM data meets the pipeline contract.
   *
   * @param {import('./types').PcmData} pcmData
   * @returns {{ valid: boolean, errors: string[] }}
   */
  static validate(pcmData) {
    const errors = [];

    if (!pcmData) {
      return { valid: false, errors: ["pcmData is null or undefined"] };
    }

    if (!(pcmData.samples instanceof Float32Array)) {
      errors.push("samples must be a Float32Array");
    }

    if (pcmData.sampleRate !== 8000) {
      errors.push(`sampleRate must be 8000, got ${pcmData.sampleRate}`);
    }

    if (pcmData.channels !== 1) {
      errors.push(`channels must be 1 (mono), got ${pcmData.channels}`);
    }

    if (pcmData.samples && pcmData.samples.length < 1536) {
      errors.push(
        `samples too short: ${pcmData.samples.length} < 1536 minimum`
      );
    }

    // Check for non-finite values
    if (pcmData.samples) {
      for (let i = 0; i < pcmData.samples.length; i++) {
        if (!isFinite(pcmData.samples[i])) {
          errors.push(`non-finite sample at index ${i}`);
          break; // One is enough to report
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
