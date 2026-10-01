/**
 * pipeline/sources/WavPcmSource.js
 *
 * Reads a WAV file and produces PcmData for the inference pipeline.
 *
 * STATUS: STUB — actual WAV decoding will be implemented in Stage 3/4
 * when the DSP engine is built. The interface is defined now so that
 * the pipeline architecture is complete.
 *
 * Expected WAV format: 8 kHz, 16-bit signed LE, mono.
 * Conversion: float = int16 / 32768 (per inference contract §input.waveform)
 */

import PcmSource from "../PcmSource.js";

export default class WavPcmSource extends PcmSource {
  /**
   * @param {string} filePath - Path to the WAV file
   * @param {Object} [options]
   * @param {string} [options.inputDomain='unknown'] - 'reference_dataset' | 'prism_hardware' | 'unknown'
   */
  constructor(filePath, options = {}) {
    super("wav");
    /** @type {string} */
    this.filePath = filePath;
    /** @type {string} */
    this.inputDomain = options.inputDomain ?? "unknown";
  }

  /**
   * Read and decode the WAV file into PCM samples.
   *
   * @returns {Promise<import('../types').PcmData>}
   * @throws {Error} Always throws — not yet implemented
   */
  async acquire() {
    // TODO: Stage 3/4 — implement actual WAV decoding
    // Requirements from inference_contract_v2.json:
    //   - Sample rate must be exactly 8000 Hz (no resampling)
    //   - 16-bit LE PCM → float32 as sample / 32768
    //   - Mono expected; if stereo, average channels
    //   - No preprocessing: no normalization, filtering, gain, trimming, or padding
    throw new Error(
      "WavPcmSource.acquire() is not yet implemented. " +
      "WAV decoding will be added in Stage 3 (DSP Engine)."
    );
  }
}
