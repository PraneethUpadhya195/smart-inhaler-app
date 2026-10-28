/**
 * pipeline/sources/WavPcmSource.js
 *
 * Produces PcmData from a 16-bit PCM WAV file.
 *
 * The decoder (../wav.js) is platform-neutral. The source accepts either:
 *   - the WAV bytes (Uint8Array | ArrayBuffer): works everywhere, including React Native;
 *   - a file path (string): Node.js only. The file is read through options.readFile if given,
 *     otherwise through Node's built-in fs, looked up at run time with
 *     process.getBuiltinModule so that no `fs` import exists for Metro to bundle.
 *
 * The sample rate is reported as found: a rate other than 8000 Hz is not rejected here but
 * becomes the contract's INPUT_ERROR `unsupported_sample_rate` in InferencePipeline.run().
 * Conversion: float32 = int16 / 32768 (contract input.waveform).
 */

import PcmSource from "../PcmSource.js";
import { decodeWav } from "../wav.js";

function nodeReadFile(path) {
  const fs = globalThis.process?.getBuiltinModule?.("node:fs");
  if (!fs) {
    throw new Error("WavPcmSource: reading a file path needs Node.js; pass the WAV bytes instead");
  }
  return new Uint8Array(fs.readFileSync(path));
}

function baseName(path) {
  return path.split(/[\\/]/).pop();
}

export default class WavPcmSource extends PcmSource {
  /**
   * @param {string|Uint8Array|ArrayBuffer} source - WAV file path (Node) or WAV file bytes
   * @param {Object} [options]
   * @param {string} [options.inputDomain='unknown'] - 'reference_dataset' | 'prism_hardware' | 'unknown'
   * @param {string|null} [options.sourceId] - recording_id; defaults to the file name for a path, else null
   * @param {Date|string|null} [options.recordedAt=null] - caller-supplied recording start time (ISO 8601)
   * @param {(path: string) => Uint8Array} [options.readFile] - file reader for path sources
   */
  constructor(source, options = {}) {
    super("wav");
    /** @type {string|Uint8Array|ArrayBuffer} */
    this.source = source;
    /** @type {string|null} kept for callers of the previous API */
    this.filePath = typeof source === "string" ? source : null;
    /** @type {string} */
    this.inputDomain = options.inputDomain ?? "unknown";
    this.sourceId = options.sourceId !== undefined ? options.sourceId : this.filePath ? baseName(this.filePath) : null;
    this.recordedAt = options.recordedAt ?? null;
    this.readFile = options.readFile ?? nodeReadFile;
  }

  /**
   * Read and decode the WAV file.
   * @returns {Promise<import('../types').PcmData>}
   * @throws {import('../wav.js').WavDecodeError} if the bytes are not a 16-bit PCM WAV file
   */
  async acquire() {
    const bytes = typeof this.source === "string" ? this.readFile(this.source) : this.source;
    const { samples, sampleRate, channels } = decodeWav(bytes);
    return {
      samples,
      sampleRate,
      channels,
      sourceType: this.sourceType,
      sourceId: this.sourceId,
      recordedAt: this.recordedAt,
      inputDomain: this.inputDomain,
    };
  }
}
