/**
 * services/ble/AudioReassembler.js — rebuilds one recording from its BLE audio packets and checks
 * that it is complete and unaltered before anything analyses it.
 *
 * Packets of a recording carry its 16-bit tag, a sequence number and the offset of their first
 * sample; seq * samplesPerPacket must equal the offset. Every packet holds samplesPerPacket samples
 * except the last. Packets arrive in order, so a jump in seq means lost packets: accept() reports
 * that gap at once, while the device still holds those samples in its ring buffer.
 *
 * finalize() accepts the recording only if it has the requested sample count at 8000 Hz, every
 * packet is present with its expected length, and the CRC-32 of the samples equals the device's.
 * Anything else is a failed transfer with the reasons listed: no partial audio is analysed.
 */

import { PRISM_BLE, crc32Int16 } from "./protocol.js";

export const TRANSFER_FAILURE = Object.freeze({
  SAMPLE_RATE: "sample_rate",            // the device reports a rate other than 8000 Hz
  LENGTH: "length",                      // fewer (or more) samples than requested
  MISSING_PACKETS: "missing_packets",
  CRC_MISMATCH: "crc_mismatch",
  NO_DEVICE_CRC: "no_device_crc",
});

export default class AudioReassembler {
  /**
   * @param {{ tag: number, samplesPerPacket: number, requestedSamples: number }} recording - from
   *   the device's RECORDING status
   */
  constructor({ tag, samplesPerPacket, requestedSamples }) {
    if (!Number.isInteger(tag) || tag <= 0 || tag > 0xffff) throw new RangeError(`invalid recording tag ${tag}`);
    if (!Number.isInteger(samplesPerPacket) || samplesPerPacket <= 0) throw new RangeError(`invalid samples per packet ${samplesPerPacket}`);
    if (!Number.isInteger(requestedSamples) || requestedSamples <= 0) throw new RangeError(`invalid sample count ${requestedSamples}`);
    this.tag = tag;
    this.spp = samplesPerPacket;
    this.requested = requestedSamples;
    this.expectedPackets = Math.ceil(requestedSamples / samplesPerPacket);
    this.pcm = new Int16Array(requestedSamples);
    this.received = new Uint8Array(this.expectedPackets);
    this.receivedCount = 0;
    this.nextSeq = 0; // one past the highest seq seen
    this.duplicates = 0;
    this.foreign = 0; // packets of another recording (stale notifications)
    this.invalid = []; // packets that contradict the protocol (kept for the report)
  }

  /** Samples received so far (for progress). */
  get receivedSamples() {
    return Math.min(this.requested, this.receivedCount * this.spp);
  }

  /**
   * @param {{ version: number, tag: number, seq: number, offset: number, samples: Int16Array }} packet
   * @returns {{ accepted: boolean, gap: { offset: number, count: number }|null }} gap: samples to ask for again now
   */
  accept(packet) {
    if (packet.tag !== this.tag) {
      this.foreign += 1;
      return { accepted: false, gap: null };
    }
    const problem = this._check(packet);
    if (problem) {
      if (this.invalid.length < 20) this.invalid.push(`seq ${packet.seq}: ${problem}`);
      return { accepted: false, gap: null };
    }
    if (this.received[packet.seq]) this.duplicates += 1;
    else {
      this.received[packet.seq] = 1;
      this.receivedCount += 1;
    }
    this.pcm.set(packet.samples, packet.offset);
    let gap = null;
    if (packet.seq > this.nextSeq) {
      gap = { offset: this.nextSeq * this.spp, count: (packet.seq - this.nextSeq) * this.spp };
    }
    this.nextSeq = Math.max(this.nextSeq, packet.seq + 1);
    return { accepted: true, gap };
  }

  _check(packet) {
    if (packet.version !== PRISM_BLE.PROTOCOL_VERSION) return `protocol version ${packet.version}`;
    if (!Number.isInteger(packet.seq) || packet.seq >= this.expectedPackets) return "sequence number beyond the recording";
    if (packet.offset !== packet.seq * this.spp) return `offset ${packet.offset} is not seq * ${this.spp}`;
    const expectedLength = Math.min(this.spp, this.requested - packet.offset);
    if (packet.samples.length !== expectedLength) return `${packet.samples.length} samples, expected ${expectedLength}`;
    return null;
  }

  /** Missing sample ranges (packet-aligned, merged), for SEND requests. */
  missingRanges() {
    const ranges = [];
    let start = -1;
    for (let seq = 0; seq <= this.expectedPackets; seq++) {
      const missing = seq < this.expectedPackets && !this.received[seq];
      if (missing && start < 0) start = seq;
      if (!missing && start >= 0) {
        const offset = start * this.spp;
        ranges.push({ offset, count: Math.min(this.requested, seq * this.spp) - offset });
        start = -1;
      }
    }
    return ranges;
  }

  get missingPackets() {
    return this.expectedPackets - this.receivedCount;
  }

  /**
   * Verify the recording against the device's final status.
   * @param {{ nSamples: number, sampleRate: number, crc: string|null }} status - final READY status
   * @returns {{ ok: boolean, failures: string[], pcm: Int16Array|null, crcPhone: string|null, crcDevice: string|null,
   *   nSamples: number, packets: number, missingPackets: number, duplicates: number, foreign: number, invalid: string[] }}
   */
  finalize({ nSamples, sampleRate, crc }) {
    const failures = [];
    if (sampleRate !== PRISM_BLE.SAMPLE_RATE) failures.push(TRANSFER_FAILURE.SAMPLE_RATE);
    if (nSamples !== this.requested) failures.push(TRANSFER_FAILURE.LENGTH);
    if (this.missingPackets > 0) failures.push(TRANSFER_FAILURE.MISSING_PACKETS);
    let crcPhone = null;
    if (failures.length === 0) {
      crcPhone = crc32Int16(this.pcm);
      if (!crc) failures.push(TRANSFER_FAILURE.NO_DEVICE_CRC);
      else if (crcPhone !== crc) failures.push(TRANSFER_FAILURE.CRC_MISMATCH);
    }
    const ok = failures.length === 0;
    return {
      ok,
      failures,
      pcm: ok ? this.pcm : null,
      crcPhone,
      crcDevice: crc ?? null,
      nSamples,
      packets: this.receivedCount,
      missingPackets: this.missingPackets,
      duplicates: this.duplicates,
      foreign: this.foreign,
      invalid: [...this.invalid],
    };
  }
}
