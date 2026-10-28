/**
 * services/ble/protocol.js — the phone side of the PRISM BLE audio protocol ("prism-ble-audio" v1).
 *
 * Firmware: firmware/prism_ble_recorder (ESP32 + INMP441); specification: firmware/PROTOCOL.md.
 * Pure functions (no React Native import), so the Node tests run them unchanged.
 *
 *   CONTROL (write with response)  commands, little-endian: START u32 n_samples | ABORT | SEND u32 offset,
 *                                  u32 count | RELEASE u16 tag | IDENTIFY | STATUS
 *   STATUS  (read + notify)        JSON state of the recorder
 *   AUDIO   (notify)               0xA1, version u8, tag u16, seq u32, offset u32, int16 LE samples
 *   INFO    (read)                 JSON device information
 *   META    (read)                 JSON capture diagnostics of the last recording
 */

export const PRISM_BLE = Object.freeze({
  SERVICE_UUID: "e11de72b-cbb8-4792-a4d7-79cdfc64cf24",
  CONTROL_UUID: "32881964-26ae-4fc0-8a67-1d9240d83c7e",
  STATUS_UUID: "81cb02bc-c729-4eca-b7e4-90ac538e30b7",
  AUDIO_UUID: "1885d8dd-81bd-4872-9bd4-018e66be46f4",
  INFO_UUID: "b7923a3c-4778-43a0-ab2c-84aa7c9d207e",
  META_UUID: "9b3769b5-452f-406b-a851-e1031f23bb65",
  PROTOCOL_VERSION: 1,
  PACKET_AUDIO: 0xa1,
  PACKET_HEADER: 12,
  SAMPLE_RATE: 8000,
  DEFAULT_SAMPLES: 80000,
  REQUESTED_MTU: 247,
  MIN_MTU: 64,
});

export const COMMAND = Object.freeze({ START: 1, ABORT: 2, SEND: 3, RELEASE: 4, IDENTIFY: 5, STATUS: 6 });

/** Recorder states reported in STATUS.st */
export const DEVICE_STATE = Object.freeze(["IDLE", "RECORDING", "READY", "TRANSFERRING", "ERROR"]);

/** A message from the device does not follow the protocol. */
export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolError";
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

const u32 = (view, offset, value) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`not a u32: ${value}`);
  view.setUint32(offset, value, true);
};

/** @param {number} nSamples - samples to record (0 = the device default) */
export function encodeStart(nSamples) {
  const bytes = new Uint8Array(5);
  const view = new DataView(bytes.buffer);
  bytes[0] = COMMAND.START;
  u32(view, 1, nSamples);
  return bytes;
}

/** Ask for the packets of samples [offset, offset + count) again (count 0 = to the end). */
export function encodeSend(offset, count) {
  const bytes = new Uint8Array(9);
  const view = new DataView(bytes.buffer);
  bytes[0] = COMMAND.SEND;
  u32(view, 1, offset);
  u32(view, 5, count);
  return bytes;
}

/** Tell the device the recording with this tag has been received and verified. */
export function encodeRelease(tag) {
  if (!Number.isInteger(tag) || tag < 0 || tag > 0xffff) throw new RangeError(`not a u16 tag: ${tag}`);
  return Uint8Array.of(COMMAND.RELEASE, tag & 0xff, tag >> 8);
}

/** ABORT, IDENTIFY or STATUS (no arguments). */
export function encodeCommand(op) {
  if (![COMMAND.ABORT, COMMAND.IDENTIFY, COMMAND.STATUS].includes(op)) throw new RangeError(`command ${op} needs arguments`);
  return Uint8Array.of(op);
}

// ─── Device messages ─────────────────────────────────────────────────────────

/** The firmware sends ASCII JSON. */
const ascii = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
};

/** INFO / META / STATUS characteristic value → object. */
export function parseJson(bytes) {
  let value;
  try {
    value = JSON.parse(ascii(bytes));
  } catch (e) {
    throw new ProtocolError(`device sent invalid JSON: ${e.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError("device JSON is not an object");
  return value;
}

/**
 * STATUS value → normalised status.
 * @returns {{ protocol: number, state: string, tag: number, recordingId: string, nSamples: number,
 *   requested: number, sampleRate: number, crc: string|null, samplesPerPacket: number, mtu: number,
 *   sent: number, resendQueue: number, done: boolean, error: string|null }}
 */
export function parseStatus(bytes) {
  const s = parseJson(bytes);
  if (!DEVICE_STATE.includes(s.st)) throw new ProtocolError(`unknown device state ${s.st}`);
  const int = (v, name) => {
    if (!Number.isInteger(v) || v < 0) throw new ProtocolError(`status.${name} is not a non-negative integer`);
    return v;
  };
  return {
    protocol: int(s.p, "p"),
    state: s.st,
    tag: int(s.tag, "tag"),
    recordingId: typeof s.rid === "string" ? s.rid : "",
    nSamples: int(s.n, "n"),
    requested: int(s.req, "req"),
    sampleRate: int(s.sr, "sr"),
    crc: s.done === true && typeof s.crc === "string" ? s.crc.toLowerCase().padStart(8, "0") : null,
    samplesPerPacket: int(s.spp, "spp"),
    mtu: int(s.mtu, "mtu"),
    sent: Number.isInteger(s.sent) ? s.sent : 0,
    resendQueue: Number.isInteger(s.q) ? s.q : 0,
    done: s.done === true,
    error: typeof s.err === "string" ? s.err : null,
  };
}

/**
 * AUDIO notification → packet. The samples are copied (the source buffer may be reused).
 * @param {Uint8Array} bytes
 * @returns {{ version: number, tag: number, seq: number, offset: number, samples: Int16Array }}
 */
export function parseAudioPacket(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new ProtocolError("audio packet must be bytes");
  if (bytes.length < PRISM_BLE.PACKET_HEADER + 2) throw new ProtocolError(`audio packet too short (${bytes.length} bytes)`);
  if (bytes[0] !== PRISM_BLE.PACKET_AUDIO) throw new ProtocolError(`not an audio packet (type 0x${bytes[0].toString(16)})`);
  if ((bytes.length - PRISM_BLE.PACKET_HEADER) % 2 !== 0) throw new ProtocolError("audio payload is not whole int16 samples");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = (bytes.length - PRISM_BLE.PACKET_HEADER) / 2;
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = view.getInt16(PRISM_BLE.PACKET_HEADER + 2 * i, true);
  return {
    version: bytes[1],
    tag: view.getUint16(2, true),
    seq: view.getUint32(4, true),
    offset: view.getUint32(8, true),
    samples,
  };
}

// ─── CRC-32 (IEEE 802.3, as zlib.crc32 and the firmware) ─────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of bytes, as 8 lower-case hex digits. */
export function crc32Bytes(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

/** CRC-32 of int16 samples as little-endian bytes (what the firmware computes while recording). */
export function crc32Int16(samples) {
  let c = 0xffffffff;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] & 0xffff;
    c = CRC_TABLE[(c ^ (v & 0xff)) & 0xff] ^ (c >>> 8);
    c = CRC_TABLE[(c ^ (v >>> 8)) & 0xff] ^ (c >>> 8);
  }
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

// ─── Base64 (react-native-ble-plx exchanges characteristic values as base64) ──

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** @param {Uint8Array} bytes @returns {string} */
export function toBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
      + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return out;
}

/** @param {string} text @returns {Uint8Array} */
export function fromBase64(text) {
  const clean = String(text).replace(/[\r\n\s]/g, "");
  if (clean.length % 4 !== 0) throw new ProtocolError("base64 length is not a multiple of 4");
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => {
      const ch = clean.charCodeAt(i + k);
      if (clean[i + k] === "=") return 0;
      const idx = ch < 128 ? B64_INDEX[ch] : -1;
      if (idx < 0) throw new ProtocolError("invalid base64 character");
      return idx;
    });
    const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}
