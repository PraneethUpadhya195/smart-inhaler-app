/**
 * pipeline/sources/SimulatedPcmSource.js
 *
 * Generates synthetic PCM data for development and testing.
 * Produces valid Float32Array audio at 8 kHz mono.
 *
 * This source allows the full pipeline to run without hardware or WAV files.
 * The generated signal is NOT realistic inhalation audio — it exists only
 * to exercise the pipeline interfaces and verify data flow.
 *
 * For realistic testing, use WavPcmSource with actual recordings.
 */

import PcmSource from "../PcmSource.js";
import { PIPELINE_CONFIG } from "../versions.js";

export default class SimulatedPcmSource extends PcmSource {
  /**
   * @param {Object} [options]
   * @param {number} [options.durationS=5.0] - Duration in seconds
   * @param {'silence'|'tone'|'noise'|'mixed'} [options.pattern='mixed'] - Signal pattern
   * @param {number} [options.toneFrequency=440] - Frequency for tone pattern (Hz)
   * @param {number} [options.amplitude=0.5] - Amplitude [0, 1]
   * @param {string|null} [options.sourceId=null] - Optional identifier
   */
  constructor(options = {}) {
    super("simulation");
    this.durationS = options.durationS ?? 5.0;
    this.pattern = options.pattern ?? "mixed";
    this.toneFrequency = options.toneFrequency ?? 440;
    this.amplitude = options.amplitude ?? 0.5;
    this.sourceId = options.sourceId ?? null;
  }

  /**
   * Generate synthetic PCM audio.
   *
   * Pattern types:
   * - 'silence': all zeros (good for edge-case testing)
   * - 'tone': pure sine wave (deterministic, good for parity checks)
   * - 'noise': pseudo-random noise (exercises full feature range)
   * - 'mixed': silence → tone → noise → silence (simulates a session)
   *
   * @returns {Promise<import('../types').PcmData>}
   */
  async acquire() {
    const sampleRate = PIPELINE_CONFIG.sampleRate;
    const totalSamples = Math.floor(this.durationS * sampleRate);
    const samples = new Float32Array(totalSamples);

    switch (this.pattern) {
      case "silence":
        // Already zeros
        break;

      case "tone":
        this._fillTone(samples, 0, totalSamples, this.toneFrequency, this.amplitude);
        break;

      case "noise":
        this._fillNoise(samples, 0, totalSamples, this.amplitude);
        break;

      case "mixed":
      default:
        this._fillMixed(samples, totalSamples);
        break;
    }

    return {
      samples,
      sampleRate,
      channels: 1,
      sourceType: this.sourceType,
      sourceId: this.sourceId ?? `simulated_${this.pattern}_${this.durationS}s`,
      recordedAt: new Date(),
    };
  }

  // ─── Signal generators ─────────────────────────────────────────────────────

  /**
   * Fill a region with a pure sine wave.
   * @param {Float32Array} samples
   * @param {number} start - Start index
   * @param {number} end - End index (exclusive)
   * @param {number} frequency - Frequency in Hz
   * @param {number} amplitude - Amplitude [0, 1]
   */
  _fillTone(samples, start, end, frequency, amplitude) {
    const sampleRate = PIPELINE_CONFIG.sampleRate;
    for (let i = start; i < end; i++) {
      samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
    }
  }

  /**
   * Fill a region with deterministic pseudo-random noise.
   * Uses a simple linear congruential generator for reproducibility.
   * @param {Float32Array} samples
   * @param {number} start
   * @param {number} end
   * @param {number} amplitude
   */
  _fillNoise(samples, start, end, amplitude) {
    let seed = 42;
    for (let i = start; i < end; i++) {
      // Simple LCG (reproducible across runs)
      seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
      samples[i] = amplitude * ((seed / 0x7fffffff) * 2 - 1);
    }
  }

  /**
   * Fill with a mixed pattern: silence → tone → noise → silence.
   * Simulates a rough session shape without claiming to be realistic audio.
   * @param {Float32Array} samples
   * @param {number} totalSamples
   */
  _fillMixed(samples, totalSamples) {
    const quarter = Math.floor(totalSamples / 4);

    // Q1: silence (already zeros)
    // Q2: tone (simulates some sustained sound)
    this._fillTone(samples, quarter, 2 * quarter, this.toneFrequency, this.amplitude);
    // Q3: noise (simulates broadband activity)
    this._fillNoise(samples, 2 * quarter, 3 * quarter, this.amplitude * 0.3);
    // Q4: silence (already zeros)
  }
}
