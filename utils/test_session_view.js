/**
 * utils/test_session_view.js — what the UI shows about a session.
 *
 * 1. describeSession() maps the session record (prism-app-session-v1) to the display view:
 *    status, counts, event times/durations, not-scoreable reasons, input/processing errors,
 *    simulated/legacy flags and sync state. Records are built from the 9 golden contract outputs
 *    (assets/ml/v2_validation/golden/expected/) with the app's SessionAggregator.
 * 2. Nothing the contract keeps internal reaches the view: no anomaly_score, z-scores,
 *    feature values, mean_rms, detector confidence or diagnostics (checked by key and by value),
 *    and no NORMAL/ANOMALY, GOOD/POOR, quality, technique, dose or clinical wording.
 * 3. Static scan of every UI module reachable from App.js (screens, components, navigation,
 *    utils): no forbidden field, label or legacy helper in the code that renders sessions.
 *    React Native components are not rendered here (no renderer in Node); see the device checks.
 *
 * Run: node utils/test_session_view.js   (part of npm test)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import SessionAggregator from "../pipeline/SessionAggregator.js";
import { buildSessionRecord } from "../services/sessionRecord.js";
import { mergeSessionLists } from "../services/syncService.js";
import {
  describeSession,
  describeSyncStatus,
  SESSION_STATUS_TEXT,
  NOT_SCOREABLE_REASON_TEXT,
  INPUT_ERROR_TEXT,
  EVENT_STATUS_TEXT,
} from "./sessionView.js";

let passed = 0;
let failed = 0;
function check(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}
const json = (v) => JSON.stringify(v);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GOLDEN = path.join(ROOT, "assets/ml/v2_validation/golden/expected");
const golden = (name) => JSON.parse(fs.readFileSync(path.join(GOLDEN, `${name}.json`), "utf8"));
const GOLDEN_CASES = fs.readdirSync(GOLDEN).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();

/** A history item exactly as the app lists a session stored on the phone. */
function listItem(record, sync = { state: "pending", attempts: 0, last_error: null }) {
  const entry = { format: "prism-local-session-v1", saved_at: "2026-10-10T08:00:00.000Z", record, sync };
  return mergeSessionLists([entry])[0];
}
function recordFrom(outputs, { processingErrors = [], simulated = false, note = null, id = "view_sess" } = {}) {
  const session = new SessionAggregator().aggregate(id, outputs, { processingErrors });
  return buildSessionRecord(session, { source: simulated ? "simulation" : "wav", simulated, note });
}

// Values the contract keeps internal while DRAFT_NOT_FROZEN.
const FORBIDDEN_KEYS = [
  "anomaly_score", "feature_values", "feature_z_scores", "mean_rms", "detector_confidence",
  "detector_max_confidence", "window_count", "diagnostics", "anomaly_score_summary", "recordings",
];
function internalNumbers(record) {
  const values = new Set();
  const add = (v) => { if (typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v)) values.add(v); };
  for (const rec of record.recordings ?? []) {
    for (const ev of rec.events) {
      add(ev.anomaly_score);
      add(ev.detector_confidence);
      add(ev.detector_max_confidence);
      add(ev.mean_rms);
      Object.values(ev.feature_values ?? {}).forEach(add);
      Object.values(ev.feature_z_scores ?? {}).forEach(add);
    }
  }
  Object.values(record.diagnostics?.anomaly_score_summary ?? {}).forEach(add);
  return values;
}
function walk(value, visit, keyPath = "view") {
  visit(value, keyPath);
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, visit, `${keyPath}[${i}]`));
  else if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) walk(v, visit, `${keyPath}.${k}`);
  }
}
// Wording that must never reach the user (CLAUDE.md §4, contract forbidden_derived_outputs).
const FORBIDDEN_WORDING = [
  /\bNORMAL\b/, /\bANOMAL/, /anomal/i, /\bGOOD\b/, /\bPOOR\b/, /\b(Good|Poor|Correct|Incorrect|Abnormal|Inconsistent)\b/,
  /quality/i, /technique/i, /\bdoses?\b/i, /missed/i, /z-?score/i, /confidence/i, /\brms\b/i, /%/,
  /too (short|fast|long|late)/i, /late actuation/i, /\bmock\b/i, /clinical/i, /alert/i, /\bhealth/i,
];
function checkNoInternals(view, record, label) {
  const internals = internalNumbers(record);
  const leaks = [];
  walk(view, (v, p) => {
    const key = p.split(".").pop().replace(/\[\d+\]$/, "");
    // (counts.recordings is a count; the raw `recordings` outputs are an array)
    if (FORBIDDEN_KEYS.includes(key) && !(key === "recordings" && Number.isInteger(v))) leaks.push(`key ${p}`);
    if (typeof v === "number" && internals.has(v)) leaks.push(`internal value ${v} at ${p}`);
    if (typeof v === "string") {
      for (const re of FORBIDDEN_WORDING) if (re.test(v)) leaks.push(`wording ${re} in ${p}: "${v}"`);
    }
  });
  check(leaks.length === 0, `${label}: nothing internal or forbidden in the view (${leaks.slice(0, 3).join("; ")})`);
}

// ─── 1. Field mapping for every golden case ──────────────────────────────────

console.log("1. Session and event fields → view (9 golden cases)");
for (const name of GOLDEN_CASES) {
  const output = golden(name);
  const record = recordFrom([output], { id: `view_${name}` });
  const view = describeSession(listItem(record));
  const label = name;
  check(view.status.key === record.session_status && view.status.label === SESSION_STATUS_TEXT[record.session_status].label,
    `${label}: status ${record.session_status} → "${view.status.label}"`);
  check(view.counts.recordings === 1 && view.counts.events === output.n_events
    && view.counts.notScoreable === output.n_events - output.n_scored, `${label}: counts`);
  check(view.events.length === output.events.length, `${label}: one view event per contract event`);
  output.events.forEach((ev, i) => {
    const v = view.events[i];
    check(v.startTime === ev.start_time && v.endTime === ev.end_time && v.durationS === ev.duration_s,
      `${label} event ${i}: start/end/duration copied exactly`);
    check(v.scoreable === (ev.status === "SCORE_ONLY") && v.statusLabel === EVENT_STATUS_TEXT[ev.status], `${label} event ${i}: status`);
    check(json(v.reasons) === json(ev.not_scoreable_reasons.map((r) => NOT_SCOREABLE_REASON_TEXT[r])),
      `${label} event ${i}: every reason phrased as a measurement condition`);
  });
  if (output.recording_status === "INPUT_ERROR") {
    check(view.problems.length === 1 && view.problems[0].kind === "input" && view.problems[0].text === INPUT_ERROR_TEXT[output.error],
      `${label}: input error ${output.error} shown`);
  } else {
    check(view.problems.length === 0, `${label}: no error shown`);
  }
  check(view.legacy === false && view.simulated === false && view.sourceLabel === "WAV file", `${label}: flags and source`);
  check(view.sync.state === "pending" && view.sync.label === "Not synced yet", `${label}: sync state`);
  check(view.savedAt instanceof Date && view.savedAt.toISOString() === "2026-10-10T08:00:00.000Z", `${label}: saved time`);
  checkNoInternals(view, record, label);
}

console.log("2. States are kept apart");
const byCase = Object.fromEntries(GOLDEN_CASES.map((c) => [c, describeSession(listItem(recordFrom([golden(c)])))]));
const noInhalation = byCase.no_inhalation_detected;
const notScoreableRecord = recordFrom([golden("single_scored_event")]);
check(noInhalation.status.key === "NO_INHALATION_DETECTED" && noInhalation.events.length === 0 && noInhalation.problems.length === 0,
  "no inhalation detected: a recording state, no events, not an error");
check(byCase.input_error_sample_rate_16k.status.key === "INPUT_ERROR", "input error is its own state");
const processing = describeSession(listItem(recordFrom([], { processingErrors: [{ recording_id: null, message: "model could not be loaded" }] })));
check(processing.status.key === "PROCESSING_ERROR" && processing.problems[0].kind === "processing"
  && /model could not be loaded/.test(processing.problems[0].text), "processing error is its own state with its message");
// a session whose events were all not scoreable
const allNotScoreable = golden("close_neighbors_not_scoreable");
const nsOutput = { ...allNotScoreable, n_scored: 0,
  events: allNotScoreable.events.filter((e) => e.status === "NOT_SCOREABLE") };
nsOutput.n_events = nsOutput.events.length;
const ns = describeSession(listItem(recordFrom([nsOutput])));
check(ns.status.key === "NOT_SCOREABLE" && ns.events.every((e) => !e.scoreable && e.reasons.length > 0),
  "events that cannot be scored: own state, reasons per event");
const labels = ["SCORE_ONLY", "NOT_SCOREABLE", "NO_INHALATION_DETECTED", "INPUT_ERROR", "PROCESSING_ERROR"].map((k) => SESSION_STATUS_TEXT[k].label);
check(new Set(labels).size === labels.length, "every session state has its own label");
void notScoreableRecord;

console.log("3. Simulated, legacy and sync flags");
const simRecord = recordFrom([golden("no_inhalation_detected")], { simulated: true, note: "Simulated session: synthetic test audio." });
const sim = describeSession(listItem(simRecord, { state: "synced", attempts: 1, last_error: null }));
check(sim.simulated === true && sim.note === "Simulated session: synthetic test audio." && /Simulation/.test(sim.sourceLabel), "simulated session is marked");
check(sim.sync.state === "synced" && sim.sync.label === "Synced" && sim.sync.detail === null, "synced session");
const pendingErr = describeSession(listItem(simRecord, { state: "pending", attempts: 2, last_error: "unavailable: offline" }));
check(pendingErr.sync.state === "pending" && pendingErr.sync.detail === "unavailable: offline", "pending session shows its last sync error");
const remoteOnly = mergeSessionLists([], [{ id: "abc", ...simRecord, legacy: false, timestamp: new Date("2026-10-01T00:00:00Z") }])[0];
check(describeSession(remoteOnly).sync.state === "synced", "a session from Firestore counts as synced");

const legacyDocs = [
  { id: "old1", status: "complete", duration: 4.2, quality_assessment: { composite_label: "GOOD", quality_score: 87 },
    technique_flags: { late_actuation: true }, event_classification: { drug_detected: false },
    timestamp: new Date("2026-01-01T00:00:00Z") },
  { id: "old2", status: "SCORED", nEvents: 2, nScored: 1, aggregateScores: { mean: 1.73, max: 2.2 },
    events: [{ eventId: 0, anomalyScore: 1.73, detectorConfidence: 0.91 }], timestamp: new Date("2026-01-01T00:00:00Z") },
];
for (const doc of legacyDocs) {
  const item = mergeSessionLists([], [{ ...doc, legacy: true }])[0];
  const view = describeSession(item);
  check(view.legacy === true && view.status.key === "LEGACY" && view.counts === null && view.events.length === 0,
    `legacy ${doc.id}: shown as a legacy record, not interpreted`);
  const { savedAt, ...rest } = view; // eslint-disable-line no-unused-vars
  const text = json(rest);
  const found = /GOOD|quality|87|1\.73|2\.2|0\.91|4\.2|\blate|\bdrug|composite|SCORED|complete/i.exec(text);
  check(found === null, `legacy ${doc.id}: none of its old fields reach the view (${found?.[0]} in ${text})`);
}

console.log("4. Sync status line");
const lines = [
  describeSyncStatus({ running: true }, 3),
  describeSyncStatus({ lastOutcome: "synced" }, 0),
  describeSyncStatus({ lastOutcome: "not_signed_in" }, 2),
  describeSyncStatus({ lastOutcome: "no_confirmation" }, 1),
  describeSyncStatus({ lastOutcome: "partial", lastError: "permission-denied" }, 1),
  describeSyncStatus({ lastOutcome: null }, 4),
];
check(lines[0] === "Syncing…" && /All sessions/.test(lines[1]) && /2 sessions are waiting/.test(lines[2]) && /offline/.test(lines[2])
  && /1 session is waiting/.test(lines[3]) && /permission-denied/.test(lines[4]) && /4 sessions/.test(lines[5]), "sync status wording");
for (const line of lines) {
  for (const re of FORBIDDEN_WORDING) check(!re.test(line), `sync status line has no forbidden wording ${re}: "${line}"`);
}

// ─── 3. Static scan of the UI modules reachable from App.js ──────────────────

console.log("5. UI source scan (modules reachable from App.js)");
const UI_DIRS = ["screens", "components", "navigation", "utils"];
const reachable = new Set();
const queue = [path.join(ROOT, "App.js")];
while (queue.length > 0) {
  const file = queue.shift();
  if (reachable.has(file)) continue;
  reachable.add(file);
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
    let target = path.resolve(path.dirname(file), m[1]);
    if (!target.endsWith(".js")) target += ".js";
    const rel = path.relative(ROOT, target).split(path.sep).join("/");
    if (fs.existsSync(target) && (UI_DIRS.some((d) => rel.startsWith(`${d}/`)) || rel === "context/AppContext.js")) queue.push(target);
  }
}
const uiFiles = [...reachable].map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
  .filter((rel) => rel === "App.js" || UI_DIRS.some((d) => rel.startsWith(`${d}/`)));
check(uiFiles.includes("screens/DashboardScreen.js") && uiFiles.includes("screens/SessionDetailScreen.js")
  && uiFiles.includes("components/SessionCard.js") && uiFiles.includes("components/ResultBadge.js"), `scan covers the session screens (${uiFiles.length} files)`);
check(!uiFiles.includes("components/IssueList.js") && !uiFiles.includes("components/ProgressBar.js"),
  "the technique-issue list and dose counter components are not reachable from the app");

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const FORBIDDEN_IN_UI = [
  /anomaly_?score/i, /anomalyScore/, /z_?scores?\b/i, /Z-Score/i, /mean_?rms|meanRms/, /confidence/i, /diagnostics/,
  /aggregateScores/, /quality_assessment|composite_label|quality/i, /deviation/i, /GOOD_BUT|MISSED_DOSE|Missed Dose/i,
  /["'`]GOOD["'`]|["'`]POOR["'`]|\bGOOD:|\bPOOR:/, /ABNORMAL|Abnormal/, /\bNORMAL\b|\bANOMALY\b/,
  /\b(Correct|Incorrect)\b/, /deriveIssues|IssueList|ProgressBar|technique/i,
  /doses? today|today'?s doses|dose target|doses? taken|getTodayCompletedCount/i, /\bmock\b/i,
  /(?<!counts)\.recordings\b/, // raw contract outputs (view.counts.recordings is a count)
  /feature_values|window_count/,
];
// The research measurements section shows the Stage 9 acoustic deviation on explicit request of the
// project owner (research ARCHITECTURE.md §9.4 wording, collapsed, separate from the session status).
// Only its two files may use the term "deviation"; every other rule applies to them too, and
// utils/test_recording_view.js checks their wording.
const RESEARCH_UI = new Set(["utils/researchView.js", "components/ResearchMeasurements.js"]);
check([...RESEARCH_UI].every((f) => uiFiles.includes(f)), "the research measurements files are scanned");
for (const rel of uiFiles) {
  const src = stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  const rules = RESEARCH_UI.has(rel) ? FORBIDDEN_IN_UI.filter((re) => String(re) !== "/deviation/i") : FORBIDDEN_IN_UI;
  const hits = rules.filter((re) => re.test(src)).map(String);
  check(hits.length === 0, `${rel}: no forbidden field, label or helper (${hits.join(", ")})`);
}
for (const rel of ["screens/DashboardScreen.js", "screens/SessionDetailScreen.js", "components/SessionCard.js"]) {
  check(/describeSession\(/.test(fs.readFileSync(path.join(ROOT, rel), "utf8")), `${rel} renders through describeSession()`);
}

console.log(`\n${passed} checks passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
