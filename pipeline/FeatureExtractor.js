import fs from 'fs';
import FFT from 'fft.js';
import { PIPELINE_CONFIG } from './versions.js';
import { DSP_CONSTANTS } from './dsp_constants.js';

/**
 * Stage 10: Versioned Event-Feature Engine
 * Extracts anomaly features and mean_rms from isolated event PCM segments.
 */
export class FeatureExtractor {
    constructor(schemaPath = 'assets/ml/v2_validation/v2_feature_schema.json') {
        let schemaContent = '{}';
        // In React Native, you would import the schema directly or pass it in.
        // For node environments:
        if (typeof process !== 'undefined' && fs.readFileSync) {
            schemaContent = fs.readFileSync(schemaPath, 'utf8');
        } else {
            // Fallback for non-node environments - this should ideally be injected
            throw new Error("Cannot load schema directly in this environment. Pass schema content in constructor.");
        }
        
        this.schema = JSON.parse(schemaContent);
        this.n_fft = this.schema.frames.n_fft; // 256
        this.hop = this.schema.frames.hop_length; // 64
        
        this.fft = new FFT(this.n_fft);
        this.hann_window = DSP_CONSTANTS.hann_window;
        this.fft_freqs = DSP_CONSTANTS.fft_frequencies;
    }
    
    /**
     * Compute features for an isolated PCM segment
     * @param {Float32Array} pcm 
     * @returns {import('./types').EventFeatures}
     */
    extractFeatures(pcm) {
        // 1. Mean RMS
        const mean_rms = this._computeMeanRms(pcm);
        
        // 2. STFT Spectral Features
        const { centroids, flatnesses, rolloffs } = this._computeSpectralFrames(pcm);
        
        // 3. Aggregate
        const featuresArray = new Float64Array(4); // the 4 anomaly features
        
        // From v2_feature_schema.json:
        // 0: spectral_centroid_mean
        // 1: spectral_flatness_mean
        // 2: spectral_centroid_std
        // 3: spectral_rolloff_std
        
        featuresArray[0] = this._mean(centroids);
        featuresArray[1] = this._mean(flatnesses);
        featuresArray[2] = this._std(centroids);
        featuresArray[3] = this._std(rolloffs);
        
        return {
            version: this.schema.contract_version,
            features: featuresArray,
            mean_rms: mean_rms
        };
    }
    
    /**
     * Compute mean RMS: 256-sample frames, hop 64, partial final frames included, no padding
     */
    _computeMeanRms(pcm) {
        if (pcm.length === 0) return 0;
        
        let sumRms = 0;
        let count = 0;
        
        for (let i = 0; i < pcm.length; i += this.hop) {
            let sumSq = 0;
            let frameLen = Math.min(this.n_fft, pcm.length - i);
            for (let j = 0; j < frameLen; j++) {
                sumSq += pcm[i + j] * pcm[i + j];
            }
            sumRms += Math.sqrt(sumSq / frameLen);
            count++;
        }
        
        return count > 0 ? sumRms / count : 0;
    }
    
    _computeSpectralFrames(pcm) {
        // Constant zero-padding, n_fft // 2 each side
        const pad = Math.floor(this.n_fft / 2);
        const paddedLen = pcm.length + 2 * pad;
        const paddedPcm = new Float32Array(paddedLen);
        paddedPcm.set(pcm, pad);
        
        const numFrames = 1 + Math.floor(pcm.length / this.hop);
        
        const centroids = new Float32Array(numFrames);
        const flatnesses = new Float32Array(numFrames);
        const rolloffs = new Float32Array(numFrames);
        
        for (let i = 0; i < numFrames; i++) {
            const start = i * this.hop;
            
            const frame = new Float32Array(this.n_fft);
            for (let j = 0; j < this.n_fft; j++) {
                frame[j] = paddedPcm[start + j] * this.hann_window[j];
            }
            
            const outComplex = this.fft.createComplexArray();
            this.fft.realTransform(outComplex, frame);
            this.fft.completeSpectrum(outComplex);
            
            const numBins = Math.floor(this.n_fft / 2) + 1;
            const mag = new Float32Array(numBins);
            const power = new Float32Array(numBins);
            
            let sumMag = 0;
            for (let k = 0; k < numBins; k++) {
                const re = outComplex[2 * k];
                const im = outComplex[2 * k + 1];
                const m = Math.sqrt(re * re + im * im);
                mag[k] = m;
                power[k] = m * m;
                sumMag += m;
            }
            
            // Centroid
            let num = 0;
            for (let k = 0; k < numBins; k++) {
                num += this.fft_freqs[k] * mag[k];
            }
            centroids[i] = (sumMag > 0 ? num / sumMag : 0) / 4000.0;
            
            // Flatness
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
            
            // Rolloff
            const threshold = 0.85 * sumMag;
            let cumsum = 0;
            let rolloffFreq = 0;
            for (let k = 0; k < numBins; k++) {
                cumsum += mag[k];
                if (cumsum >= threshold) {
                    rolloffFreq = this.fft_freqs[k];
                    break;
                }
            }
            rolloffs[i] = rolloffFreq / 4000.0;
        }
        
        return { centroids, flatnesses, rolloffs };
    }
    
    _mean(arr) {
        if (arr.length === 0) return 0;
        let sum = 0;
        for (let i = 0; i < arr.length; i++) sum += arr[i];
        return sum / arr.length;
    }
    
    _std(arr) {
        if (arr.length === 0) return 0;
        const mean = this._mean(arr);
        let sumSq = 0;
        for (let i = 0; i < arr.length; i++) {
            const diff = arr[i] - mean;
            sumSq += diff * diff;
        }
        return Math.sqrt(sumSq / arr.length);
    }
}
