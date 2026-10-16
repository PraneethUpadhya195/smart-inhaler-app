/**
 * services/test_ble.js — the BLE recording path without the hardware.
 *
 * 1. Protocol codec (services/ble/protocol.js): commands, status, audio packets, CRC-32 (against
 *    node:zlib), base64 (against Buffer).
 * 2. AudioReassembler: order, gaps, duplicates, foreign and invalid packets, verification.
 * 3. PrismRecorder against the protocol simulator (services/ble/testing/fakePrismDevice.js):
 *    a clean recording, lost packets recovered live and after the recording, unrecoverable loss,
 *    corrupted audio, wrong checksum, disconnect, a hung device, refusals, wrong sample rate,
 *    protocol version or MTU, concurrent and unconnected use.
 * 4. BlePcmSource: int16 → float32 exactly as the WAV path.
 * 5. The lifecycle end to end (services/recordingWorkflow.js): a bundled reference recording streamed
 *    by the simulator → recorder → InferencePipeline.run() + Stage 9 + V3 state → session record →
 *    local store → sync. The BLE result equals the WAV result for the same samples. Failure paths.
 * 6. V3 sitting rule against the research replay of the 361 reference recordings
 *    (../PRISM smart inhaler/results; SKIPPED when absent unless PRISM_REQUIRE_DATASET=1).
 * 7. The simulator is not reachable from the app.
 *
 * The real ESP32 and phone are not exercised here (see firmware/README.md and the device checks).
 * Run: node services/test_ble.js   (part of npm test)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import {
  PRISM_BLE, COMMAND, encodeStart, encodeSend, encodeRelease, encodeCommand, parseStatus, parseAudioPacket,
  parseJson, crc32Bytes, crc32Int16, toBase64, fromBase64, ProtocolError,
} from "./ble/protocol.js";
import AudioReassembler from "./ble/AudioReassembler.js";
import { createPrismRecorder, RECORDER_ERROR, RecorderError } from "./ble/PrismRecorder.js";
import { createFakePrismTransport } from "./ble/testing/fakePrismDevice.js";
import { createRecordingWorkflow, LIFECYCLE } from "./recordingWorkflow.js";
import { analyseHardwareRecording, deviceHistory, CAPTURE_SCHEMA } from "./hardwareSession.js";
import { createLocalSessionStore } from "./localSessionStore.js";
import { createSyncService } from "./syncService.js";
import { assertFirestoreSafe } from "./sessionRecord.js";
import BlePcmSource from "../pipeline/sources/BlePcmSource.js";
import WavPcmSource from "../pipeline/sources/WavPcmSource.js";
import { decodeWav, encodeWav } from "../pipeline/wav.js";
import { createNodePipeline } from "../pipeline/runtime/node.js";
import { assessRecording, validateAssessmentOutput } from "../pipeline/ReferenceAssessment.js";
import { segmentSittings, personalReferenceStatus, PERSONAL_BLOCKERS } from "../pipeline/PersonalReferenceStatus.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let passed = 0;
let failed = 0;
let skipped = 0;
function check(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}
async function test(name, fn) {
  console.log(name);
  try {
    await fn();
  } catch (e) {
    failed++;
    console.error(`  FAIL: threw ${e?.stack ?? e}`);
  }
}
async function rejectsWith(promise, code, message) {
  try {
    await promise;
    check(false, `${message} (no error)`);
    return null;
  } catch (e) {
    check(e instanceof RecorderError && e.code === code, `${message} (got ${e?.code ?? e?.name}: ${e?.message})`);
    return e;
  }
}
const quiet = { warn() {}, log() {} };

/** int16 samples of a bundled demo recording (a reference-dataset WAV). */
function demoInt16(n = 1) {
  const bytes = fs.readFileSync(path.join(ROOT, `assets/demo_recordings/demo_0${n}.wav`));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { samples } = decodeWav(bytes);
  const out = new Int16Array(samples.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(samples[i] * 32768);
  void view;
  return out;
}
const sameInt16 = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ─── 1. Protocol ─────────────────────────────────────────────────────────────
await test("1. Protocol codec", () => {
  check(JSON.stringify([...encodeStart(80000)]) === JSON.stringify([1, 0x80, 0x38, 0x01, 0x00]), "START 80000 little-endian");
  check(JSON.stringify([...encodeSend(116, 232)]) === JSON.stringify([3, 116, 0, 0, 0, 232, 0, 0, 0]), "SEND offset/count");
  check(JSON.stringify([...encodeRelease(0xabcd)]) === JSON.stringify([4, 0xcd, 0xab]), "RELEASE tag");
  check(encodeCommand(COMMAND.ABORT)[0] === 2 && encodeCommand(COMMAND.IDENTIFY)[0] === 5, "ABORT, IDENTIFY");
  let threw = false;
  try { encodeStart(-1); } catch { threw = true; }
  check(threw, "a negative sample count is refused");

  const statusBytes = Uint8Array.from('{"p":1,"st":"READY","tag":513,"rid":"a7103f6a","n":80000,"req":80000,"sr":8000,"crc":"BE09944F","spp":116,"mtu":247,"sent":690,"q":0,"done":true,"err":null}', (c) => c.charCodeAt(0));
  const s = parseStatus(statusBytes);
  check(s.state === "READY" && s.tag === 513 && s.nSamples === 80000 && s.crc === "be09944f" && s.samplesPerPacket === 116
    && s.done === true && s.error === null, "status parsed (a real firmware status line)");
  const notDone = parseStatus(Uint8Array.from('{"p":1,"st":"RECORDING","tag":5,"rid":"x","n":2560,"req":80000,"sr":8000,"crc":"00000000","spp":116,"mtu":247,"sent":20,"q":0,"done":false,"err":null}', (c) => c.charCodeAt(0)));
  check(notDone.crc === null && notDone.state === "RECORDING", "no CRC before the recording is done");
  for (const bad of ['{"p":1,"st":"DANCING"}', "not json", '{"p":1,"st":"IDLE","tag":-1,"n":0,"req":0,"sr":8000,"spp":1,"mtu":23}']) {
    let err = null;
    try { parseStatus(Uint8Array.from(bad, (c) => c.charCodeAt(0))); } catch (e) { err = e; }
    check(err instanceof ProtocolError, `malformed status refused: ${bad}`);
  }

  const packet = new Uint8Array(12 + 6);
  const view = new DataView(packet.buffer);
  packet[0] = 0xa1; packet[1] = 1; view.setUint16(2, 777, true); view.setUint32(4, 3, true); view.setUint32(8, 348, true);
  view.setInt16(12, -32768, true); view.setInt16(14, 32767, true); view.setInt16(16, -1, true);
  const p = parseAudioPacket(packet);
  check(p.tag === 777 && p.seq === 3 && p.offset === 348 && sameInt16(p.samples, Int16Array.of(-32768, 32767, -1)), "audio packet decoded (int16 LE)");
  for (const [bytes, what] of [[packet.subarray(0, 12), "header only"], [Uint8Array.of(0xa2, ...packet.subarray(1)), "wrong type"],
    [packet.subarray(0, 17), "odd payload"]]) {
    let err = null;
    try { parseAudioPacket(bytes); } catch (e) { err = e; }
    check(err instanceof ProtocolError, `malformed packet refused: ${what}`);
  }

  check(crc32Bytes(Uint8Array.from("123456789", (c) => c.charCodeAt(0))) === "cbf43926", "CRC-32 check value");
  const pcm = demoInt16(1);
  const le = new Uint8Array(pcm.buffer.slice(0));
  check(crc32Int16(pcm) === zlib.crc32(le).toString(16).padStart(8, "0"), "CRC-32 of int16 samples = zlib.crc32 of their LE bytes");
  for (const n of [0, 1, 2, 3, 4, 245]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
    const b64 = toBase64(bytes);
    check(b64 === Buffer.from(bytes).toString("base64") && sameInt16(Int16Array.from(fromBase64(b64)), Int16Array.from(bytes)),
      `base64 round trip, ${n} bytes`);
  }
  check(parseJson(Uint8Array.from('{"a":1}', (c) => c.charCodeAt(0))).a === 1, "JSON characteristic");
});

// ─── 2. Reassembler ──────────────────────────────────────────────────────────
function packetsOf(pcm, tag, spp) {
  const packets = [];
  for (let seq = 0; seq * spp < pcm.length; seq++) {
    packets.push({ version: 1, tag, seq, offset: seq * spp, samples: pcm.slice(seq * spp, Math.min(pcm.length, (seq + 1) * spp)) });
  }
  return packets;
}
await test("2. Audio reassembly", () => {
  const pcm = demoInt16(2).subarray(0, 10000);
  const crc = crc32Int16(pcm);
  const packets = packetsOf(pcm, 42, 116);
  const r = new AudioReassembler({ tag: 42, samplesPerPacket: 116, requestedSamples: 10000 });
  const gaps = [];
  packets.forEach((p, i) => { if (i !== 5 && i !== 6 && i !== 40) { const { gap } = r.accept(p); if (gap) gaps.push(gap); } });
  check(gaps.length === 2 && gaps[0].offset === 5 * 116 && gaps[0].count === 2 * 116 && gaps[1].offset === 40 * 116,
    `gaps reported as they happen ${JSON.stringify(gaps)}`);
  check(JSON.stringify(r.missingRanges()) === JSON.stringify([{ offset: 580, count: 232 }, { offset: 4640, count: 116 }]),
    "missing ranges merged and packet-aligned");
  const incomplete = r.finalize({ nSamples: 10000, sampleRate: 8000, crc });
  check(!incomplete.ok && incomplete.pcm === null && incomplete.failures.includes("missing_packets"), "incomplete audio is not returned");
  r.accept(packets[6]); r.accept(packets[5]); r.accept(packets[40]); r.accept(packets[40]);
  r.accept({ ...packets[1], tag: 43 });
  r.accept({ ...packets[2], offset: 1 });
  r.accept({ ...packets[3], samples: packets[3].samples.subarray(0, 10) });
  r.accept({ ...packets[3], version: 2 });
  r.accept({ ...packets[3], seq: 999, offset: 999 * 116 });
  check(r.duplicates === 1 && r.foreign === 1 && r.invalid.length === 4, `duplicates ${r.duplicates}, foreign ${r.foreign}, invalid ${r.invalid.length}`);
  const ok = r.finalize({ nSamples: 10000, sampleRate: 8000, crc });
  check(ok.ok && sameInt16(ok.pcm, pcm) && ok.crcPhone === crc, "complete, in any order: verified and identical");
  check(r.finalize({ nSamples: 10000, sampleRate: 16000, crc }).failures.includes("sample_rate"), "16 kHz refused");
  check(r.finalize({ nSamples: 9000, sampleRate: 8000, crc }).failures.includes("length"), "short recording refused");
  check(r.finalize({ nSamples: 10000, sampleRate: 8000, crc: "00000000" }).failures.includes("crc_mismatch"), "checksum mismatch refused");
  check(r.finalize({ nSamples: 10000, sampleRate: 8000, crc: null }).failures.includes("no_device_crc"), "no device checksum refused");
});

// ─── 3. Recorder ─────────────────────────────────────────────────────────────
const SHORT = { startMs: 2000, finishMarginMs: 3000, resendRoundMs: 2000 };
async function recorderWith(faults = {}, n = 1) {
  const transport = createFakePrismTransport({ source: demoInt16(n), faults });
  const recorder = createPrismRecorder({ transport, log: quiet, timeouts: SHORT });
  return { transport, recorder };
}

await test("3a. Recorder: clean recording", async () => {
  const { transport, recorder } = await recorderWith();
  const device = await recorder.connect();
  check(device.deviceId === "prism-esp32-fake" && device.sampleRate === 8000 && device.mtu === 247, "device information read");
  const phases = [];
  const rec = await recorder.record({ nSamples: 80000, onProgress: (p) => phases.push(p.phase) });
  const source = demoInt16(1);
  check(sameInt16(rec.pcm, source.subarray(0, 80000)), "received samples are the device's samples");
  check(rec.transfer.verified && rec.transfer.missing_packets === 0 && rec.transfer.packets === Math.ceil(80000 / 116)
    && rec.transfer.crc32_phone === rec.transfer.crc32_device, `transfer verified ${JSON.stringify(rec.transfer)}`);
  check(phases[0] === "STARTING" && phases.includes("RECORDING") && phases.at(-1) === "VERIFYING", `progress phases ${[...new Set(phases)]}`);
  check(transport.log.commands.at(-1) === COMMAND.RELEASE, "the device is told to release the verified recording");
  check(typeof rec.recordedAt === "string" && !Number.isNaN(Date.parse(rec.recordedAt)), "recording start time");
  check(rec.meta?.raw_or === "ffffff00", "capture metadata read");
});

await test("3b. Recorder: lost packets", async () => {
  const live = await recorderWith({ dropEvery: 7 });
  await live.recorder.connect();
  const rec = await live.recorder.record({ nSamples: 80000 });
  check(rec.transfer.verified && rec.transfer.live_gap_requests > 50 && sameInt16(rec.pcm, demoInt16(1).subarray(0, 80000)),
    `every 7th packet lost: recovered live (${rec.transfer.live_gap_requests} requests)`);

  const late = await recorderWith({ dropSeqs: new Set([0, 1, 300, 689]), dropResends: false });
  // the live request for the last packet cannot happen (nothing follows it): it is asked for after READY
  await late.recorder.connect();
  const rec2 = await late.recorder.record({ nSamples: 80000 });
  check(rec2.transfer.verified && rec2.transfer.resend_rounds >= 1, `trailing loss recovered after the recording (${rec2.transfer.resend_rounds} round)`);

  const overtaken = await recorderWith({ statusOvertakes: true });
  await overtaken.recorder.connect();
  const rec4 = await overtaken.recorder.record({ nSamples: 80000 });
  check(rec4.transfer.verified && rec4.transfer.resend_rounds === 0,
    `READY before the last packet (phone ordering): waited, no resend needed (${rec4.transfer.resend_rounds} rounds)`);

  const lost = await recorderWith({ dropEvery: 9, dropResends: true });
  await lost.recorder.connect();
  const e = await rejectsWith(lost.recorder.record({ nSamples: 40000 }), RECORDER_ERROR.TRANSFER_INCOMPLETE, "unrecoverable loss");
  check(e?.details?.transfer?.missing_packets > 0 && e.details.transfer.verified === false, "the failure reports what is missing");
  check(!lost.transport.log.commands.includes(COMMAND.RELEASE), "an unverified recording is not released");

  const dup = await recorderWith({ duplicateEvery: 5, foreignAt: 10 });
  await dup.recorder.connect();
  const rec3 = await dup.recorder.record({ nSamples: 16000 });
  check(rec3.transfer.verified && rec3.transfer.duplicate_packets > 0 && rec3.transfer.foreign_packets === 1,
    "duplicates and a packet of another recording are ignored");
});

await test("3c. Recorder: corrupted audio and wrong checksum", async () => {
  const corrupt = await recorderWith({ corruptPayloadAt: 50 });
  await corrupt.recorder.connect();
  await rejectsWith(corrupt.recorder.record({ nSamples: 16000 }), RECORDER_ERROR.CRC_MISMATCH, "a changed sample is caught by the CRC");
  const wrong = await recorderWith({ wrongCrc: true });
  await wrong.recorder.connect();
  await rejectsWith(wrong.recorder.record({ nSamples: 16000 }), RECORDER_ERROR.CRC_MISMATCH, "a wrong device checksum");
});

await test("3d. Recorder: disconnect, hang, refusals", async () => {
  const drop = await recorderWith({ disconnectAtSeq: 200 });
  await drop.recorder.connect();
  await rejectsWith(drop.recorder.record({ nSamples: 80000 }), RECORDER_ERROR.DISCONNECTED, "disconnect while recording");
  check(!drop.recorder.isConnected() && !drop.recorder.isBusy(), "disconnected and idle afterwards");
  await rejectsWith(drop.recorder.record(), RECORDER_ERROR.NOT_CONNECTED, "recording without a connection");

  const hang = await recorderWith({ stallAtSeq: 30 });
  await hang.recorder.connect();
  await rejectsWith(hang.recorder.record({ nSamples: 8000 }), RECORDER_ERROR.TIMEOUT, "a device that stops answering");

  const busy = await recorderWith({ refuseStart: "BUSY" });
  await busy.recorder.connect();
  await rejectsWith(busy.recorder.record({ nSamples: 8000 }), RECORDER_ERROR.BUSY, "device busy");
  const mem = await recorderWith({ refuseStart: "NO_MEMORY" });
  await mem.recorder.connect();
  const e = await rejectsWith(mem.recorder.record({ nSamples: 8000 }), RECORDER_ERROR.START_REFUSED, "device refuses");
  check(e?.details?.deviceError === "NO_MEMORY", "the device's reason is kept");

  const twice = await recorderWith();
  await twice.recorder.connect();
  const first = twice.recorder.record({ nSamples: 16000 });
  await rejectsWith(twice.recorder.record({ nSamples: 16000 }), RECORDER_ERROR.BUSY, "a second recording while one runs");
  check((await first).transfer.verified, "the first recording is unaffected");
  await rejectsWith(twice.recorder.record({ nSamples: 10 ** 7 }), RECORDER_ERROR.START_REFUSED, "more samples than the device allows");
});

await test("3e. Recorder: unsupported devices", async () => {
  for (const [faults, code, what] of [
    [{ sampleRate: 16000 }, RECORDER_ERROR.UNSUPPORTED_DEVICE, "16 kHz device"],
    [{ protocolVersion: 2 }, RECORDER_ERROR.PROTOCOL_MISMATCH, "other protocol version"],
    [{ mtu: 23 }, RECORDER_ERROR.UNSUPPORTED_DEVICE, "MTU 23"],
  ]) {
    const { recorder } = await recorderWith(faults);
    await rejectsWith(recorder.connect(), code, what);
    check(!recorder.isConnected(), `${what}: not left connected`);
  }
});

// ─── 4. BlePcmSource ─────────────────────────────────────────────────────────
await test("4. BlePcmSource conversion", async () => {
  const pcm = demoInt16(3);
  const ble = await new BlePcmSource(pcm, { sourceId: "x", recordedAt: "2026-10-16T10:00:00.000Z" }).acquire();
  const wav = await new WavPcmSource(encodeWav(pcm, 8000)).acquire();
  check(ble.samples.length === wav.samples.length && ble.samples.every((v, i) => v === wav.samples[i]),
    "BLE samples = the same samples read from a 16-bit WAV (float32 = int16 / 32768)");
  check(ble.inputDomain === "prism_hardware" && ble.sampleRate === 8000 && ble.channels === 1 && ble.sourceType === "ble",
    "input domain prism_hardware, 8 kHz mono");
  check(Math.max(...ble.samples.map(Math.abs)) <= 1 && ble.samples.includes(pcm[0] / 32768), "full scale within [-1, 1]");
  const original = fs.readFileSync(path.join(ROOT, "assets/demo_recordings/demo_03.wav"));
  check(sameInt16(Int16Array.from(decodeWav(encodeWav(pcm, 8000)).samples, (v) => Math.round(v * 32768)), pcm)
    && decodeWav(original).samples.length === pcm.length, "WAV encoder round trip");
  let threw = false;
  try { new BlePcmSource(Float32Array.of(0)); } catch { threw = true; }
  check(threw, "only int16 recordings are accepted");
});

// ─── 5. Workflow end to end ──────────────────────────────────────────────────
function memoryStorage() {
  const map = new Map();
  return {
    map,
    async getItem(k) { return map.has(k) ? map.get(k) : null; },
    async setItem(k, v) { map.set(k, v); },
    async getAllKeys() { return [...map.keys()]; },
    async multiGet(keys) { return keys.map((k) => [k, map.has(k) ? map.get(k) : null]); },
  };
}

let clock = Date.parse("2026-10-16T09:00:00.000Z");
const now = () => (clock += 1000);

await test("5a. Workflow: device → analysis → local store → sync", async () => {
  const pipeline = await createNodePipeline();
  const getPipeline = async () => pipeline;
  const { transport, recorder } = await recorderWith({ dropEvery: 11 }, 1);
  const store = createLocalSessionStore(memoryStorage(), { log: quiet });
  const uploaded = new Map();
  const sync = createSyncService({ store, uploadSession: async (uid, rec) => { uploaded.set(rec.session_id, rec); return rec.session_id; },
    getUserId: async () => "uid-test", sessionExistsRemotely: async () => false, log: quiet });
  const states = [];
  const kept = [];
  const workflow = createRecordingWorkflow({
    recorder,
    keepAudio: async (r) => { kept.push(encodeWav(r.pcm, r.sampleRate)); return `ble_${r.recordingId}.wav`; },
    analyse: (r, { audioFile }) => analyseHardwareRecording(getPipeline, r, { audioFile, history: [], now }),
    save: async (record) => (await store.saveSession(record)).record.session_id,
    onState: (s) => states.push(s.phase),
    log: quiet,
  });
  const result = await workflow.run({ nSamples: 96000 });
  check(result !== null, "workflow completed");
  const order = [...new Set(states)];
  check(JSON.stringify(order) === JSON.stringify(["CONNECTING", "READY", "RECORDING", "TRANSFERRING", "ANALYSING", "COMPLETED"]),
    `lifecycle ${order.join(" → ")}`);
  const record = result.record;
  // The same samples through the WAV path (the reference-dataset analysis of demo_01).
  const wavOut = await pipeline.run(new WavPcmSource(fs.readFileSync(path.join(ROOT, "assets/demo_recordings/demo_01.wav"))));
  const bleOut = record.recordings[0];
  check(bleOut.input.input_domain === "prism_hardware" && bleOut.baseline_domain_validated === false
    && bleOut.input.n_samples === 96000 && bleOut.input.recorded_at === record.capture.recorded_at, "BLE input metadata");
  check(JSON.stringify(bleOut.events) === JSON.stringify(wavOut.events) && bleOut.recording_status === wavOut.recording_status,
    `BLE path = WAV path for the same samples (${bleOut.recording_status}, ${bleOut.n_events} event(s))`);
  check(record.source === "ble" && record.simulated === false && record.device_id === "prism-esp32-fake"
    && record.session_status === "SCORE_ONLY", `session ${record.session_status} from the device`);
  check(record.capture.schema === CAPTURE_SCHEMA && record.capture.integrity.verified && record.capture.integrity.live_gap_requests > 0
    && record.capture.audio.stored === "local_only" && record.capture.audio.file.startsWith("ble_"), "capture block (integrity, local audio)");
  check(sameInt16(Int16Array.from(decodeWav(kept[0]).samples, (v) => Math.round(v * 32768)), demoInt16(1).subarray(0, 96000)),
    "the WAV kept on the phone holds exactly the received samples");
  const assessment = record.assessments[0];
  validateAssessmentOutput(assessment);
  const direct = await assessRecording(pipeline, bleOut, await new BlePcmSource(demoInt16(1).subarray(0, 96000)).acquire());
  check(JSON.stringify(assessment.events) === JSON.stringify(direct.events) && assessment.baseline_domain_validated === false,
    `Stage 9 kept separately (${assessment.events.map((e) => `${e.assessment}/${e.assessment_reliability}`)})`);
  check(record.personal.available === false && record.personal.personal_status === "WARMUP"
    && record.personal.events.every((e) => e.personal_deviation === null)
    && record.personal.blockers.includes(PERSONAL_BLOCKERS.SITTING_DEFINITION_INCOMPATIBLE), "V3 state: unavailable, no personal deviation");
  assertFirestoreSafe(record);
  passed++;
  check(!JSON.stringify(record).includes("pcm") || !("pcm" in record), "no raw audio in the record");
  const stored = await store.getSession(result.sessionId);
  check(stored?.sync.state === "pending" && JSON.stringify(stored.record) === JSON.stringify(record), "stored on the phone first (pending)");
  const status = await sync.syncNow();
  check(status.lastOutcome === "synced" && uploaded.has(result.sessionId), `uploaded by the sync service (${status.lastOutcome})`);
  check(!JSON.stringify(uploaded.get(result.sessionId)).includes("RIFF"), "no audio uploaded");
  check((await store.getSession(result.sessionId)).sync.state === "synced", "marked synced");
  await sync.syncNow();
  check(uploaded.size === 1, "a second sync does not upload again");
  void transport;
});

await test("5b. Workflow: failures", async () => {
  const pipeline = await createNodePipeline();
  const store = createLocalSessionStore(memoryStorage(), { log: quiet });
  const run = async (faults, extra = {}) => {
    const { recorder } = await recorderWith(faults, 2);
    const states = [];
    let keepCalls = 0;
    const workflow = createRecordingWorkflow({
      recorder,
      keepAudio: async () => { keepCalls += 1; return null; },
      analyse: (r) => analyseHardwareRecording(extra.getPipeline ?? (async () => pipeline), r, { now }),
      save: async (record) => (await store.saveSession(record)).record.session_id,
      onState: (s) => states.push(s),
      log: quiet,
    });
    const result = await workflow.run({ nSamples: 24000 });
    return { result, states, last: states.at(-1), keepCalls, workflow };
  };
  const before = (await store.listSessions()).entries.length;
  const dropped = await run({ disconnectAtSeq: 40 });
  check(dropped.result === null && dropped.last.phase === LIFECYCLE.ERROR && dropped.last.error.code === RECORDER_ERROR.DISCONNECTED
    && dropped.last.error.needsConnection && dropped.last.failedPhase === LIFECYCLE.RECORDING, "disconnect → ERROR, offers Connect");
  check(dropped.keepCalls === 0 && (await store.listSessions()).entries.length === before, "nothing kept or saved from a failed transfer");
  const corrupt = await run({ corruptPayloadAt: 3 });
  check(corrupt.last.phase === LIFECYCLE.ERROR && corrupt.last.error.code === RECORDER_ERROR.CRC_MISMATCH
    && !corrupt.last.error.needsConnection && corrupt.last.error.transfer?.verified === false, "corrupted transfer → ERROR, offers retry");
  const notFound = await run({}, {});
  check(notFound.result !== null, "a retry with a healthy device completes");
  const broken = await run({}, { getPipeline: async () => { throw new Error("model could not be loaded"); } });
  check(broken.result?.record.session_status === "PROCESSING_ERROR" && /model could not be loaded/.test(broken.result.record.processing_errors[0].message)
    && broken.result.record.assessments === null && broken.result.record.personal === null,
    "analysis failure: the recording's session is stored as a processing error, not lost");
  dropped.workflow.reset();
  check(dropped.workflow.getState().phase === LIFECYCLE.IDLE, "reset to IDLE");
});

await test("5c. Personal-reference state from the device history", () => {
  const sessions = [
    { source: "ble", device_id: "dev-a", recorded_at: "2026-10-16T08:00:00.000Z", n_scored: 1, n_events: 1 },
    { source: "ble", device_id: "dev-a", recorded_at: "2026-10-16T08:10:00.000Z", n_scored: 2, n_events: 2 },
    { source: "ble", device_id: "dev-b", recorded_at: "2026-10-16T08:12:00.000Z", n_scored: 9, n_events: 9 },
    { source: "wav", device_id: null, recorded_at: "2026-10-16T08:13:00.000Z", n_scored: 9, n_events: 9 },
    { source: "ble", device_id: "dev-a", recorded_at: null, n_scored: 9, n_events: 9 },
  ];
  const history = deviceHistory(sessions, "dev-a");
  check(history.length === 2, "only this device's BLE recordings with a time count");
  const status = personalReferenceStatus({ deviceId: "dev-a", history,
    current: { recordedAt: "2026-10-16T08:30:00.000Z", events: [{ event_id: 0, status: "SCORE_ONLY" }, { event_id: 1, status: "NOT_SCOREABLE" }] } });
  check(status.n_sittings === 1 && status.current_sitting.n_scoreable_events === 4 && status.n_qualifying_sittings === 0
    && status.personal_status === "WARMUP" && status.available === false, `one sitting (gaps <= 25 min), 4 scoreable events: ${JSON.stringify(status.current_sitting)}`);
  check(status.events[0].personal_assessment === "POPULATION_ONLY" && status.events[1].personal_assessment === "NOT_ASSESSED",
    "V3 warm-up assessments");
  const later = personalReferenceStatus({ deviceId: "dev-a", history,
    current: { recordedAt: "2026-10-16T09:00:00.001Z", events: [] } });
  check(later.n_sittings === 2, "a recording more than 25 min later opens a new sitting");
  const none = personalReferenceStatus({ deviceId: null, history: [], current: { recordedAt: "2026-10-16T09:00:00Z", events: [] } });
  check(none.blockers.includes(PERSONAL_BLOCKERS.NO_DEVICE) && none.n_sittings === 0, "no device id: no personal reference");
});

// ─── 6. V3 sitting rule vs the research replay ──────────────────────────────
await test("6. V3 sittings = research replay of the 361 reference recordings", () => {
  const res = path.resolve(ROOT, "..", "PRISM smart inhaler", "results");
  const recCsv = path.join(res, "final_assessment", "e2e_deployment_recordings.csv");
  const sitCsv = path.join(res, "personal_reference", "real_corpus_replay_sittings.csv");
  if (!fs.existsSync(recCsv) || !fs.existsSync(sitCsv)) {
    skipped++;
    console.log("  SKIPPED: research results not found");
    return;
  }
  const rows = (file) => {
    const [head, ...lines] = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
    const keys = head.split(",");
    return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [keys[i], v])));
  };
  const toIso = (f) => {
    const m = /^rec(\d{4}-\d{2}-\d{2})_(\d{2})h(\d{2})m(\d{2}\.\d{3})s\.wav$/.exec(f);
    return `${m[1]}T${m[2]}:${m[3]}:${m[4]}`;
  };
  const recordings = rows(recCsv).filter((r) => r.mode === "deployment")
    .map((r) => ({ recordedAt: toIso(r.recording_file), nScoreable: Number(r.n_scoreable), nEvents: Number(r.n_events) }))
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  check(recordings.length === 361, `${recordings.length} recordings`);
  const sittings = segmentSittings(recordings);
  const expected = rows(sitCsv).filter((r) => r.config_id === "prism-personal-v3-provisional-9of10");
  check(sittings.length === expected.length && sittings.length === 23, `${sittings.length} sittings (research ${expected.length})`);
  let same = 0;
  sittings.forEach((s, i) => {
    const e = expected[i];
    if (e && s.startedAt === e.started_at.replace(/000$/, "") && s.endedAt === e.ended_at.replace(/000$/, "")
      && s.nRecordings === Number(e.n_recordings) && s.nEventsTotal === Number(e.n_events_total)
      && s.nScoreable === Number(e.n_qualifying_events) && s.qualifying === (e.decision !== "NOT_QUALIFYING")) same++;
  });
  check(same === expected.length, `every sitting identical: start, end, recordings, events, scoreable, qualifying (${same}/${expected.length})`);
  check(sittings.filter((s) => s.qualifying).length === 8, "8 qualifying sittings, so the replay never leaves WARMUP");
});

// ─── 7. The simulator is test-only ───────────────────────────────────────────
await test("7. No app module imports the BLE simulator", () => {
  const reachable = new Set();
  const queue = [path.join(ROOT, "App.js"), path.join(ROOT, "index.js")];
  while (queue.length > 0) {
    const file = queue.shift();
    if (reachable.has(file) || !fs.existsSync(file)) continue;
    reachable.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      let target = path.resolve(path.dirname(file), m[1]);
      if (!/\.(js|json|wav|onnx)$/.test(target)) target += ".js";
      if (target.endsWith(".js")) queue.push(target);
    }
  }
  const rel = [...reachable].map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
  check(rel.includes("App.js") && rel.length > 10, `scan covers the app (${rel.length} modules)`);
  check(!rel.some((r) => r.includes("/testing/")), `no testing module reachable from App.js (${rel.filter((r) => r.includes("testing"))})`);
});

console.log(`\n${passed} checks passed, ${failed} failed, ${skipped} section(s) skipped`);
if (skipped > 0 && process.env.PRISM_REQUIRE_DATASET === "1") {
  console.error("  FAIL: research results required (PRISM_REQUIRE_DATASET=1)");
  process.exit(1);
}
process.exit(failed === 0 ? 0 : 1);
