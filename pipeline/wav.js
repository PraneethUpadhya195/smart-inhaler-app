/**
 * pipeline/wav.js
 *
 * RIFF/WAVE decoder for 16-bit PCM, platform-neutral (no Node `fs`, no Buffer): it takes the
 * file bytes, so the same code runs in Node and in React Native.
 *
 * Conversion follows the contract (input.waveform): float32 = int16 / 32768.
 * Multi-channel files are averaged to mono in float32, as prism_inference.read_wav does
 * (soundfile + mean over channels, dtype float32).
 */

export class WavDecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "WavDecodeError";
  }
}

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

function fourCC(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3)
  );
}

/**
 * @param {Uint8Array|ArrayBuffer} input - complete WAV file bytes
 * @returns {{ samples: Float32Array, sampleRate: number, channels: 1, fileChannels: number }}
 */
export function decodeWav(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || fourCC(view, 0) !== "RIFF" || fourCC(view, 8) !== "WAVE") {
    throw new WavDecodeError("not a RIFF/WAVE file");
  }

  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = fourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.byteLength) throw new WavDecodeError("truncated fmt chunk");
      let format = view.getUint16(body, true);
      if (format === WAVE_FORMAT_EXTENSIBLE && size >= 26) {
        format = view.getUint16(body + 24, true); // first two bytes of the SubFormat GUID
      }
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      dataOffset = body;
      dataSize = Math.min(size, bytes.byteLength - body); // tolerate a truncated last chunk
      break;
    }
    offset = body + size + (size & 1); // chunks are word-aligned
  }

  if (fmt === null) throw new WavDecodeError("no fmt chunk");
  if (dataOffset < 0) throw new WavDecodeError("no data chunk");
  if (fmt.format !== WAVE_FORMAT_PCM || fmt.bitsPerSample !== 16) {
    throw new WavDecodeError(
      `unsupported encoding (format ${fmt.format}, ${fmt.bitsPerSample} bit); the contract input is 16-bit PCM`
    );
  }
  if (fmt.channels < 1 || fmt.blockAlign !== 2 * fmt.channels) {
    throw new WavDecodeError(`inconsistent fmt chunk (channels ${fmt.channels}, block align ${fmt.blockAlign})`);
  }

  const nch = fmt.channels;
  const nFrames = Math.floor(dataSize / fmt.blockAlign);
  const samples = new Float32Array(nFrames);
  if (nch === 1) {
    for (let i = 0; i < nFrames; i++) samples[i] = view.getInt16(dataOffset + 2 * i, true) / 32768;
  } else {
    for (let i = 0; i < nFrames; i++) {
      let sum = 0;
      for (let c = 0; c < nch; c++) {
        sum = Math.fround(sum + view.getInt16(dataOffset + fmt.blockAlign * i + 2 * c, true) / 32768);
      }
      samples[i] = Math.fround(sum / nch);
    }
  }
  return { samples, sampleRate: fmt.sampleRate, channels: 1, fileChannels: nch };
}
