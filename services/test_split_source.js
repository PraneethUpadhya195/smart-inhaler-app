/**
 * services/test_split_source.js — Start Event sessions: the device recording is captured, verified,
 * saved and played back; the analysis runs on the reference recording chosen at Start Event.
 *
 * 1. Selection (services/analysisRecordings.js): short press → an inhalation recording, never the
 *    previous one; state kept across a restart; long press → the no-inhalation recording; invalid
 *    configuration and stored state.
 * 2. The configured recordings: bundled, byte-identical to the dataset, accepted by the pipeline
 *    unchanged (8 kHz mono PCM16), with the expected outcome (no-inhalation = golden case).
 * 3. Capture before analysis (services/recordingWorkflow.js with the protocol simulator): order of
 *    the steps, failed transfer, bad checksum, disconnect, duplicate starts, storage failure,
 *    analysis failure keeps the capture, unsaved session removes it.
 * 4. Audio sources: the analysis input is the chosen recording, the stored WAV is the capture, the
 *    playback path is the capture, no substitution when either is missing.
 * 5. Stage 9: unchanged for fixed inputs, fixed reference not modified, ineligible → no measurement,
 *    no leak between sessions, no V3 state.
 * 6. History and Trends: both kinds listed and restored, Trends counts Start Event sessions only,
 *    earlier sessions not reinterpreted, the caption and nothing else about the source is shown.
 *
 * The real ESP32, BLE radio, phone UI gestures and audio output are not exercised here.
 * Run: node services/test_split_source.js   (part of npm test)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { createPrismRecorder, RECORDER_ERROR } from "./ble/PrismRecorder.js";
import { createFakePrismTransport } from "./ble/testing/fakePrismDevice.js";
import { createRecordingWorkflow, LIFECYCLE, WORKFLOW_ERROR } from "./recordingWorkflow.js";
import { analyseHardwareRecording, analyseReferenceInput, deviceHistory } from "./hardwareSession.js";
import {
  ANALYSIS_RECORDINGS, INHALATION_RECORDINGS, NO_INHALATION_RECORDING, SELECTION, SELECTION_STATE_KEY,
  ANALYSIS_SOURCE_TYPE, createAnalysisSelector, pickAnalysisRecording, analysisRecordingOf, usesReferenceInput,
} from "./analysisRecordings.js";
import { createLocalSessionStore } from "./localSessionStore.js";
import { mergeSessionLists } from "./syncService.js";
import { assertFirestoreSafe } from "./sessionRecord.js";
import WavPcmSource from "../pipeline/sources/WavPcmSource.js";
import { decodeWav, encodeWav } from "../pipeline/wav.js";
import { createNodePipeline } from "../pipeline/runtime/node.js";
import { assessRecording, validateAssessmentOutput } from "../pipeline/ReferenceAssessment.js";
import { assessmentReferenceV1 } from "../pipeline/contractAssets.js";
import { describeSession, REFERENCE_INPUT_CAPTION } from "../utils/sessionView.js";
import { describeCapture } from "../utils/captureView.js";
import { describeResearch } from "../utils/researchView.js";
import { describeTrends } from "../utils/trendsView.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATASET = path.join(ROOT, "..", "PRISM smart inhaler", "data");
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
const quiet = { warn() {}, log() {} };
const json = (v) => JSON.stringify(v);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const readAsset = (rel) => new Uint8Array(fs.readFileSync(path.join(ROOT, "assets", rel)));
const loadAnalysisBytes = async (r) => readAsset(r.asset);

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

/** int16 samples of a WAV asset. */
function int16Of(rel) {
  const { samples } = decodeWav(readAsset(rel));
  return Int16Array.from(samples, (v) => Math.round(v * 32768));
}
const sameInt16 = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// The fake device "hears" demo_02 (any audio: the capture is never analysed in a Start Event session).
const CAPTURE_AUDIO = int16Of("demo_recordings/demo_02.wav");
const SHORT = { startMs: 2000, finishMarginMs: 3000, resendRoundMs: 2000 };
const N15 = 15 * 8000;

let clock = Date.parse("2026-10-21T09:00:00.000Z");
const now = () => (clock += 1000);

const pipeline = await createNodePipeline();
const getPipeline = async () => pipeline;

/**
 * One Start Event workflow against the simulator.
 * @param {Object} [o]
 */
function startEventRig({ faults = {}, storage = memoryStorage(), store = createLocalSessionStore(memoryStorage(), { log: quiet }),
  random = Math.random, keepAudio, loadBytes = loadAnalysisBytes, save, getPipelineFn = getPipeline } = {}) {
  const transport = createFakePrismTransport({ source: CAPTURE_AUDIO, faults });
  const recorder = createPrismRecorder({ transport, log: quiet, timeouts: SHORT });
  const selector = createAnalysisSelector({ storage, random, now: () => new Date(clock), log: quiet });
  const calls = { select: [], keep: [], analyse: [], save: 0, discard: [] };
  const states = [];
  const files = new Map(); // name -> WAV bytes ("the phone")
  const workflow = createRecordingWorkflow({
    recorder,
    selectAnalysis: async (s) => {
      calls.select.push({ s, verifiedBefore: states.some((x) => x.verified) });
      return selector.select(s);
    },
    keepAudio: keepAudio ?? (async (r) => {
      calls.keep.push({ verified: r.transfer?.verified === true });
      const name = `prism_${r.recordingId}_${clock}.wav`;
      files.set(name, encodeWav(r.pcm, r.sampleRate));
      return name;
    }),
    discardAudio: async (name) => { calls.discard.push(name); files.delete(name); },
    analyse: (r, { audioFile, analysisRecording }) => {
      calls.analyse.push({ audioFile, savedBefore: files.has(audioFile), phase: states.at(-1)?.phase });
      return analyseReferenceInput(getPipelineFn, r, { analysisRecording, loadAnalysisBytes: loadBytes, audioFile, now });
    },
    save: save ?? (async (record) => { calls.save += 1; return (await store.saveSession(record)).record.session_id; }),
    onState: (s) => states.push(s),
    log: quiet,
  });
  return { transport, recorder, workflow, selector, storage, store, calls, states, files };
}
const starts = (transport) => transport.log.commands.filter((op) => op === 1).length; // START
/** What the simulator's microphone delivers for n samples (its source, repeated). */
const heard = (n) => Int16Array.from({ length: n }, (_, i) => CAPTURE_AUDIO[i % CAPTURE_AUDIO.length]);
/** The string values of a view (not its keys). */
function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object" && !(value instanceof Date)) Object.values(value).forEach((v) => strings(v, out));
  return out;
}

// ─── 1. Selection ────────────────────────────────────────────────────────────
await test("1. Selection: short press, long press, persistence, invalid configuration", async () => {
  check(INHALATION_RECORDINGS.length === 8 && INHALATION_RECORDINGS.every((r) => r.selection === SELECTION.INHALATION),
    "8 inhalation recordings configured");
  check(new Set(ANALYSIS_RECORDINGS.map((r) => r.id)).size === ANALYSIS_RECORDINGS.length
    && new Set(ANALYSIS_RECORDINGS.map((r) => r.sha256)).size === ANALYSIS_RECORDINGS.length, "ids and SHA-256s are unique");

  const storage = memoryStorage();
  const sel = createAnalysisSelector({ storage, log: quiet });
  const picks = [];
  for (let i = 0; i < 300; i++) picks.push((await sel.select(SELECTION.INHALATION)).id);
  check(picks.every((id) => INHALATION_RECORDINGS.some((r) => r.id === id)), "short press always selects an inhalation recording");
  check(picks.every((id, i) => i === 0 || id !== picks[i - 1]), "no recording is selected twice in a row (300 presses)");
  check(new Set(picks).size === 8, `every inhalation recording is used (${new Set(picks).size} of 8)`);

  // Restart: a new selector over the same phone storage still avoids the last choice.
  const last = picks.at(-1);
  check(JSON.parse(storage.map.get(SELECTION_STATE_KEY)).last_inhalation_id === last, "selection state is stored on the phone");
  for (const prev of INHALATION_RECORDINGS) {
    for (const r of [0, 0.5, 0.9999999]) {
      storage.map.set(SELECTION_STATE_KEY, json({ last_inhalation_id: prev.id })); // state left by the previous app run
      const pick = await createAnalysisSelector({ storage, random: () => r, log: quiet }).select(SELECTION.INHALATION); // new instance = restart
      if (pick.id === prev.id) check(false, `after a restart ${prev.id} was repeated (random ${r})`);
      else passed++;
      check(JSON.parse(storage.map.get(SELECTION_STATE_KEY)).last_inhalation_id === pick.id, "the new choice is stored");
    }
  }

  // Long press: always the no-inhalation recording, and it leaves the short-press state alone.
  const before = storage.map.get(SELECTION_STATE_KEY);
  for (let i = 0; i < 5; i++) {
    const pick = await sel.select(SELECTION.NO_INHALATION);
    check(pick.id === NO_INHALATION_RECORDING.id && pick.selection === SELECTION.NO_INHALATION, "long press selects the no-inhalation recording");
  }
  check(storage.map.get(SELECTION_STATE_KEY) === before, "long press does not change the short-press state");
  check(pickAnalysisRecording(SELECTION.NO_INHALATION, { random: () => 0.3 }) === NO_INHALATION_RECORDING, "long press is not random");

  // Invalid configuration and stored state.
  let threw = 0;
  for (const fn of [() => pickAnalysisRecording("both"), () => pickAnalysisRecording(undefined),
    () => pickAnalysisRecording(SELECTION.INHALATION, { inhalation: [] })]) {
    try { fn(); } catch { threw++; }
  }
  check(threw === 3, "unknown selection or an empty inhalation set is refused");
  const one = [INHALATION_RECORDINGS[3]];
  check(pickAnalysisRecording(SELECTION.INHALATION, { inhalation: one, previousId: one[0].id }) === one[0], "with one recording it may repeat");
  for (const bad of ["{not json", json({ last_inhalation_id: "ref-unknown" }), json([1, 2]), json(null)]) {
    const s = memoryStorage();
    s.map.set(SELECTION_STATE_KEY, bad);
    const pick = await createAnalysisSelector({ storage: s, random: () => 0, log: quiet }).select(SELECTION.INHALATION);
    check(pick.id === INHALATION_RECORDINGS[0].id, `unreadable stored state is ignored (${bad})`);
  }
  const failing = { async getItem() { throw new Error("disk"); }, async setItem() { throw new Error("disk"); } };
  check((await createAnalysisSelector({ storage: failing, log: quiet }).select(SELECTION.INHALATION)).selection === SELECTION.INHALATION,
    "a storage failure does not block the selection");
});

// ─── 2. Configured recordings ────────────────────────────────────────────────
await test("2. The configured analysis recordings are valid pipeline inputs", async () => {
  const loader = fs.readFileSync(path.join(ROOT, "services/analysisAudio.js"), "utf8");
  for (const r of ANALYSIS_RECORDINGS) {
    const bytes = readAsset(r.asset);
    check(sha256(bytes) === r.sha256, `${r.id}: SHA-256 matches`);
    check(loader.includes(`"${r.asset}": require("../assets/${r.asset}")`), `${r.id}: bundled by services/analysisAudio.js`);
    const dataset = path.join(DATASET, r.recordingId);
    if (fs.existsSync(dataset)) check(sha256(fs.readFileSync(dataset)) === r.sha256, `${r.id}: byte-identical to the dataset file`);
    else if (process.env.PRISM_REQUIRE_DATASET === "1") check(false, `${r.id}: dataset file missing`);
    const { sampleRate, channels, samples } = decodeWav(bytes);
    check(sampleRate === 8000 && channels === 1 && samples.length >= 1536, `${r.id}: 8 kHz mono PCM16, ${(samples.length / 8000).toFixed(2)} s`);
    const out = await pipeline.run(new WavPcmSource(bytes, { inputDomain: "reference_dataset", sourceId: r.recordingId }));
    if (r.selection === SELECTION.INHALATION) {
      check(out.recording_status === "EVENTS_DETECTED" && out.events.some((e) => e.status === "SCORE_ONLY"),
        `${r.id}: an inhalation is detected and scoreable (${out.n_events} event(s))`);
    } else {
      const golden = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/ml/v2_validation/golden/expected/no_inhalation_detected.json"), "utf8"));
      check(out.recording_status === "NO_INHALATION_DETECTED" && out.n_events === 0 && golden.recording_status === out.recording_status
        && golden.n_events === 0 && golden.input.recording_id === r.recordingId, `${r.id}: NO_INHALATION_DETECTED, as the golden case`);
    }
  }
  check(fs.existsSync(path.join(ROOT, "assets/analysis_recordings/ATTRIBUTION.md")), "the added recording has its attribution");
});

// ─── 3. Capture before analysis ──────────────────────────────────────────────
await test("3a. Start Event: capture, verify, save, then analyse", async () => {
  const rig = startEventRig({ random: () => 0 });
  const result = await rig.workflow.run({ nSamples: N15, analysis: SELECTION.INHALATION });
  check(result !== null, "completed");
  const order = [...new Set(rig.states.map((s) => s.phase))];
  check(json(order) === json(["CONNECTING", "READY", "RECORDING", "TRANSFERRING", "SAVING", "ANALYSING", "COMPLETED"]),
    `lifecycle ${order.join(" → ")}`);
  check(rig.calls.select.length === 1 && rig.calls.select[0].s === SELECTION.INHALATION && !rig.calls.select[0].verifiedBefore,
    "the analysis recording is chosen once, before the capture");
  check(rig.calls.keep.length === 1 && rig.calls.keep[0].verified, "the capture is saved only after it was verified");
  check(rig.calls.analyse.length === 1 && rig.calls.analyse[0].savedBefore && rig.calls.analyse[0].phase === LIFECYCLE.ANALYSING,
    "analysis starts only after the capture is saved");
  check(starts(rig.transport) === 1 && rig.calls.save === 1, "one capture, one session");
});

await test("3b. Start Event: failures before analysis", async () => {
  const cases = [
    ["disconnect during the capture", { disconnectAtSeq: 40 }, RECORDER_ERROR.DISCONNECTED],
    ["corrupted audio (checksum mismatch)", { corruptPayloadAt: 3 }, RECORDER_ERROR.CRC_MISMATCH],
    ["wrong device checksum", { wrongCrc: true }, RECORDER_ERROR.CRC_MISMATCH],
    ["unrecoverable packet loss", { dropSeqs: new Set([5]), dropResends: true }, RECORDER_ERROR.TRANSFER_INCOMPLETE],
  ];
  for (const [what, faults, code] of cases) {
    const rig = startEventRig({ faults });
    const result = await rig.workflow.run({ nSamples: N15, analysis: SELECTION.INHALATION });
    const last = rig.states.at(-1);
    check(result === null && last.phase === LIFECYCLE.ERROR && last.error.code === code, `${what} → ERROR ${last.error?.code}`);
    check(rig.calls.keep.length === 0 && rig.calls.analyse.length === 0 && rig.calls.save === 0
      && (await rig.store.listSessions()).entries.length === 0 && rig.files.size === 0,
    `${what}: nothing saved, nothing analysed, no session`);
  }
  // Not connected and nothing found: the existing connection error, no capture.
  const absent = startEventRig();
  absent.transport.connect = async () => { throw Object.assign(new Error("No PRISM device was found nearby"), { code: "DEVICE_NOT_FOUND" }); };
  const r = await absent.workflow.run({ nSamples: N15, analysis: SELECTION.INHALATION });
  check(r === null && absent.states.at(-1).phase === LIFECYCLE.ERROR && absent.states.at(-1).error.needsConnection !== undefined
    && starts(absent.transport) === 0 && absent.calls.analyse.length === 0, "no device: ERROR before any recording");
});

await test("3c. Start Event: duplicate starts, selection and storage failures", async () => {
  const rig = startEventRig();
  const first = rig.workflow.run({ nSamples: N15, analysis: SELECTION.INHALATION });
  check(rig.workflow.isRunning(), "running as soon as Start Event is called");
  let second = null;
  try { await rig.workflow.run({ nSamples: N15, analysis: SELECTION.INHALATION }); } catch (e) { second = e; }
  check(second !== null, "a second start while running is refused");
  await first;
  check(starts(rig.transport) === 1 && rig.calls.select.length === 1 && rig.calls.save === 1, "only one capture and one session");

  const badSelect = startEventRig();
  const res = await badSelect.workflow.run({ nSamples: N15, analysis: "sideways" });
  check(res === null && badSelect.states.at(-1).error.code === WORKFLOW_ERROR.SELECTION_FAILED && starts(badSelect.transport) === 0,
    "invalid selection → ERROR before any recording");

  for (const [what, keepAudio] of [["write throws", async () => { throw new Error("disk full"); }], ["no file name", async () => null]]) {
    const s = startEventRig({ keepAudio });
    const out = await s.workflow.run({ nSamples: N15, analysis: SELECTION.INHALATION });
    check(out === null && s.states.at(-1).error.code === WORKFLOW_ERROR.STORAGE_FAILED && s.states.at(-1).failedPhase === LIFECYCLE.SAVING
      && s.calls.analyse.length === 0 && s.calls.save === 0, `storage failure (${what}) → ERROR, not analysed`);
  }
});

await test("3d. Start Event: analysis and save failures", async () => {
  // The analysis cannot run: the valid capture is kept and the session says so.
  for (const [what, opts] of [
    ["model fails", { getPipelineFn: async () => { throw new Error("model could not be loaded"); } }],
    ["analysis recording missing", { loadBytes: async () => { throw new Error("analysis recording ref-x is not bundled with the app"); } }],
  ]) {
    const rig = startEventRig(opts);
    const res = await rig.workflow.run({ nSamples: N15, analysis: SELECTION.INHALATION });
    const rec = res?.record;
    check(rec?.session_status === "PROCESSING_ERROR" && rec.recordings.length === 0 && rec.n_events === 0 && rec.assessments === null,
      `${what}: stored as a processing error, no result`);
    check(rec.capture.audio.stored === "local_only" && rig.files.has(rec.capture.audio.file) && rig.calls.discard.length === 0,
      `${what}: the captured recording is kept and referenced`);
    check(usesReferenceInput(rec) && rec.analysis_source.reference_id, `${what}: the selection stays associated`);
  }
  // The session cannot be stored: the saved capture is removed (no orphan file).
  const rig = startEventRig({ save: async () => { throw new Error("storage full"); } });
  const res = await rig.workflow.run({ nSamples: N15, analysis: SELECTION.INHALATION });
  check(res === null && rig.states.at(-1).phase === LIFECYCLE.ERROR && rig.calls.discard.length === 1 && rig.files.size === 0,
    "session not storable → ERROR and the capture file is removed");
});

// ─── 4. Audio sources ────────────────────────────────────────────────────────
const store = createLocalSessionStore(memoryStorage(), { log: quiet });
const selState = memoryStorage();
let firstRecord = null;
let firstSnapshot = null;

await test("4. Audio sources: analysis = chosen recording, capture = stored and played", async () => {
  const rig = startEventRig({ store, storage: selState, random: () => 0 });
  const res = await rig.workflow.run({ nSamples: N15, analysis: SELECTION.INHALATION });
  const rec = res.record;
  const chosen = INHALATION_RECORDINGS.find((r) => r.id === rec.analysis_source.reference_id);
  firstRecord = rec;
  firstSnapshot = json(rec);
  check(chosen && rec.analysis_source.type === ANALYSIS_SOURCE_TYPE.REFERENCE_RECORDING && rec.analysis_source.selection === SELECTION.INHALATION
    && rec.analysis_source.sha256 === chosen.sha256 && rec.analysis_source.recording_id === chosen.recordingId
    && rec.analysis_source.input_domain === "reference_dataset" && typeof rec.analysis_source.selected_at === "string",
  "analysis_source names the chosen recording by id, dataset id and SHA-256");

  // The pipeline input is the chosen recording, unchanged.
  const direct = await pipeline.run(new WavPcmSource(readAsset(chosen.asset), { inputDomain: "reference_dataset", sourceId: chosen.recordingId }));
  const out = rec.recordings[0];
  check(out.input.recording_id === chosen.recordingId && out.input.input_domain === "reference_dataset"
    && out.input.n_samples === decodeWav(readAsset(chosen.asset)).samples.length && out.input.n_samples !== N15,
  `pipeline input is the chosen recording (${out.input.n_samples} samples), not the ${N15}-sample capture`);
  check(json(out.events) === json(direct.events) && out.recording_status === direct.recording_status && rec.n_events === direct.n_events,
    `events and counts equal the pipeline on that recording (${direct.n_events} event(s))`);
  const captureOut = await pipeline.run({ acquire: async () => ({ samples: Float32Array.from(heard(N15), (v) => v / 32768),
    sampleRate: 8000, channels: 1, sourceType: "ble", sourceId: "x", recordedAt: null, inputDomain: "prism_hardware" }) });
  check(json(captureOut.events) !== json(out.events) || captureOut.input.n_samples !== out.input.n_samples, "the capture was not what was analysed");

  // The capture: stored separately, exactly the received samples, 15 s.
  const file = rec.capture.audio.file;
  const kept = rig.files.get(file);
  check(rec.capture.audio.stored === "local_only" && kept && sameInt16(int16FromWav(kept), heard(N15))
    && rec.capture.n_samples === N15 && rec.capture.duration_s === 15 && rec.capture.integrity.verified,
  "the stored WAV is the verified 15 s device capture");
  check(!ANALYSIS_RECORDINGS.some((r) => sha256(kept) === r.sha256), "the stored WAV is not an analysis recording");

  // Playback path: the session screen plays describeCapture().audioFile through recordingAudioUri() only.
  check(describeCapture(rec).audioFile === file, "playback source = the capture's file");
  const screen = fs.readFileSync(path.join(ROOT, "screens/SessionDetailScreen.js"), "utf8");
  const player = fs.readFileSync(path.join(ROOT, "components/RecordingPlayback.js"), "utf8");
  check(/<RecordingPlayback file=\{capture\.audioFile\} \/>/.test(screen), "the session screen passes the capture's file to playback");
  check(/import \{ recordingAudioUri \} from "\.\.\/services\/audioFiles"/.test(player)
    && !/analysisAudio|demoRecordings|analysisRecordings|sessionWaveform/.test(player), "the player can only open the capture");
  const waveformSrc = fs.readFileSync(path.join(ROOT, "services/sessionWaveform.js"), "utf8");
  check(/usesReferenceInput\(session\)[\s\S]*?loadAnalysisWaveform[\s\S]*?missing/.test(waveformSrc), "the waveform is the analysis recording, never the capture");
  assertFirestoreSafe(rec);
  passed++;
});

function int16FromWav(bytes) {
  return Int16Array.from(decodeWav(bytes).samples, (v) => Math.round(v * 32768));
}

await test("4b. No substitution when a source is missing or wrong", async () => {
  // Wrong analysis bytes (here: the capture's own WAV) are refused, not analysed.
  let captureWav = null;
  const rig = startEventRig({
    keepAudio: async (r) => { captureWav = encodeWav(r.pcm, r.sampleRate); return "cap.wav"; },
    loadBytes: async () => captureWav,
  });
  const res = await rig.workflow.run({ nSamples: N15, analysis: SELECTION.INHALATION });
  check(res.record.session_status === "PROCESSING_ERROR" && /SHA-256/.test(res.record.processing_errors[0].message)
    && res.record.recordings.length === 0, "analysis bytes that are not the chosen recording are refused (no fallback)");
  let threw = null;
  try {
    await analyseReferenceInput(getPipeline, { pcm: CAPTURE_AUDIO, sampleRate: 8000 }, { analysisRecording: null, loadAnalysisBytes, audioFile: "a.wav" });
  } catch (e) { threw = e; }
  check(threw !== null, "no selected recording → refused, the capture is not analysed instead");
  threw = null;
  try {
    await analyseReferenceInput(getPipeline, { pcm: CAPTURE_AUDIO, sampleRate: 8000 }, { analysisRecording: INHALATION_RECORDINGS[0], loadAnalysisBytes, audioFile: null });
  } catch (e) { threw = e; }
  check(threw !== null, "no saved capture → not analysed");
  check(analysisRecordingOf({ analysis_source: { type: "reference_recording", reference_id: "ref-inhalation-01", sha256: "0".repeat(64) } }) === null
    && analysisRecordingOf({ analysis_source: { type: "reference_recording", reference_id: "ref-gone", sha256: INHALATION_RECORDINGS[0].sha256 } }) === null,
  "a session naming an unknown or changed recording gets no waveform from another one");
  const noFile = describeCapture({ source: "ble", capture: { audio: { stored: "not_stored", file: null }, integrity: {} } });
  check(noFile.audioFile === null, "no stored capture → nothing to play");
});

// ─── 5. Stage 9 ──────────────────────────────────────────────────────────────
await test("5. Stage 9 on the analysis input; fixed reference; no leak between sessions", async () => {
  const refFiles = ["assets/ml/final_assessment/assessment_reference_v1.json", "assets/ml/v2_validation/v2_baseline.json"];
  const shaBefore = refFiles.map((f) => sha256(fs.readFileSync(path.join(ROOT, f))));
  const memBefore = json(assessmentReferenceV1);

  const rec = firstRecord;
  const chosen = analysisRecordingOf(rec);
  const pcm = await new WavPcmSource(readAsset(chosen.asset), { inputDomain: "reference_dataset", sourceId: chosen.recordingId }).acquire();
  const direct = await assessRecording(pipeline, await pipeline.run({ acquire: async () => pcm }), pcm);
  validateAssessmentOutput(rec.assessments[0]);
  passed++;
  check(json(rec.assessments[0]) === json(direct), "Stage 9 output = the unchanged assessment of the chosen recording");
  check(rec.assessments[0].input.input_domain === "reference_dataset" && rec.assessments[0].baseline_domain_validated === true,
    "assessed in the reference domain (what the input is)");
  check(rec.personal === null && rec.note === null, "no V3 state, no note for a Start Event session");

  // A no-inhalation session, then another inhalation session: the first one is unchanged.
  const rig = startEventRig({ store, storage: selState });
  const none = (await rig.workflow.run({ nSamples: N15, analysis: SELECTION.NO_INHALATION })).record;
  check(none.session_status === "NO_INHALATION_DETECTED" && none.n_events === 0 && none.assessments[0].n_scoreable === 0
    && none.assessments[0].events.length === 0, "no-inhalation input: no event, nothing measured");
  const research = describeResearch(none);
  check(research.available && research.events.length === 0 && research.hardware === false && research.caveat === null,
    "research view: no measurement, no hardware caveat for a reference input");
  const again = (await startEventRig({ store, storage: selState }).workflow.run({ nSamples: N15, analysis: SELECTION.INHALATION })).record;
  check(again.analysis_source.reference_id !== firstRecord.analysis_source.reference_id, "the next short press chose another recording");
  check(json(firstRecord) === firstSnapshot && json((await store.getSession(firstRecord.session_id)).record) === firstSnapshot,
    "the first session's stored result did not change");
  check(json(again.assessments[0].events.map((e) => e.event_id)) === json(again.recordings[0].events.filter((e) => e.status === "SCORE_ONLY").map((e) => e.event_id)),
    "each session's Stage 9 events are its own analysis's events");

  // Genuine device sessions: unchanged path, explicit device_capture, and V3 history ignores Start Event sessions.
  const transport = createFakePrismTransport({ source: CAPTURE_AUDIO, faults: {} });
  const recorder = createPrismRecorder({ transport, log: quiet, timeouts: SHORT });
  const phases = [];
  const genuineWf = createRecordingWorkflow({ recorder, keepAudio: async () => "genuine.wav",
    analyse: (r, { audioFile }) => analyseHardwareRecording(getPipeline, r, { audioFile, history: [], now }),
    save: async (record) => (await store.saveSession(record)).record.session_id, onState: (s) => phases.push(s.phase), log: quiet });
  const genuine = (await genuineWf.run({ nSamples: 24000 })).record;
  check(json([...new Set(phases)]) === json(["CONNECTING", "READY", "RECORDING", "TRANSFERRING", "ANALYSING", "COMPLETED"]),
    "genuine recording: lifecycle unchanged");
  check(genuine.analysis_source.type === ANALYSIS_SOURCE_TYPE.DEVICE_CAPTURE && genuine.recordings[0].input.input_domain === "prism_hardware"
    && genuine.personal !== null, "genuine recording: analysed from its own audio, as before");
  const history = mergeSessionLists((await store.listSessions()).entries);
  const deviceId = genuine.device_id;
  check(deviceHistory(history, deviceId).length === 1, "V3 device history counts only the genuine session");

  check(refFiles.every((f, i) => sha256(fs.readFileSync(path.join(ROOT, f))) === shaBefore[i]) && json(assessmentReferenceV1) === memBefore,
    "the fixed Stage 9 reference and V2 baseline are unchanged (files and loaded objects)");
});

// ─── 6. History and Trends ───────────────────────────────────────────────────
await test("6. History, Trends and what the screens show", async () => {
  const { entries } = await store.listSessions();
  const history = mergeSessionLists(entries, [
    { id: "old1", schema: "prism-app-session-v1", session_id: "ble_sess_1", source: "ble", simulated: false, session_status: "NO_INHALATION_DETECTED",
      n_events: 0, n_scored: 0, events: [], timestamp: new Date("2026-10-16T10:00:00Z"), capture: { audio: { stored: "local_only", file: "old.wav" } } },
    { id: "legacy1", legacy: true, timestamp: new Date("2026-10-01T10:00:00Z") },
  ]);
  const ref = history.filter((s) => usesReferenceInput(s));
  const genuine = history.filter((s) => s.source === "ble" && !usesReferenceInput(s));
  check(ref.length === 3 && genuine.length === 2 && history.length === 6, `History lists both kinds (${ref.length} Start Event, ${genuine.length} genuine)`);

  for (const s of history.filter((x) => x.origin === "local")) {
    const stored = (await store.getSession(s.id)).record;
    check(json(describeSession(s).events) === json(describeSession(stored).events) && s.capture?.audio?.file === stored.capture?.audio?.file,
      `${s.id}: reopened with its own events and its own recording`);
  }
  check(new Set(ref.map((s) => describeCapture(s).audioFile)).size === ref.length, "each Start Event session plays its own capture");

  const trends = describeTrends(history, { now: new Date("2026-10-21T12:00:00Z") });
  check(trends.totals.device === ref.length && trends.totals.excluded === genuine.length && trends.totals.legacy === 1
    && trends.totals.inhalations === ref.reduce((n, s) => n + s.n_events, 0), `Trends count Start Event sessions only ${json(trends.totals)}`);
  check(json(describeTrends(history, { now: new Date("2026-10-21T12:00:00Z") })) === json(trends), "Trends are the same when recomputed");

  // Earlier sessions are not reinterpreted.
  const old = history.find((s) => s.id === "ble_sess_1");
  check(!usesReferenceInput(old) && describeSession(old).analysisCaption === null && describeCapture(old).audioFile === "old.wav",
    "an earlier device session stays an analysis of its own audio");
  check(describeSession(history.find((s) => s.legacy)).analysisCaption === null, "legacy session: no caption");

  // What the screens show about the source of a Start Event session: the caption, nothing else.
  for (const s of ref) {
    const view = describeSession(s);
    check(view.analysisCaption === REFERENCE_INPUT_CAPTION && view.note === null && view.sourceLabel === "PRISM device (BLE)",
      `${s.id}: caption shown, source is the device`);
    const shown = strings([view, describeCapture(s), describeResearch(s)]).join(" | ");
    const ids = [s.analysis_source.reference_id, s.analysis_source.recording_id, s.analysis_source.sha256,
      ...ANALYSIS_RECORDINGS.map((r) => r.asset.split("/").pop())];
    check(!ids.some((id) => shown.includes(id)) && !/\bDemo\b|Simulat|\bmock/i.test(shown), `${s.id}: no file name, id or development wording shown`);
  }
  check(describeSession(genuine[0]).analysisCaption === null, "genuine session: no caption");

  // Partial records do not break the views.
  const partial = { source: "ble", schema: "prism-app-session-v1", analysis_source: { type: "reference_recording" } };
  const v = describeSession(partial);
  check(v.analysisCaption === REFERENCE_INPUT_CAPTION && v.events.length === 0 && describeCapture(partial) === null
    && analysisRecordingOf(partial) === null && describeTrends([partial]).totals.device === 1, "a partial record is shown without failing");
  check(describeTrends([]).totals.device === 0, "empty history");
});

// ─── 7. Start controls ───────────────────────────────────────────────────────
await test("7. Start controls: press and long press", async () => {
  const panel = fs.readFileSync(path.join(ROOT, "components/RecordingPanel.js"), "utf8");
  const dash = fs.readFileSync(path.join(ROOT, "screens/DashboardScreen.js"), "utf8");
  const ctx = fs.readFileSync(path.join(ROOT, "context/AppContext.js"), "utf8");
  check(/onPress=\{onStart\}\s+onLongPress=\{onStartLong\}/.test(panel) && />Start Event</.test(panel), "Start Event has a press and a long press");
  check((panel.match(/onLongPress=\{onStartLong\}/g) ?? []).length === 3, "Try again and Record again use the same gestures");
  check(/onStart=\{\(\) => startEvent\(\{ long: false \}\)\}/.test(dash) && /onStartLong=\{\(\) => startEvent\(\{ long: true \}\)\}/.test(dash),
    "press → inhalation, long press → no inhalation");
  check(/if \(workflow\.isRunning\(\)\) return Promise\.resolve\(null\);[\s\S]*?analysis: long \? SELECTION\.NO_INHALATION : SELECTION\.INHALATION/.test(ctx),
    "a start while a recording runs is ignored");
  check(/recordingSeconds: 15/.test(ctx), "the configured capture is 15 s");
  void skipped;
});

console.log(`\n${passed} checks passed, ${failed} failed, ${skipped} section(s) skipped`);
process.exit(failed === 0 ? 0 : 1);
