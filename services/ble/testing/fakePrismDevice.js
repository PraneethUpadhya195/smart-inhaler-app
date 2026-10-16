/**
 * services/ble/testing/fakePrismDevice.js — TEST ONLY. A simulator of the PRISM recorder firmware
 * (firmware/prism_ble_recorder) behind the transport interface of services/ble/PrismRecorder.js.
 *
 * It is never imported by the app (utils/test_session_view.js and services/test_ble.js check
 * that no module reachable from App.js imports it): the app has no simulated BLE device.
 *
 * It follows the firmware's protocol logic: RECORDING status → packets streamed as the "capture"
 * advances in 256-sample blocks → READY status with the CRC; SEND ranges served from a ring
 * buffer (EXPIRED if older); RELEASE; ABORT. Fault injection for the tests:
 *   dropSeqs / dropEvery (first transmission only), dropResends, duplicateEvery, foreignAt,
 *   corruptPayloadAt (a sample changed after the CRC), disconnectAtSeq, stallAtSeq (no READY),
 *   refuseStart (error code), sampleRate, protocolVersion, mtu, ringSamples, wrongCrc,
 *   statusOvertakes (the READY status reaches the phone before the last packets, as seen with
 *   react-native-ble-plx on the phone: two characteristics are not delivered in order).
 */

import { PRISM_BLE, COMMAND, crc32Int16 } from "../protocol.js";

const encoder = (obj) => Uint8Array.from(JSON.stringify(obj), (c) => c.charCodeAt(0));
const tick = () => new Promise((r) => setImmediate(r));

/**
 * @param {Object} options
 * @param {Int16Array} options.source - audio the fake microphone "hears" (repeated if too short)
 * @param {Object} [options.faults]
 */
export function createFakePrismTransport({ source, faults = {} }) {
  const f = {
    mtu: 247, sampleRate: 8000, protocolVersion: 1, ringSamples: 43008, dropSeqs: new Set(), dropEvery: 0,
    dropResends: false, duplicateEvery: 0, foreignAt: -1, corruptPayloadAt: -1, disconnectAtSeq: -1,
    stallAtSeq: -1, refuseStart: null, wrongCrc: false, notifyDisabled: false, statusOvertakes: false, ...faults,
  };
  const monitors = new Map(); // uuid -> Set(callback)
  const disconnectCallbacks = new Set();
  let connected = false;
  let state = "IDLE";
  let tag = 0;
  let rid = "";
  let requested = 0;
  let captured = 0;
  let crc = null;
  let error = null;
  let sent = 0;
  let firstSends = new Set();
  let resendQueue = [];
  let samples = new Int16Array(0);
  let abortFlag = false;
  let runId = 0;
  const log = { commands: [], packetsSent: 0, resendsServed: 0 };

  const spp = () => Math.floor((f.mtu - 3 - PRISM_BLE.PACKET_HEADER) / 2);
  const status = () => ({
    p: f.protocolVersion, st: state, tag, rid, n: captured, req: requested, sr: f.sampleRate,
    crc: crc ?? "00000000", spp: spp(), mtu: f.mtu, sent, q: resendQueue.length, done: crc !== null || state === "READY",
    err: error,
  });
  const notify = (uuid, bytes) => {
    if (!connected) return;
    for (const cb of monitors.get(uuid) ?? []) cb(bytes);
  };
  const publish = () => notify(PRISM_BLE.STATUS_UUID, encoder(status()));

  function packetBytes(seq, packetTag = tag) {
    const n = spp();
    const offset = seq * n;
    const count = Math.min(n, captured - offset);
    const bytes = new Uint8Array(PRISM_BLE.PACKET_HEADER + 2 * count);
    const view = new DataView(bytes.buffer);
    bytes[0] = PRISM_BLE.PACKET_AUDIO;
    bytes[1] = f.protocolVersion;
    view.setUint16(2, packetTag, true);
    view.setUint32(4, seq, true);
    view.setUint32(8, offset, true);
    for (let i = 0; i < count; i++) view.setInt16(PRISM_BLE.PACKET_HEADER + 2 * i, samples[offset + i], true);
    if (seq === f.corruptPayloadAt) view.setInt16(PRISM_BLE.PACKET_HEADER, samples[offset] ^ 0x0101, true);
    return bytes;
  }

  function sendPacket(seq, isResend) {
    if (!connected) return;
    sent += 1;
    log.packetsSent += 1;
    const first = !firstSends.has(seq);
    firstSends.add(seq);
    if (isResend) log.resendsServed += 1;
    if (first && (f.dropSeqs.has(seq) || (f.dropEvery > 0 && (seq + 1) % f.dropEvery === 0))) return;
    if (isResend && f.dropResends) return;
    notify(PRISM_BLE.AUDIO_UUID, packetBytes(seq));
    if (f.duplicateEvery > 0 && (seq + 1) % f.duplicateEvery === 0) notify(PRISM_BLE.AUDIO_UUID, packetBytes(seq));
    if (seq === f.foreignAt) notify(PRISM_BLE.AUDIO_UUID, packetBytes(seq, (tag + 1) & 0xffff || 1));
  }

  function serveResends() {
    const n = spp();
    const oldest = Math.max(0, captured - f.ringSamples);
    while (resendQueue.length > 0 && connected) {
      const range = resendQueue.shift();
      let from = range.from;
      if (from < oldest) {
        error = "EXPIRED";
        from = Math.ceil(oldest / n) * n;
      }
      for (let pos = from; pos < range.end; pos += n) sendPacket(pos / n, true);
    }
  }

  async function runRecording(n, id) {
    const per = spp();
    let nextLive = 0;
    while (captured < n) {
      if (id !== runId) return;
      if (abortFlag) {
        error = "ABORTED";
        break;
      }
      captured = Math.min(n, captured + 256);
      while ((nextLive + 1) * per <= captured) {
        if (nextLive === f.disconnectAtSeq) {
          simulateDisconnect();
          return;
        }
        if (nextLive === f.stallAtSeq) return; // the device hangs: no READY ever
        sendPacket(nextLive, false);
        nextLive += 1;
      }
      serveResends();
      if ((captured / 256) % 8 === 0) publish();
      await tick();
    }
    if (error !== "ABORTED") {
      crc = f.wrongCrc ? "deadbeef" : crc32Int16(samples.subarray(0, captured));
      if (f.statusOvertakes) {
        state = "READY";
        publish();
        await new Promise((r) => setTimeout(r, 100));
      }
      if (nextLive * per < captured) sendPacket(nextLive, false); // the last, partial packet
      serveResends();
    }
    state = "READY";
    publish();
  }

  function simulateDisconnect() {
    connected = false;
    for (const cb of disconnectCallbacks) cb();
  }

  async function handle(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const op = bytes[0];
    log.commands.push(op);
    await tick();
    switch (op) {
      case COMMAND.START: {
        if (state === "RECORDING") {
          error = "BUSY";
          publish();
          return;
        }
        if (f.refuseStart) {
          error = f.refuseStart;
          publish();
          return;
        }
        const n = view.getUint32(1, true) || PRISM_BLE.DEFAULT_SAMPLES;
        runId += 1;
        tag = (tag % 0xfffe) + 1;
        rid = `fake${String(runId).padStart(4, "0")}`;
        requested = n;
        captured = 0;
        crc = null;
        error = null;
        sent = 0;
        firstSends = new Set();
        resendQueue = [];
        abortFlag = false;
        samples = new Int16Array(n);
        for (let i = 0; i < n; i++) samples[i] = source[i % source.length];
        state = "RECORDING";
        publish();
        runRecording(n, runId);
        return;
      }
      case COMMAND.SEND: {
        const per = spp();
        const offset = view.getUint32(1, true);
        const count = view.getUint32(5, true);
        const end = count === 0 || offset + count > captured ? captured : offset + count;
        resendQueue.push({ from: Math.floor(offset / per) * per, end });
        if (state !== "RECORDING") {
          state = "TRANSFERRING";
          error = null;
          publish();
          serveResends();
          state = "READY";
          publish();
        }
        return;
      }
      case COMMAND.RELEASE:
        if (view.getUint16(1, true) !== tag) {
          error = "BAD_TAG";
          publish();
          return;
        }
        state = "IDLE";
        tag = tag || 0;
        crc = null;
        captured = 0;
        requested = 0;
        error = null;
        publish();
        return;
      case COMMAND.ABORT:
        if (state === "RECORDING") abortFlag = true;
        return;
      case COMMAND.IDENTIFY:
        return;
      case COMMAND.STATUS:
        publish();
        return;
      default:
        error = "BAD_COMMAND";
        publish();
    }
  }

  return {
    log,
    faults: f,
    disconnectNow: simulateDisconnect,
    async connect() {
      await tick();
      connected = true;
      return { id: "FA:KE:00:00:00:01", name: "PRISM-FAKE", mtu: f.mtu };
    },
    async disconnect() {
      connected = false;
    },
    async read(uuid) {
      await tick();
      if (!connected) throw new Error("not connected");
      if (uuid === PRISM_BLE.INFO_UUID) {
        return encoder({ p: f.protocolVersion, fw: "fake-prism 0.0.0", dev: "prism-esp32-fake", name: "PRISM-FAKE",
          mic: "INMP441", sr: f.sampleRate, bits: 16, i2s: "simulated", conv: "simulated", max_n: 240000,
          def_n: 80000, min_n: 1536, ring_n: f.ringSamples, transfer: "live" });
      }
      if (uuid === PRISM_BLE.STATUS_UUID) return encoder(status());
      if (uuid === PRISM_BLE.META_UUID) {
        return encoder(tag && crc ? { p: 1, tag, rid, n: captured, crc, rate_hz: 8000, raw_or: "ffffff00",
          low_byte_nonzero: 0, clipped: 0, jumps: 0, dma_overflows: 0, ring_overruns: 0 } : { p: 1, tag: 0 });
      }
      throw new Error(`unknown characteristic ${uuid}`);
    },
    async write(uuid, bytes) {
      if (!connected) throw new Error("not connected");
      if (uuid !== PRISM_BLE.CONTROL_UUID) throw new Error("not writable");
      handle(Uint8Array.from(bytes));
    },
    monitor(uuid, onValue) {
      if (!monitors.has(uuid)) monitors.set(uuid, new Set());
      if (uuid === PRISM_BLE.AUDIO_UUID && f.notifyDisabled) return () => {};
      monitors.get(uuid).add(onValue);
      return () => monitors.get(uuid).delete(onValue);
    },
    onDisconnect(callback) {
      disconnectCallbacks.add(callback);
      return () => disconnectCallbacks.delete(callback);
    },
  };
}
