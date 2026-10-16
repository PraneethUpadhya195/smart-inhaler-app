/**
 * pipeline/sources/BlePcmSource.js
 *
 * PcmData from a recording received from the PRISM recorder over BLE (services/ble/PrismRecorder.js):
 * int16 samples at 8000 Hz, already verified (sample count and CRC-32) before they get here.
 *
 * Conversion as for a WAV file (contract input.waveform; WavPcmSource): float32 = int16 / 32768,
 * so a BLE recording and the same samples saved as a 16-bit WAV give identical pipeline input.
 * input_domain is "prism_hardware": the frozen baseline and the Stage 9 reference were fitted on
 * the reference dataset and are not validated for this microphone (baseline_domain_validated false).
 */

import PcmSource from "../PcmSource.js";

export default class BlePcmSource extends PcmSource {
  /**
   * @param {Int16Array} pcm - verified samples
   * @param {Object} [options]
   * @param {number} [options.sampleRate=8000] - as reported by the device (other rates become the
   *   contract's INPUT_ERROR unsupported_sample_rate, never a resampled input)
   * @param {string|null} [options.sourceId] - recording_id
   * @param {string|Date|null} [options.recordedAt] - when the recording started (phone clock)
   */
  constructor(pcm, { sampleRate = 8000, sourceId = null, recordedAt = null } = {}) {
    super("ble");
    if (!(pcm instanceof Int16Array)) throw new TypeError("BlePcmSource expects the recording as an Int16Array");
    this.pcm = pcm;
    this.sampleRate = sampleRate;
    this.sourceId = sourceId;
    this.recordedAt = recordedAt;
    this.inputDomain = "prism_hardware";
  }

  /** @returns {Promise<import('../types').PcmData>} */
  async acquire() {
    const samples = new Float32Array(this.pcm.length);
    for (let i = 0; i < this.pcm.length; i++) samples[i] = this.pcm[i] / 32768;
    return {
      samples,
      sampleRate: this.sampleRate,
      channels: 1,
      sourceType: this.sourceType,
      sourceId: this.sourceId,
      recordedAt: this.recordedAt,
      inputDomain: this.inputDomain,
    };
  }
}
