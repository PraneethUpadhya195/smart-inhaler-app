import FFT from 'fft.js';
import { PIPELINE_CONFIG } from './versions.js';
import { DSP_CONSTANTS } from './dsp_constants.js';

/**
 * Mobile DSP Engine.
 * 
 * Extracts exactly 124-dimensional features from PCM audio, perfectly
 * mimicking the librosa-based Python reference implementation:
 * 
 * 40 MFCC | 40 delta | 40 delta-delta | centroid/4000 | flatness | rolloff(0.85)/4000 | ZCR
 */

/**
 * |z| of a complex64 value exactly as numpy 2.x computes np.abs on complex64 in the research
 * environment (numpy 2.4.6, x86-64 with FMA3; SIMD kernel simd_cabsolute_f32):
 *   larger * sqrt(fma(r, r, 1)) with r = smaller / larger, every step rounded to float32.
 * This is not a correctly rounded hypot; it differs from float32(hypot(re, im)) by one ulp in
 * about 45% of bins, enough to flip a rolloff bin (F15). Verified bit-identical with
 * np.abs(librosa.stft(...)) on 589,143 magnitudes of three reference recordings.
 * @param {number} re - float32 value
 * @param {number} im - float32 value
 * @returns {number} float32 value
 */
function complex64Abs(re, im) {
  const a = Math.abs(re);
  const b = Math.abs(im);
  if (a === Infinity || b === Infinity) return Infinity;
  const larger = Math.max(a, b);
  const smaller = Math.min(a, b);
  if (larger === 0) return 0;
  const ratio = Math.fround(smaller / larger);
  return Math.fround(Math.fround(Math.sqrt(Math.fround(ratio * ratio + 1))) * larger);
}

/**
 * |STFT| of one frame as librosa 0.11 computes it (librosa.stft, then np.abs):
 * the frame is multiplied by the float64 Hann window in float64, transformed in float64, and
 * stored as complex64, so re and im are rounded to float32; the magnitude is numpy's complex64
 * absolute value (complex64Abs) and the power (librosa `S**2`) is its float32 square.
 * @param {FFT} fft - fft.js instance for nFft
 * @param {Float32Array} padded - centre-padded signal
 * @param {number} start - first sample of the frame in `padded`
 * @param {ArrayLike<number>} window - Hann window (float64), length nFft
 * @returns {{ mag: Float32Array, power: Float32Array }} nFft / 2 + 1 bins each
 */
export function frameSpectrum(fft, padded, start, window) {
  const nFft = window.length;
  const frame = new Float64Array(nFft);
  for (let j = 0; j < nFft; j++) frame[j] = padded[start + j] * window[j];
  const out = fft.createComplexArray();
  fft.realTransform(out, frame);
  const numBins = nFft / 2 + 1;
  const mag = new Float32Array(numBins);
  const power = new Float32Array(numBins);
  for (let k = 0; k < numBins; k++) {
    const m = complex64Abs(Math.fround(out[2 * k]), Math.fround(out[2 * k + 1]));
    mag[k] = m;
    power[k] = Math.fround(m * m);
  }
  return { mag, power };
}

/**
 * Spectral rolloff frequency as librosa.feature.spectral_rolloff: the lowest bin frequency at
 * which the cumulative magnitude reaches roll_percent of the total. librosa accumulates in
 * float32 (np.cumsum of a float32 spectrogram) and forms the threshold in float32, so this does
 * too: the bin can flip when the float64 sum lands on the other side of the threshold (F15).
 * @param {Float32Array} mag
 * @param {ArrayLike<number>} freqs - bin frequencies (Hz)
 * @param {number} rollPercent - 0.85
 * @returns {number} frequency in Hz (NaN if the spectrum is not finite)
 */
export function rolloffFrequency(mag, freqs, rollPercent) {
  let total = 0;
  for (let k = 0; k < mag.length; k++) total = Math.fround(total + mag[k]);
  const threshold = Math.fround(Math.fround(rollPercent) * total);
  let cumsum = 0;
  for (let k = 0; k < mag.length; k++) {
    cumsum = Math.fround(cumsum + mag[k]);
    if (cumsum >= threshold) return freqs[k];
  }
  return NaN;
}

export class DspEngine {
  constructor() {
    this.n_fft = PIPELINE_CONFIG.nFft;
    this.hop = PIPELINE_CONFIG.hopLength;
    this.sr = PIPELINE_CONFIG.sampleRate;
    
    // Initialize FFT
    this.fft = new FFT(this.n_fft);
    this.complexArray = this.fft.createComplexArray();
    
    // Constants from JSON
    this.mel_basis = DSP_CONSTANTS.mel_basis;
    this.dct_basis = DSP_CONSTANTS.dct_basis;
    this.delta_1 = DSP_CONSTANTS.delta_1;
    this.delta_2 = DSP_CONSTANTS.delta_2;
    this.edge_start_1 = DSP_CONSTANTS.edge_start_1;
    this.edge_end_1 = DSP_CONSTANTS.edge_end_1;
    this.edge_start_2 = DSP_CONSTANTS.edge_start_2;
    this.edge_end_2 = DSP_CONSTANTS.edge_end_2;
    this.hann_window = DSP_CONSTANTS.hann_window;
    this.fft_freqs = DSP_CONSTANTS.fft_frequencies;
  }

  /**
   * Main entry point: Process a full Float32Array PCM recording.
   * @param {Float32Array} pcm
   * @returns {import('./types').FrameFeatures[]}
   */
  processPcm(pcm) {
    // 1. STFT (Constant zero-padding, center=True)
    const pad = Math.floor(this.n_fft / 2);
    const paddedLen = pcm.length + 2 * pad;
    const paddedPcm = new Float32Array(paddedLen);
    paddedPcm.set(pcm, pad); // zero padded sides

    const numFrames = 1 + Math.floor((paddedLen - this.n_fft) / this.hop);
    
    // Feature matrices
    const magnitudes = new Array(numFrames);
    const powerSpectra = new Array(numFrames);
    const mels = new Array(numFrames);
    const mfccs = new Array(numFrames);
    
    const centroids = new Float32Array(numFrames);
    const flatnesses = new Float32Array(numFrames);
    const rolloffs = new Float32Array(numFrames);
    
    // We compute max mel power globally for power_to_db
    let max_mel_power = 1e-10;

    // A. Frame-wise loop
    for (let i = 0; i < numFrames; i++) {
      const start = i * this.hop;
      
      // Hann-windowed frame → |STFT| and power, as librosa computes them
      const { mag, power } = frameSpectrum(this.fft, paddedPcm, start, this.hann_window);
      const numBins = mag.length;
      let sumMag = 0;
      for (let k = 0; k < numBins; k++) sumMag += mag[k];
      
      magnitudes[i] = mag;
      powerSpectra[i] = power;
      
      // Spectral Centroid
      let num = 0;
      for (let k = 0; k < numBins; k++) {
        num += this.fft_freqs[k] * mag[k];
      }
      centroids[i] = (sumMag > 0 ? num / sumMag : 0) / 4000.0;
      
      // Spectral Flatness
      let sumLog = 0;
      let sumPower = 0;
      for (let k = 0; k < numBins; k++) {
        const p = Math.max(power[k], 1e-10);
        sumLog += Math.log(p);
        sumPower += p;
      }
      const geoMean = Math.exp(sumLog / numBins);
      const arithMean = sumPower / numBins;
      flatnesses[i] = arithMean > 0 ? geoMean / arithMean : 0;
      
      // Spectral Rolloff (0.85), float32 accumulation as librosa
      rolloffs[i] = rolloffFrequency(mag, this.fft_freqs, PIPELINE_CONFIG.rolloffPercent) / 4000.0;
      
      // Mel Filterbank
      const n_mels = this.mel_basis.length;
      const mel = new Float32Array(n_mels);
      for (let m = 0; m < n_mels; m++) {
        let sumMel = 0;
        for (let k = 0; k < numBins; k++) {
          sumMel += this.mel_basis[m][k] * power[k];
        }
        mel[m] = sumMel;
        if (sumMel > max_mel_power) {
          max_mel_power = sumMel;
        }
      }
      mels[i] = mel;
    }
    
    // B. Power to DB & MFCCs
    const amin = 1e-10;
    const ref = 1.0;
    const top_db = 80.0;
    const log10 = Math.log(10);
    const max_db = 10.0 * Math.log(Math.max(amin, max_mel_power)) / log10;
    
    for (let i = 0; i < numFrames; i++) {
      const mel = mels[i];
      const db_mel = new Float32Array(mel.length);
      for (let m = 0; m < mel.length; m++) {
        let val = 10.0 * Math.log(Math.max(amin, mel[m])) / log10;
        val -= 10.0 * Math.log(Math.max(amin, ref)) / log10;
        db_mel[m] = Math.max(val, max_db - top_db);
      }
      
      // DCT
      const n_mfcc = this.dct_basis.length;
      const mfcc = new Float32Array(n_mfcc);
      for (let c = 0; c < n_mfcc; c++) {
        let sum = 0;
        for (let m = 0; m < mel.length; m++) {
          sum += this.dct_basis[c][m] * db_mel[m];
        }
        mfcc[c] = sum;
      }
      mfccs[i] = mfcc;
    }
    
    // C. Deltas
    const deltas = this._computeDeltas(mfccs, this.delta_1, this.edge_start_1, this.edge_end_1);
    const deltaDeltas = this._computeDeltas(mfccs, this.delta_2, this.edge_start_2, this.edge_end_2);
    
    // D. Zero Crossing Rate (frame 2048, hop 64, center=True)
    const zcrs = this._computeZCR(pcm, numFrames);
    
    // E. Assemble features
    const frames = [];
    for (let i = 0; i < numFrames; i++) {
      const feats = new Float32Array(124);
      let ptr = 0;
      
      // 40 MFCC
      for (let j = 0; j < 40; j++) feats[ptr++] = mfccs[i][j];
      
      // 40 delta
      for (let j = 0; j < 40; j++) feats[ptr++] = deltas[i][j];
      
      // 40 delta-delta
      for (let j = 0; j < 40; j++) feats[ptr++] = deltaDeltas[i][j];
      
      // spectral
      feats[ptr++] = centroids[i];
      feats[ptr++] = flatnesses[i];
      feats[ptr++] = rolloffs[i];
      
      // ZCR
      feats[ptr++] = zcrs[i];
      
      frames.push({
        features: feats,
        frameIndex: i,
        timestamp: i * this.hop / this.sr
      });
    }
    
    return frames;
  }
  
  /**
   * Compute Savitzky-Golay deltas matching scipy.signal.savgol_filter mode='interp'.
   * @param {Float32Array[]} data [numFrames][40]
   * @param {number[]} weights FIR filter weights (length 9)
   * @param {number[][]} edge_start Matrix [4][9] of boundary filters
   * @param {number[][]} edge_end Matrix [4][9] of boundary filters
   * @returns {Float32Array[]} [numFrames][40]
   */
  _computeDeltas(data, weights, edge_start, edge_end) {
    const numFrames = data.length;
    const numFeats = data[0].length;
    const halfWindow = Math.floor(weights.length / 2);
    const out = new Array(numFrames);
    
    for (let i = 0; i < numFrames; i++) {
      out[i] = new Float32Array(numFeats);
      
      let isStartEdge = (i < halfWindow);
      let isEndEdge = (i >= numFrames - halfWindow);
      
      for (let f = 0; f < numFeats; f++) {
        let sum = 0;
        if (isStartEdge) {
          // Multiply first 9 frames by edge_start[i]
          const edgeWeights = edge_start[i];
          for (let w = 0; w < 9; w++) {
            sum += data[w][f] * edgeWeights[w];
          }
        } else if (isEndEdge) {
          // Multiply last 9 frames by edge_end[i - (numFrames - halfWindow)]
          const row = i - (numFrames - halfWindow);
          const edgeWeights = edge_end[row];
          for (let w = 0; w < 9; w++) {
            sum += data[numFrames - 9 + w][f] * edgeWeights[w];
          }
        } else {
          // Inner frames standard convolution
          for (let w = 0; w < weights.length; w++) {
            let idx = i - w + halfWindow;
            sum += data[idx][f] * weights[w];
          }
        }
        out[i][f] = sum;
      }
    }
    return out;
  }
  
  /**
   * Zero-crossing rate as librosa.feature.zero_crossing_rate(y, frame_length=2048, hop_length=64,
   * center=True) in librosa 0.11:
   *   - the signal is edge-padded (np.pad mode "edge") by 1024 samples on each side;
   *   - zero_crossings(threshold=1e-10, zero_pos=True, pad=False): samples with |y| <= 1e-10
   *     are set to 0, the sign is np.signbit (so 0 counts as positive), and a crossing is a
   *     sign change between consecutive samples; the first sample of a frame is never one;
   *   - the rate is the mean over the 2048 entries of the frame.
   * The threshold is compared in float32, as numpy does for a float32 signal.
   * @param {Float32Array} pcm
   * @param {number} numFrames
   */
  _computeZCR(pcm, numFrames) {
    const frameSize = 2048;
    const pad = frameSize / 2;
    const threshold = Math.fround(1e-10);
    const n = pcm.length;
    const negative = (v) => v < -threshold; // signbit after zeroing |v| <= threshold
    const isNeg = new Uint8Array(n + 2 * pad);
    for (let i = 0; i < pad; i++) isNeg[i] = negative(pcm[0]) ? 1 : 0;
    for (let i = 0; i < n; i++) isNeg[pad + i] = negative(pcm[i]) ? 1 : 0;
    for (let i = 0; i < pad; i++) isNeg[pad + n + i] = negative(pcm[n - 1]) ? 1 : 0;

    // crossingsBefore[j] = number of sign changes between positions (k-1, k) for 1 <= k <= j
    const crossingsBefore = new Int32Array(isNeg.length);
    for (let j = 1; j < isNeg.length; j++) {
      crossingsBefore[j] = crossingsBefore[j - 1] + (isNeg[j] !== isNeg[j - 1] ? 1 : 0);
    }
    const zcrs = new Float32Array(numFrames);
    for (let i = 0; i < numFrames; i++) {
      const start = i * this.hop;
      const count = crossingsBefore[start + frameSize - 1] - crossingsBefore[start];
      zcrs[i] = count / frameSize;
    }
    return zcrs;
  }
}
