/**
 * utils/test_recording_view.js — what the UI shows about on-board recordings, capture checks,
 * research measurements and trends (utils/recordingView.js, captureView.js, researchView.js,
 * trendsView.js).
 *
 * 1. Recording lifecycle: every workflow state maps to its step, title and actions; progress comes
 *    from the device's sample counts; errors offer "Connect device" or "Try again" as appropriate.
 * 2. Capture view of a BLE session: transfer verification and firmware checks; nothing for other sources.
 * 3. Research measurements built from the Stage 9 golden outputs: research wording only
 *    ("acoustically within / outside the range of the reference recordings"), the PRISM-hardware caveat
 *    before any number, no NORMAL/ANOMALY, GOOD/POOR, quality, percentage, clinical or health wording,
 *    personal baseline shown only as unavailable with reasons.
 * 4. Trends: counts per day from stored sessions; demo, simulated and legacy sessions kept apart.
 *
 * Run: node utils/test_recording_view.js   (part of npm test)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import SessionAggregator from "../pipeline/SessionAggregator.js";
import { buildSessionRecord } from "../services/sessionRecord.js";
import { mergeSessionLists } from "../services/syncService.js";
import { personalReferenceStatus } from "../pipeline/PersonalReferenceStatus.js";
import { describeRecordingState, ERROR_TEXT, STEPS } from "./recordingView.js";
import { describeCapture } from "./captureView.js";
import { describeResearch, RANGE_TEXT, HARDWARE_CAVEAT, PERSONAL_BLOCKER_TEXT, INTERPRETATION } from "./researchView.js";
import { describeTrends } from "./trendsView.js";
import { RECORDER_ERROR } from "../services/ble/PrismRecorder.js";

let passed = 0;
let failed = 0;
function check(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
const v2 = (name) => readJson(`assets/ml/v2_validation/golden/expected/${name}.json`);
const stage9 = (name) => readJson(`assets/ml/final_assessment/golden/expected/${name}.json`);

// Wording that must never reach the user from these views (CLAUDE.md §4; research §9.4).
const FORBIDDEN = [/\bNORMAL\b/, /\bANOMAL/i, /\bGOOD\b/, /\bPOOR\b/, /\b(Correct|Incorrect|Abnormal)\b/i, /quality/i,
  /technique/i, /%/, /clinical/i, /\bhealth/i, /\balert/i, /confidence/i, /\brms\b/i, /z-?score/i, /missed dose/i];
function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object" && !(value instanceof Date)) Object.values(value).forEach((v) => strings(v, out));
  return out;
}
function checkWording(view, label) {
  const hits = strings(view).flatMap((s) => FORBIDDEN.filter((re) => re.test(s)).map((re) => `${re} in "${s}"`));
  check(hits.length === 0, `${label}: no forbidden wording (${hits.slice(0, 2).join("; ")})`);
}

// ─── 1. Recording lifecycle ──────────────────────────────────────────────────
console.log("1. Recording lifecycle view");
const device = { name: "PRISM-4F42" };
const idle = describeRecordingState({ phase: "IDLE" });
check(!idle.active && idle.actions.start && !idle.actions.retry && idle.progress === null, "IDLE: start only");
const connecting = describeRecordingState({ phase: "CONNECTING" });
check(connecting.active && connecting.step === 0 && /Connecting/.test(connecting.title), "CONNECTING: step 1, active");
const recording = describeRecordingState({ phase: "RECORDING", device, requestedSamples: 80000, capturedSamples: 32000, receivedSamples: 31900 });
check(recording.step === 1 && recording.progress.value === 0.4 && /4\.0 s \/ 10\.0 s/.test(recording.progress.label)
  && /Use the inhaler now/.test(recording.detail), `RECORDING: progress from the device's sample count (${recording.progress.label})`);
const transferring = describeRecordingState({ phase: "TRANSFERRING", device, requestedSamples: 80000, receivedSamples: 79000, missingPackets: 3 });
check(transferring.step === 2 && /3 lost packet/.test(transferring.detail), "TRANSFERRING: lost packets shown");
const verified = describeRecordingState({ phase: "TRANSFERRING", device, requestedSamples: 80000, receivedSamples: 80000, verified: true });
check(/verified/.test(verified.title) && /checksum/.test(verified.detail), "verified transfer");
const analysing = describeRecordingState({ phase: "ANALYSING", device, step: "running the on-device analysis" });
check(analysing.step === 3 && /running the on-device analysis/.test(analysing.detail), "ANALYSING: current step");
const done = describeRecordingState({ phase: "COMPLETED", device, sessionId: "ble_sess_1" });
check(!done.active && done.step === 4 && done.actions.viewResult && done.actions.dismiss, "COMPLETED: view result");
for (const code of Object.values(RECORDER_ERROR)) check(typeof ERROR_TEXT[code] === "string", `error text for ${code}`);
const lost = describeRecordingState({ phase: "ERROR", failedPhase: "RECORDING",
  error: { code: "DISCONNECTED", message: "The device disconnected.", needsConnection: true } });
check(lost.error.text === ERROR_TEXT.DISCONNECTED && lost.actions.connect && !lost.actions.retry && lost.step === 1
  && /Record failed/.test(lost.title) && /Demo recordings are not used/.test(lost.detail), "disconnect: Connect device, failed at Record");
const crc = describeRecordingState({ phase: "ERROR", failedPhase: "TRANSFERRING",
  error: { code: "CRC_MISMATCH", message: "checksum", needsConnection: false } });
check(crc.actions.retry && !crc.actions.connect && crc.step === 2, "checksum failure: Try again, failed at Transfer");
const atConnect = describeRecordingState({ phase: "ERROR", failedPhase: "CONNECTING",
  error: { code: "BLUETOOTH_UNAVAILABLE", message: "Bluetooth is turned off.", needsConnection: true } });
check(/Connect failed/.test(atConnect.title) && /Bluetooth is turned off/.test(atConnect.error.reason), "Bluetooth off: reason shown");
const notFound = describeRecordingState({ phase: "ERROR", failedPhase: "CONNECTING",
  error: { code: "DEVICE_NOT_FOUND", message: "No PRISM device found nearby. Check that it is powered and close to the phone.", needsConnection: true } });
check(notFound.error.reason === "" && notFound.error.text === ERROR_TEXT.DEVICE_NOT_FOUND, "a reason that only repeats the summary is not shown twice");
const incomplete = describeRecordingState({ phase: "ERROR", failedPhase: "TRANSFERRING",
  error: { code: "TRANSFER_INCOMPLETE", message: "The recording did not arrive complete (missing_packets; 3 packet(s) missing).", needsConnection: false } });
check(/3 packet/.test(incomplete.error.reason), "a reason with details is shown");
check(STEPS.length === 5, "five steps");
for (const v of [idle, connecting, recording, transferring, verified, analysing, done, lost, crc, atConnect]) checkWording(v, `lifecycle ${v.phase}`);

// ─── 2. Capture view ─────────────────────────────────────────────────────────
console.log("2. Capture view");
function bleRecord({ v2Case = "single_scored_event", s9Case = v2Case, inputDomain = "prism_hardware", checks = {} } = {}) {
  const output = structuredClone(v2(v2Case));
  output.input.input_domain = inputDomain;
  output.baseline_domain_validated = inputDomain === "reference_dataset";
  output.input.recorded_at = "2026-10-16T10:00:00.000Z";
  const assessment = structuredClone(stage9(s9Case));
  assessment.input = { ...output.input };
  assessment.baseline_domain_validated = output.baseline_domain_validated;
  const session = new SessionAggregator().aggregate(`ble_sess_${v2Case}`, [output]);
  return buildSessionRecord(session, {
    source: "ble", simulated: false, deviceId: "prism-esp32-582abdd44f42", note: "device",
    capture: {
      schema: "prism-ble-capture-v1",
      device: { device_id: "prism-esp32-582abdd44f42", name: "PRISM-4F42", firmware: "prism-ble-recorder 1.0.0", microphone: "INMP441" },
      recording_id: "prism_a7103f6a", recorded_at: "2026-10-16T10:00:00.000Z", sample_rate: 8000, n_samples: 96000, duration_s: 12,
      integrity: { verified: true, received_samples: 96000, packets: 828, crc32_phone: "be09944f", live_gap_requests: 2, resend_rounds: 0, failures: [] },
      device_checks: { rate_hz: 7996.75, raw_or: "ffffff00", low_byte_nonzero: 0, clipped: 0, dma_overflows: 0, ring_overruns: 0, ...checks },
      audio: { stored: "local_only", file: "prism_a7103f6a_1.wav" },
      assessment_error: null,
    },
    assessments: [assessment],
    personal: personalReferenceStatus({ deviceId: "prism-esp32-582abdd44f42", history: [],
      current: { recordedAt: "2026-10-16T10:00:00.000Z", events: output.events } }),
  });
}
const listItem = (record) => mergeSessionLists([{ format: "prism-local-session-v1", saved_at: "2026-10-16T10:00:20.000Z",
  record, sync: { state: "pending", attempts: 0, last_error: null } }])[0];
const ble = listItem(bleRecord());
const cap = describeCapture(ble);
check(cap.deviceName === "PRISM-4F42" && cap.firmware === "prism-ble-recorder 1.0.0" && cap.durationS === 12 && cap.sampleRate === 8000
  && cap.measuredRate === 7996.75 && cap.audioFile === "prism_a7103f6a_1.wav", "device, length, rates, local file");
check(cap.checks[0].ok && /96000 samples in 828 packets, checksum be09944f/.test(cap.checks[0].text), "transfer verified");
check(cap.checks.some((c) => /sent again/.test(c.text)), "recovered packets reported");
check(cap.checks.every((c) => c.ok), "all checks pass for a clean capture");
check(/not uploaded/.test(cap.audioNote), "raw audio stays on the phone");
const clipped = describeCapture(listItem(bleRecord({ checks: { clipped: 12, dma_overflows: 2, raw_or: "ffffff80", low_byte_nonzero: 5 } })));
check(clipped.checks.filter((c) => !c.ok).length === 3, "clipping, dropped audio and unexpected bits are flagged");
const demoRecord = listItem(buildSessionRecord(new SessionAggregator().aggregate("demo_1", [v2("single_scored_event")]),
  { source: "wav", simulated: false, note: "demo" }));
check(describeCapture(demoRecord) === null, "no capture view for a demo session");
checkWording(cap, "capture");
checkWording(clipped, "capture with problems");

// ─── 3. Research measurements ────────────────────────────────────────────────
console.log("3. Research measurements");
const r1 = describeResearch(ble);
check(r1.available && r1.hardware && r1.caveat === HARDWARE_CAVEAT && r1.interpretation === INTERPRETATION, "hardware caveat and interpretation");
check(r1.events.length === 1 && r1.events[0].measured && r1.events[0].deviation === stage9("single_scored_event").events[0].aggregate_deviation.toFixed(2)
  && r1.events[0].rangeText === RANGE_TEXT.WITHIN_REFERENCE_RANGE && /^stable/.test(r1.events[0].reliabilityText),
  `deviation ${r1.events[0].deviation}, within the reference range, stable`);
check(/153 of 318 reference inhalations deviate at least as much \(empirical tail probability 0\.483\)/.test(r1.events[0].tailText),
  `tail probability as a count: ${r1.events[0].tailText}`);
check(r1.referenceLimit === "1.83", "reference upper limit shown");
const r2 = describeResearch(listItem(bleRecord({ v2Case: "close_neighbors_not_scoreable" })));
check(r2.events[0].rangeText === RANGE_TEXT.OUTSIDE_REFERENCE_RANGE && /^borderline/.test(r2.events[0].reliabilityText)
  && r2.events.slice(1).every((e) => !e.measured && e.deviation === null && e.rangeText === RANGE_TEXT.NOT_ASSESSED),
  "outside / borderline; not-scoreable events have no number");
const r3 = describeResearch(listItem(bleRecord({ v2Case: "no_inhalation_detected" })));
check(r3.available && r3.events.length === 0, "no inhalation: nothing measured");
check(r1.personal && r1.personal.available === false && r1.personal.status === "Not available"
  && r1.personal.reasons.includes(PERSONAL_BLOCKER_TEXT.SITTING_DEFINITION_INCOMPATIBLE)
  && /0 of 10 qualifying sittings/.test(r1.personal.detail), "personal baseline: not available, with reasons");
const datasetRecord = listItem(bleRecord({ inputDomain: "reference_dataset" }));
datasetRecord.source = "wav";
check(describeResearch(datasetRecord).caveat === null, "no hardware caveat for reference-dataset audio");
check(describeResearch(demoRecord).available === false, "sessions without Stage 9 output: not available");
for (const [v, label] of [[r1, "research single"], [r2, "research outside"], [r3, "research none"]]) checkWording(v, label);
check(Object.values(RANGE_TEXT).every((t) => !/\b(normal|abnormal|anomal)/i.test(t)), "range texts use the research wording only");

// ─── 4. Trends ───────────────────────────────────────────────────────────────
console.log("4. Trends");
const now = new Date(2026, 9, 16, 12, 0, 0);
const day = (offset, hour = 10) => new Date(2026, 9, 16 - offset, hour).toISOString();
const sessions = [
  { source: "ble", recorded_at: day(0), n_events: 2, n_scored: 1 },
  { source: "ble", recorded_at: day(0, 11), n_events: 0, n_scored: 0 },
  { source: "ble", recorded_at: day(3), n_events: 1, n_scored: 1 },
  { source: "ble", recorded_at: day(30), n_events: 5, n_scored: 5 },
  { source: "wav", simulated: false, timestamp: new Date(2026, 9, 16, 9) },
  { source: "simulation", simulated: true, timestamp: new Date(2026, 9, 15, 9) },
  { legacy: true, timestamp: new Date(2026, 9, 16, 9) },
];
const t = describeTrends(sessions, { now });
check(t.days.length === 14 && t.days[13].key === "2026-10-16" && t.days[0].key === "2026-10-03", "14 days ending today");
check(t.days[13].device === 2 && t.days[13].inhalations === 2 && t.days[13].other === 1, "today: 2 device recordings, 2 inhalations, 1 other");
check(t.days[10].device === 1 && t.days[10].inhalations === 1, "3 days ago");
check(t.totals.device === 4 && t.totals.inhalations === 8 && t.totals.scoreable === 7 && t.totals.demo === 1
  && t.totals.simulated === 1 && t.totals.legacy === 1, `totals ${JSON.stringify(t.totals)}`);
check(t.maxCount === 3, "scale from the largest daily count");
check(describeTrends([], { now }).totals.device === 0, "empty history");
checkWording(t, "trends");

console.log(`\n${passed} checks passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
