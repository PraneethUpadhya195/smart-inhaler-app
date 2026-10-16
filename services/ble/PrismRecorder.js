/**
 * services/ble/PrismRecorder.js — connects to the PRISM recorder (ESP32 + INMP441) and records one
 * verified recording over BLE (protocol: firmware/PROTOCOL.md, services/ble/protocol.js).
 *
 * The BLE link is injected (`transport`), so the same code runs in the app (services/ble/bleTransport.js,
 * react-native-ble-plx) and in the Node tests (services/ble/testing/fakePrismDevice.js, a protocol
 * simulator used only by tests). Transport interface:
 *   connect({ deviceId }) → { id, name, mtu }       scan for the service (or use deviceId) and connect
 *   disconnect()
 *   read(uuid) → Uint8Array
 *   write(uuid, bytes)                              write with response
 *   monitor(uuid, onValue(bytes), onError(err)) → unsubscribe()
 *   onDisconnect(callback) → unsubscribe()
 *
 * record():
 *   START → RECORDING status (tag, samples per packet) → audio packets stream in while the device
 *   records; a sequence gap is asked for again at once (SEND) while the device still holds it →
 *   READY status (sample count, CRC-32) → missing packets asked for again (up to 3 rounds) →
 *   AudioReassembler.finalize (8000 Hz, exact sample count, every packet, CRC) → META read →
 *   RELEASE. Any failure throws a RecorderError; no partial recording is returned.
 */

import AudioReassembler from "./AudioReassembler.js";
import {
  PRISM_BLE,
  COMMAND,
  encodeStart,
  encodeSend,
  encodeRelease,
  encodeCommand,
  parseStatus,
  parseJson,
  parseAudioPacket,
} from "./protocol.js";

export const RECORDER_ERROR = Object.freeze({
  BLUETOOTH_UNAVAILABLE: "BLUETOOTH_UNAVAILABLE", // adapter off or missing
  PERMISSION_DENIED: "PERMISSION_DENIED",
  DEVICE_NOT_FOUND: "DEVICE_NOT_FOUND",
  CONNECT_FAILED: "CONNECT_FAILED",
  NOT_CONNECTED: "NOT_CONNECTED",
  PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
  UNSUPPORTED_DEVICE: "UNSUPPORTED_DEVICE", // sample rate or MTU the app cannot use
  BUSY: "BUSY",
  START_REFUSED: "START_REFUSED",
  DEVICE_ERROR: "DEVICE_ERROR",
  DISCONNECTED: "DISCONNECTED",
  TIMEOUT: "TIMEOUT",
  TRANSFER_INCOMPLETE: "TRANSFER_INCOMPLETE",
  CRC_MISMATCH: "CRC_MISMATCH",
  ABORTED: "ABORTED",
});

export class RecorderError extends Error {
  /**
   * @param {string} code - RECORDER_ERROR
   * @param {string} message
   * @param {Object} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RecorderError";
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_TIMEOUTS = Object.freeze({
  startMs: 5000,        // START → RECORDING status
  finishMarginMs: 20000, // beyond the recording's own duration, until READY
  resendRoundMs: 10000,
  resendRounds: 3,
  settleMs: 600, // after READY: packets still on their way (the status can overtake them in the BLE stack)
});

/**
 * @param {Object} options
 * @param {Object} options.transport - see the module comment
 * @param {() => Date} [options.now]
 * @param {{ warn: Function, log?: Function }} [options.log]
 * @param {Object} [options.timeouts]
 */
export function createPrismRecorder({ transport, now = () => new Date(), log = console, timeouts = {} }) {
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  let device = null; // device information while connected
  let latestStatus = null;
  let statusCount = 0;
  let waiters = [];
  let busy = false;
  let abortRequested = false;
  let unsubscribers = [];
  const stateListeners = new Set();

  const emit = () => {
    for (const fn of stateListeners) {
      try {
        fn({ connected: device !== null, device, status: latestStatus });
      } catch (e) {
        log.warn?.("[PrismRecorder] listener failed:", e?.message ?? e);
      }
    }
  };

  function failWaiters(error) {
    const pending = waiters;
    waiters = [];
    for (const w of pending) w.reject(error);
  }

  function onStatus(bytes) {
    let status;
    try {
      status = parseStatus(bytes);
    } catch (e) {
      log.warn?.("[PrismRecorder] status ignored:", e.message);
      return;
    }
    latestStatus = status;
    statusCount += 1;
    for (const w of [...waiters]) {
      if (w.predicate(status)) {
        waiters = waiters.filter((x) => x !== w);
        w.resolve(status);
      }
    }
    emit();
  }

  /** The next status (after this call) that satisfies predicate. */
  function waitForStatus(predicate, ms, what) {
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (s) => { clearTimeout(waiter.timer); resolve(s); },
        reject: (e) => { clearTimeout(waiter.timer); reject(e); },
      };
      waiter.timer = setTimeout(() => {
        waiters = waiters.filter((x) => x !== waiter);
        reject(new RecorderError(RECORDER_ERROR.TIMEOUT, `No answer from the device while ${what}.`,
          { lastStatus: latestStatus }));
      }, ms);
      waiters.push(waiter);
    });
  }

  function handleDisconnect() {
    const wasConnected = device !== null;
    device = null;
    for (const u of unsubscribers) {
      try { u(); } catch { /* already gone */ }
    }
    unsubscribers = [];
    failWaiters(new RecorderError(RECORDER_ERROR.DISCONNECTED, "The device disconnected."));
    if (wasConnected) emit();
  }

  async function connect({ deviceId = null } = {}) {
    if (device) return device;
    let link;
    try {
      link = await transport.connect({ deviceId, serviceUuid: PRISM_BLE.SERVICE_UUID });
    } catch (e) {
      if (e instanceof RecorderError) throw e;
      throw new RecorderError(RECORDER_ERROR.CONNECT_FAILED, `Could not connect to the device: ${e?.message ?? e}`);
    }
    try {
      const info = parseJson(await transport.read(PRISM_BLE.INFO_UUID));
      if (info.p !== PRISM_BLE.PROTOCOL_VERSION) {
        throw new RecorderError(RECORDER_ERROR.PROTOCOL_MISMATCH,
          `The device speaks protocol version ${info.p}; this app needs version ${PRISM_BLE.PROTOCOL_VERSION}. Update the firmware or the app.`);
      }
      if (info.sr !== PRISM_BLE.SAMPLE_RATE) {
        throw new RecorderError(RECORDER_ERROR.UNSUPPORTED_DEVICE,
          `The device records at ${info.sr} Hz; the analysis needs ${PRISM_BLE.SAMPLE_RATE} Hz.`);
      }
      if (!Number.isInteger(link.mtu) || link.mtu < PRISM_BLE.MIN_MTU) {
        throw new RecorderError(RECORDER_ERROR.UNSUPPORTED_DEVICE,
          `The Bluetooth link allows only ${link.mtu} bytes per message; at least ${PRISM_BLE.MIN_MTU} are needed.`);
      }
      unsubscribers.push(transport.onDisconnect(handleDisconnect));
      unsubscribers.push(transport.monitor(PRISM_BLE.STATUS_UUID, onStatus,
        (e) => log.warn?.("[PrismRecorder] status notifications stopped:", e?.message ?? e)));
      onStatus(await transport.read(PRISM_BLE.STATUS_UUID));
      device = Object.freeze({
        bleId: link.id,
        name: typeof info.name === "string" ? info.name : link.name ?? null,
        deviceId: typeof info.dev === "string" ? info.dev : link.id,
        firmware: typeof info.fw === "string" ? info.fw : null,
        protocol: info.p,
        microphone: typeof info.mic === "string" ? info.mic : null,
        sampleRate: info.sr,
        i2s: typeof info.i2s === "string" ? info.i2s : null,
        conversion: typeof info.conv === "string" ? info.conv : null,
        defaultSamples: Number.isInteger(info.def_n) ? info.def_n : PRISM_BLE.DEFAULT_SAMPLES,
        maxSamples: Number.isInteger(info.max_n) ? info.max_n : null,
        minSamples: Number.isInteger(info.min_n) ? info.min_n : null,
        ringSamples: Number.isInteger(info.ring_n) ? info.ring_n : null,
        mtu: link.mtu,
      });
      emit();
      return device;
    } catch (e) {
      for (const u of unsubscribers) {
        try { u(); } catch { /* ignore */ }
      }
      unsubscribers = [];
      try { await transport.disconnect(); } catch { /* ignore */ }
      if (e instanceof RecorderError) throw e;
      throw new RecorderError(RECORDER_ERROR.CONNECT_FAILED, `The device did not answer as a PRISM recorder: ${e?.message ?? e}`);
    }
  }

  async function disconnect() {
    try {
      await transport.disconnect();
    } finally {
      handleDisconnect();
    }
  }

  async function command(bytes) {
    if (!device) throw new RecorderError(RECORDER_ERROR.NOT_CONNECTED, "No device is connected.");
    try {
      await transport.write(PRISM_BLE.CONTROL_UUID, bytes);
    } catch (e) {
      if (!device) throw new RecorderError(RECORDER_ERROR.DISCONNECTED, "The device disconnected.");
      throw new RecorderError(RECORDER_ERROR.DEVICE_ERROR, `The command was not delivered: ${e?.message ?? e}`);
    }
  }

  /**
   * Record and transfer one recording.
   * @param {Object} [options]
   * @param {number} [options.nSamples] - default: the device's default (10 s)
   * @param {(progress: Object) => void} [options.onProgress]
   * @returns {Promise<Object>} { pcm: Int16Array, sampleRate, nSamples, recordedAt, recordingId, tag, device, meta, transfer }
   */
  async function record({ nSamples, onProgress = () => {} } = {}) {
    if (!device) throw new RecorderError(RECORDER_ERROR.NOT_CONNECTED, "No device is connected.");
    if (busy) throw new RecorderError(RECORDER_ERROR.BUSY, "A recording is already running.");
    const requested = nSamples ?? device.defaultSamples;
    if (!Number.isInteger(requested) || requested <= 0 || (device.maxSamples && requested > device.maxSamples)) {
      throw new RecorderError(RECORDER_ERROR.START_REFUSED, `Cannot record ${requested} samples with this device.`);
    }
    busy = true;
    abortRequested = false;
    const progress = (p) => {
      try {
        onProgress(p);
      } catch (e) {
        log.warn?.("[PrismRecorder] progress listener failed:", e?.message ?? e);
      }
    };

    let reassembler = null;
    const early = []; // packets that arrived before the RECORDING status
    let malformed = 0;
    let audioClosed = false;
    let gapRequests = 0;
    let sendChain = Promise.resolve();
    const askAgain = (gap) => {
      gapRequests += 1;
      sendChain = sendChain
        .then(() => command(encodeSend(gap.offset, gap.count)))
        .catch((e) => log.warn?.("[PrismRecorder] resend request failed:", e?.message ?? e));
    };
    const onPacket = (packet) => {
      const { gap } = reassembler.accept(packet);
      if (gap) askAgain(gap);
    };
    const stopAudio = transport.monitor(PRISM_BLE.AUDIO_UUID, (bytes) => {
      let packet;
      try {
        packet = parseAudioPacket(bytes);
      } catch {
        malformed += 1;
        return;
      }
      if (reassembler) onPacket(packet);
      else if (early.length < 64) early.push(packet);
    }, (e) => {
      if (!audioClosed) log.warn?.("[PrismRecorder] audio notifications stopped:", e?.message ?? e);
    });
    const startedAt = Date.now();

    try {
      progress({ phase: "STARTING", requestedSamples: requested });
      const previousTag = latestStatus?.tag ?? 0;
      const started = waitForStatus((s) => s.error !== null || (s.state === "RECORDING" && s.tag !== previousTag),
        limits.startMs, "starting the recording");
      await command(encodeStart(requested));
      const first = await started;
      if (first.state !== "RECORDING") {
        throw new RecorderError(first.error === "BUSY" ? RECORDER_ERROR.BUSY : RECORDER_ERROR.START_REFUSED,
          `The device refused to record (${first.error}).`, { deviceError: first.error });
      }
      if (first.sampleRate !== PRISM_BLE.SAMPLE_RATE) {
        throw new RecorderError(RECORDER_ERROR.UNSUPPORTED_DEVICE, `The device records at ${first.sampleRate} Hz.`);
      }
      const recordedAt = now().toISOString();
      const tag = first.tag;
      reassembler = new AudioReassembler({ tag, samplesPerPacket: first.samplesPerPacket, requestedSamples: requested });
      for (const packet of early.splice(0)) onPacket(packet);

      // Recording: progress from the device status; finished when READY (or ERROR) for this tag.
      const finished = waitForStatus((s) => s.tag === tag && s.done && (s.state === "READY" || s.state === "ERROR"),
        Math.ceil((requested / PRISM_BLE.SAMPLE_RATE) * 1000) + limits.finishMarginMs, "recording");
      const stopProgress = (() => {
        const listener = ({ status }) => {
          if (status?.tag === tag && status.state === "RECORDING") {
            progress({ phase: "RECORDING", requestedSamples: requested, capturedSamples: status.nSamples,
              receivedSamples: reassembler.receivedSamples });
          }
        };
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      })();
      let final;
      try {
        final = await finished;
      } finally {
        stopProgress();
      }
      if (abortRequested || final.error === "ABORTED") {
        throw new RecorderError(RECORDER_ERROR.ABORTED, "The recording was stopped.");
      }
      if (final.error && final.error !== "EXPIRED") {
        throw new RecorderError(RECORDER_ERROR.DEVICE_ERROR, `The device reported an error while recording (${final.error}).`,
          { deviceError: final.error });
      }

      // Transfer: let packets still in flight arrive (the READY status can overtake the last audio
      // packets between the two characteristics), then ask again for whatever is still missing.
      const settleUntil = Date.now() + limits.settleMs;
      while (reassembler.missingPackets > 0 && Date.now() < settleUntil) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await sendChain;
      let rounds = 0;
      while (reassembler.missingPackets > 0 && rounds < limits.resendRounds) {
        rounds += 1;
        progress({ phase: "TRANSFERRING", requestedSamples: requested, receivedSamples: reassembler.receivedSamples,
          missingPackets: reassembler.missingPackets, round: rounds });
        const before = statusCount;
        const settled = waitForStatus((s) => s.tag === tag && s.state === "READY" && s.resendQueue === 0 && statusCount > before,
          limits.resendRoundMs, "sending missing audio again");
        for (const range of reassembler.missingRanges().slice(0, 16)) await command(encodeSend(range.offset, range.count));
        const status = await settled;
        if (status.error === "EXPIRED") break; // the device no longer holds part of the missing audio
      }

      progress({ phase: "VERIFYING", requestedSamples: requested, receivedSamples: reassembler.receivedSamples });
      const result = reassembler.finalize({ nSamples: final.nSamples, sampleRate: final.sampleRate, crc: final.crc });
      let meta = null;
      try {
        const m = parseJson(await transport.read(PRISM_BLE.META_UUID));
        meta = m.tag === tag ? m : null;
      } catch (e) {
        log.warn?.("[PrismRecorder] capture metadata not read:", e?.message ?? e);
      }
      const transfer = {
        requested_samples: requested,
        received_samples: result.nSamples,
        packets: result.packets,
        missing_packets: result.missingPackets,
        duplicate_packets: result.duplicates,
        foreign_packets: result.foreign,
        malformed_packets: malformed,
        invalid_packets: result.invalid.length,
        live_gap_requests: gapRequests,
        resend_rounds: rounds,
        samples_per_packet: first.samplesPerPacket,
        mtu: device?.mtu ?? null,
        crc32_device: result.crcDevice,
        crc32_phone: result.crcPhone,
        verified: result.ok,
        failures: result.failures,
        duration_ms: Date.now() - startedAt,
      };
      if (!result.ok) {
        const crc = result.failures.includes("crc_mismatch");
        throw new RecorderError(crc ? RECORDER_ERROR.CRC_MISMATCH : RECORDER_ERROR.TRANSFER_INCOMPLETE,
          crc ? "The received audio does not match the device's checksum."
            : `The recording did not arrive complete (${result.failures.join(", ")}; ${result.missingPackets} packet(s) missing).`,
          { transfer });
      }
      try {
        await command(encodeRelease(tag));
      } catch (e) {
        log.warn?.("[PrismRecorder] release not sent:", e?.message ?? e);
      }
      return {
        pcm: result.pcm,
        sampleRate: PRISM_BLE.SAMPLE_RATE,
        nSamples: result.nSamples,
        recordedAt,
        recordingId: final.recordingId || null,
        tag,
        device,
        meta,
        transfer,
      };
    } catch (e) {
      if (device && !(e instanceof RecorderError && e.code === RECORDER_ERROR.DISCONNECTED)) {
        // Stop a recording that is still running on the device (best effort).
        if (latestStatus?.state === "RECORDING") command(encodeCommand(COMMAND.ABORT)).catch(() => {});
      }
      throw e;
    } finally {
      audioClosed = true;
      try { stopAudio(); } catch { /* ignore */ }
      busy = false;
    }
  }

  /** Stop the running recording. */
  async function abort() {
    abortRequested = true;
    if (device) await command(encodeCommand(COMMAND.ABORT));
  }

  /** Blink the device's LED for 3 s. */
  async function identify() {
    await command(encodeCommand(COMMAND.IDENTIFY));
  }

  return {
    connect,
    disconnect,
    record,
    abort,
    identify,
    isConnected: () => device !== null,
    isBusy: () => busy,
    getDevice: () => device,
    getStatus: () => latestStatus,
    /** @param {(state: { connected: boolean, device: Object|null, status: Object|null }) => void} fn */
    subscribe(fn) {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },
  };
}
