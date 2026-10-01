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
    let fs;
    try {
      // dynamically import fs to keep React Native compatibility
      fs = (await import('fs')).default || await import('fs');
    } catch (e) {
      throw new Error("WavPcmSource requires Node.js 'fs' module. Not supported on device.");
    }
    
    if (!fs.existsSync(this.filePath)) {
      throw new Error(`File not found: ${this.filePath}`);
    }

    const buffer = fs.readFileSync(this.filePath);
    
    // Check RIFF header
    const riff = buffer.toString('ascii', 0, 4);
    if (riff !== 'RIFF') throw new Error("Not a valid RIFF file");
    
    let offset = 12; // skip RIFF and WAVE headers
    let dataOffset = 0;
    let dataSize = 0;
    let sampleRate = 8000;
    
    while (offset < buffer.length) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      
      if (chunkId === 'fmt ') {
        const audioFormat = buffer.readUInt16LE(offset + 8);
        const numChannels = buffer.readUInt16LE(offset + 10);
        sampleRate = buffer.readUInt32LE(offset + 12);
        
        if (audioFormat !== 1) throw new Error("Only uncompressed PCM supported");
        if (numChannels !== 1) throw new Error("Only mono WAV supported");
        if (sampleRate !== 8000) throw new Error(`Expected 8000 Hz, got ${sampleRate}`);
      }
      
      if (chunkId === 'data') {
        dataOffset = offset + 8;
        dataSize = chunkSize;
        break;
      }
      offset += 8 + chunkSize;
    }
    
    if (dataOffset === 0) throw new Error("No data chunk found in WAV file");
    
    const numSamples = dataSize / 2; // 16-bit = 2 bytes per sample
    const samples = new Float32Array(numSamples);
    
    for (let i = 0; i < numSamples; i++) {
      samples[i] = buffer.readInt16LE(dataOffset + i * 2) / 32768.0;
    }
    
    return {
      samples,
      sampleRate: 8000,
      inputDomain: this.inputDomain,
      metadata: {
        timestamp: new Date().toISOString(),
        durationS: numSamples / 8000.0,
        originalFile: this.filePath
      }
    };
  }
}
