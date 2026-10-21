/**
 * services/test_demo_baseline.js — the Demo Baseline (services/demoBaseline.js) and its integration.
 *
 * Start Event sessions are produced as in the app: the protocol simulator (services/ble/testing/
 * fakePrismDevice.js) as the device, the Entry 19 workflow with the reference selection, the existing
 * analysis (analyseReferenceInput: pipeline + Stage 9 on the selected reference recording), the session
 * stored, then the demo baseline observes it (the same order as context/AppContext.js `save`).
 *
 *  1-4   initialization, no distance on the first session, distance against the pre-update baseline,
 *        exact update B + 0.3 (z - B)
 *  5-7   exclusions: no-inhalation reference, other/failed/invalid sessions, NaN / infinity / missing /
 *        malformed measurements
 *  8-10  idempotency per session; reopening screens cannot update; same reference in a new session
 *  11-13 persistence, reset scope, storage failures
 *  14-15 Stage 9 outputs and the Entry 19 selection unchanged
 *  16-20 shown to users as "Personal Baseline": wording, the Dashboard summary (read-only, refreshed from
 *        the stored state), reference recordings named by kind and original recording time, ids unchanged
 *
 * Run: node services/test_demo_baseline.js   (part of npm test)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPrismRecorder } from "./ble/PrismRecorder.js";
import { createFakePrismTransport } from "./ble/testing/fakePrismDevice.js";
import { createRecordingWorkflow } from "./recordingWorkflow.js";
import { analyseReferenceInput, analyseHardwareRecording } from "./hardwareSession.js";
import {
  INHALATION_RECORDINGS, NO_INHALATION_RECORDING, SELECTION, createAnalysisSelector, pickAnalysisRecording, SELECTION_STATE_KEY,
  ANALYSIS_RECORDINGS,
} from "./analysisRecordings.js";
import { createLocalSessionStore } from "./localSessionStore.js";
import { mergeSessionLists } from "./syncService.js";
import {
  createDemoBaselineStore, demoBaselineInput, applyDemoBaseline, validateDemoBaseline, emptyDemoBaseline,
  DEMO_BASELINE_KEY, DEMO_ACTION, DEMO_BASELINE_ETA,
} from "./demoBaseline.js";
import { decodeWav } from "../pipeline/wav.js";
import WavPcmSource from "../pipeline/sources/WavPcmSource.js";
import { createNodePipeline } from "../pipeline/runtime/node.js";
import { assessRecording, loadAssessmentReference } from "../pipeline/ReferenceAssessment.js";
import { rmsZ } from "../pipeline/contract.js";
import { V2_FEATURE_ORDER } from "../pipeline/versions.js";
import {
  describeDemoBaseline, describeBaselineSummary, referenceRecordingLabel, referenceRecordedAt, DEMO_BASELINE_EXPLANATION,
} from "../utils/researchView.js";
import { formatTimestamp } from "../utils/formatters.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let passed = 0;
let failed = 0;
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
const readAsset = (rel) => new Uint8Array(fs.readFileSync(path.join(ROOT, "assets", rel)));
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
function memoryStorage() {
  const map = new Map();
  const calls = { set: [] };
  return {
    map, calls,
    async getItem(k) { return map.has(k) ? map.get(k) : null; },
    async setItem(k, v) { calls.set.push(k); map.set(k, v); },
    async getAllKeys() { return [...map.keys()]; },
    async multiGet(keys) { return keys.map((k) => [k, map.has(k) ? map.get(k) : null]); },
  };
}

const REFERENCE = loadAssessmentReference();
const SHORT = { startMs: 2000, finishMarginMs: 3000, resendRoundMs: 2000 };
const CAPTURE = Int16Array.from(decodeWav(readAsset("demo_recordings/demo_02.wav")).samples, (v) => Math.round(v * 32768));
let clock = Date.parse("2026-10-21T12:00:00.000Z");
const nowMs = () => (clock += 1000);
const nowDate = () => new Date(clock);
const pipeline = await createNodePipeline();

/**
 * One Start Event session as in the app: select → capture → save audio → analyse the reference →
 * store the session → demo baseline observes it.
 * @param {Object} o
 */
async function startEvent(o) {
  const { storage, demo, selection = SELECTION.INHALATION, pick = null, loadBytes } = o;
  const recorder = createPrismRecorder({ transport: createFakePrismTransport({ source: CAPTURE, faults: {} }), log: quiet, timeouts: SHORT });
  const sessions = createLocalSessionStore(storage, { log: quiet });
  const selector = createAnalysisSelector({ storage, random: () => 0, now: nowDate, log: quiet });
  let observed = null;
  const workflow = createRecordingWorkflow({
    recorder,
    keepAudio: async () => `prism_${clock}.wav`,
    selectAnalysis: async (s) => (pick ? { ...pick, selectedAt: nowDate().toISOString() } : selector.select(s)),
    analyse: (r, { audioFile, analysisRecording }) => analyseReferenceInput(async () => pipeline, r, {
      analysisRecording, audioFile, now: nowMs, loadAnalysisBytes: loadBytes ?? (async (x) => readAsset(x.asset)) }),
    save: async (record) => {
      const id = (await sessions.saveSession(record)).record.session_id;
      try { observed = await demo.observe(record); } catch (e) { observed = { thrown: e }; }
      return id;
    },
    log: quiet,
  });
  const res = await workflow.run({ nSamples: 96000, analysis: selection });
  return { res, record: res?.record ?? null, observed, sessions };
}
const zOf = (record) => {
  const ev = record.assessments[0].events.find((e) => e.scoreability === "SCOREABLE");
  return V2_FEATURE_ORDER.map((f) => ev.feature_deviations[f]);
};

// Shared run used by several sections: three sessions (refs A, B, A).
const storage = memoryStorage();
const demo = createDemoBaselineStore({ storage, reference: REFERENCE, now: nowDate, log: quiet });
const A = INHALATION_RECORDINGS[0];
const B = INHALATION_RECORDINGS[1];
const s1 = await startEvent({ storage, demo, pick: A });
const state1 = (await demo.load()).state;
const s2 = await startEvent({ storage, demo, pick: B });
const state2 = (await demo.load()).state;
const s3 = await startEvent({ storage, demo, pick: A });
const state3 = (await demo.load()).state;

await test("1-2. The first eligible inhalation initializes the baseline, with no distance", () => {
  const z1 = zOf(s1.record);
  check(s1.record.session_status === "SCORE_ONLY" && s1.observed.outcome.action === DEMO_ACTION.INITIALIZED && s1.observed.error === null,
    "first session: initialized");
  check(state1.initialized && json(state1.baseline) === json(z1), "B = z of the first session (the Stage 9 normalised measurements)");
  const ev = s1.record.assessments[0].events.find((e) => e.scoreability === "SCOREABLE");
  const recomputed = V2_FEATURE_ORDER.map((f, j) => (ev.feature_values[f] - REFERENCE.centers[j]) / REFERENCE.scales[j]);
  check(json(recomputed) === json(z1), "z = (x - center) / scale with the Stage 9 reference parameters");
  check(state1.sessions_processed === 1 && json(state1.unique_reference_ids) === json([A.id]) && state1.last_session_id === s1.record.session_id
    && state1.last_reference_id === A.id && typeof state1.updated_at === "string", "metadata after initialization");
  const c = state1.contributions[s1.record.session_id];
  check(state1.last_deviation === null && c.deviation === null && c.baseline_before === null && s1.observed.outcome.deviation === null,
    "no distance is invented for the first session");
  const view = describeDemoBaseline({ state: state1, error: null }, s1.record);
  check(view.stateLabel === "Initialized" && view.lastDistance === "—" && /initialized the personal baseline/.test(view.thisSession)
    && /No distance was calculated/.test(view.thisSession), "the session screen says so");
});

await test("3-4. Later sessions: distance against the PRE-update baseline; B + 0.3 (z - B)", () => {
  const z2 = zOf(s2.record);
  const before = state1.baseline;
  const expectedD = rmsZ(z2.map((v, j) => v - before[j]));
  const expectedB = before.map((b, j) => b + 0.3 * (z2[j] - b));
  check(s2.observed.outcome.action === DEMO_ACTION.UPDATED && state2.last_deviation === expectedD
    && state2.contributions[s2.record.session_id].deviation === expectedD, `D against B_before (${expectedD.toFixed(4)})`);
  check(expectedD === Math.sqrt(z2.reduce((acc, v, j) => acc + (v - before[j]) ** 2, 0) / 4), "D = sqrt(mean (z - B_before)^2)");
  check(state2.last_deviation !== rmsZ(z2.map((v, j) => v - state2.baseline[j])), "not against the updated baseline");
  check(json(state2.baseline) === json(expectedB) && DEMO_BASELINE_ETA === 0.3, "B_next = B_before + 0.3 (z - B_before), exactly");
  const c = state2.contributions[s2.record.session_id];
  check(json(c.baseline_before) === json(before) && json(c.baseline_after) === json(expectedB), "before and after are both recorded");
  const view = describeDemoBaseline({ state: state2, error: null }, s2.record);
  check(view.lastDistance === expectedD.toFixed(3) && new RegExp(`before the update: ${expectedD.toFixed(3)}`).test(view.thisSession),
    "the session screen shows the distance before the update");
});

await test("10. A new session with an already-seen reference: +1 session, unique references unchanged", () => {
  check(s3.record.session_id !== s1.record.session_id && s3.observed.outcome.action === DEMO_ACTION.UPDATED, "a new session is processed");
  check(state3.sessions_processed === 3 && json(state3.unique_reference_ids) === json([A.id, B.id]) && state3.last_reference_id === A.id,
    `sessions ${state3.sessions_processed}, unique references ${state3.unique_reference_ids.length}`);
});

await test("5-7. Exclusions: no-inhalation reference, other and failed sessions, invalid measurements", async () => {
  const st = memoryStorage();
  const d = createDemoBaselineStore({ storage: st, reference: REFERENCE, now: nowDate, log: quiet });
  // 5. long press: the no-inhalation reference (annotated as Drug actuation only; NO_INHALATION_DETECTED)
  const none = await startEvent({ storage: st, demo: d, selection: SELECTION.NO_INHALATION });
  check(none.record.analysis_source.reference_id === NO_INHALATION_RECORDING.id && none.observed.outcome.action === DEMO_ACTION.SKIPPED
    && /no-inhalation/.test(none.observed.outcome.reason) && !st.map.has(DEMO_BASELINE_KEY), "the no-inhalation reference is skipped");
  // failed analysis (the reference recording cannot be loaded): PROCESSING_ERROR session
  const failedRun = await startEvent({ storage: st, demo: d, pick: A, loadBytes: async () => { throw new Error("not bundled"); } });
  check(failedRun.record.session_status === "PROCESSING_ERROR" && failedRun.observed.outcome.action === DEMO_ACTION.SKIPPED,
    "a failed analysis is skipped");
  // other session kinds and states, derived from a real eligible record
  const ok = s1.record;
  const variants = {
    "no inhalation detected": { ...ok, session_status: "NO_INHALATION_DETECTED" },
    "events not scoreable (e.g. exhalation or actuation sounds)": { ...ok, session_status: "NOT_SCOREABLE" },
    "input error": { ...ok, session_status: "INPUT_ERROR" },
    "device-analysed session": { ...ok, analysis_source: { type: "device_capture" } },
    "demo-button session": { ...ok, source: "wav", analysis_source: undefined },
    "simulated session": { ...ok, source: "simulation", simulated: true },
    "legacy record": { ...ok, legacy: true },
    "unknown reference": { ...ok, analysis_source: { ...ok.analysis_source, reference_id: "ref-unknown" } },
    "reference with a different SHA-256": { ...ok, analysis_source: { ...ok.analysis_source, sha256: "0".repeat(64) } },
    "unverified capture": { ...ok, capture: { ...ok.capture, integrity: { ...ok.capture.integrity, verified: false } } },
    "analysis input not the selected reference": { ...ok, recordings: [{ ...ok.recordings[0], input: { ...ok.recordings[0].input, recording_id: "other.wav" } }] },
    "no Stage 9 assessment": { ...ok, assessments: null },
  };
  for (const [what, r] of Object.entries(variants)) {
    check(!demoBaselineInput({ ...r, session_id: `x_${what}` }, REFERENCE).eligible, `${what}: not eligible`);
  }
  // 7. invalid measurements
  const withEvent = (patch) => {
    const r = JSON.parse(json(ok));
    r.session_id = `bad_${Object.keys(patch).join("_")}_${Math.random()}`;
    const ev = r.assessments[0].events.find((e) => e.scoreability === "SCOREABLE");
    Object.assign(ev.feature_values, patch);
    return r;
  };
  for (const [what, r] of [["NaN", withEvent({ spectral_flatness_mean: NaN })], ["Infinity", withEvent({ spectral_centroid_std: Infinity })],
    ["missing", withEvent({ spectral_rolloff_std: undefined })], ["string", withEvent({ spectral_centroid_mean: "0.37" })]]) {
    const res = await d.observe(r);
    check(res.outcome.action === DEMO_ACTION.SKIPPED && /invalid|missing/.test(res.outcome.reason), `${what} measurement: skipped`);
  }
  const mismatch = JSON.parse(json(ok));
  mismatch.session_id = "mismatch";
  mismatch.assessments[0].events.find((e) => e.scoreability === "SCOREABLE").feature_deviations.spectral_flatness_mean += 1e-9;
  check(!demoBaselineInput(mismatch, REFERENCE).eligible, "measurements inconsistent with Stage 9: skipped");
  const two = JSON.parse(json(ok));
  two.session_id = "two";
  two.assessments[0].events.push({ ...two.assessments[0].events[0], event_id: 1 });
  check(!demoBaselineInput(two, REFERENCE).eligible, "two scoreable events (ambiguous): skipped");
  check(!st.map.has(DEMO_BASELINE_KEY) && json((await d.load()).state) === json(emptyDemoBaseline(REFERENCE.referenceId)),
    "after all of these the demo baseline is still not initialized and was never written");
  for (const bad of [{ ...state2, baseline: [1, 2, 3] }, { ...state2, baseline: [1, 2, NaN, 4] }, { ...state2, sessions_processed: 5 }, { ...state2, eta: 0.5 }]) {
    let threw = false;
    try { validateDemoBaseline(JSON.parse(json(bad)), REFERENCE.referenceId); } catch { threw = true; }
    check(threw, "a malformed stored baseline is rejected");
  }
});

await test("8-9. A session updates the baseline at most once; reopening screens cannot update it", async () => {
  const writesBefore = storage.calls.set.filter((k) => k === DEMO_BASELINE_KEY).length;
  const again = await demo.observe(s2.record);
  check(again.outcome.action === DEMO_ACTION.ALREADY_PROCESSED && json(again.state) === json(state3), "the same session again: already processed");
  // History items (as the History and session screens get them) observed again change nothing either.
  const { entries } = await createLocalSessionStore(storage, { log: quiet }).listSessions();
  for (const item of mergeSessionLists(entries)) {
    const r = await demo.observe(item);
    check(r.outcome.action === DEMO_ACTION.ALREADY_PROCESSED, `history item ${item.id}: already processed`);
  }
  for (let i = 0; i < 5; i++) describeDemoBaseline({ state: state3, error: null }, s1.record); // re-rendering
  check(storage.calls.set.filter((k) => k === DEMO_BASELINE_KEY).length === writesBefore && json((await demo.load()).state) === json(state3),
    "no write and no change from reopening or re-rendering");
  check(!/observe|createDemoBaselineStore/.test(src("screens/SessionDetailScreen.js") + src("components/DemoBaselineCard.js") + src("screens/HistoryScreen.js")),
    "the session, card and history code cannot update the baseline");
  check(/const sessionId = await addNewSessionRef\.current\(record\);\s+try \{\s+const result = await demoBaselineRef\.current\.observe\(record\);/.test(src("context/AppContext.js")),
    "the app updates it only after storing a session (workflow save step)");
});

await test("11-12. Persistence and reset scope", async () => {
  const restarted = createDemoBaselineStore({ storage, reference: REFERENCE, now: nowDate, log: quiet });
  const loaded = await restarted.load();
  check(loaded.error === null && json(loaded.state) === json(state3), "a restart reloads the same state");
  check((await restarted.observe(s1.record)).outcome.action === DEMO_ACTION.ALREADY_PROCESSED, "idempotency survives the restart");
  storage.map.set("@PRISM:settings", json({ recordingSeconds: 15 }));
  storage.map.set(SELECTION_STATE_KEY, json({ last_inhalation_id: A.id })); // the rig picks references directly; seed the key
  const others = new Map([...storage.map].filter(([k]) => k !== DEMO_BASELINE_KEY));
  const sessionsBefore = json((await createLocalSessionStore(storage, { log: quiet }).listSessions()).entries);
  await restarted.reset();
  const after = await restarted.load();
  check(after.state.initialized === false && after.state.sessions_processed === 0 && json(after.state.contributions) === "{}", "reset: not initialized");
  check([...others].every(([k, v]) => storage.map.get(k) === v) && storage.map.size === others.size + 1, "every other key is unchanged");
  check(json((await createLocalSessionStore(storage, { log: quiet }).listSessions()).entries) === sessionsBefore
    && storage.map.get(SELECTION_STATE_KEY) === json({ last_inhalation_id: A.id }), "sessions and the selection state are kept");
  const view = describeDemoBaseline(after, s1.record);
  check(view.stateLabel === "Not initialized" && /not processed by the current personal baseline/.test(view.thisSession), "after a reset, old sessions are shown as not processed");
  const fresh = await restarted.observe(s1.record);
  check(fresh.outcome.action === DEMO_ACTION.INITIALIZED, "after a reset an already stored session would initialize it again only if observed again (the app observes only new sessions)");
});

await test("13. Storage failures do not affect the analysis or Stage 9", async () => {
  const failing = memoryStorage();
  const brokenStore = {
    ...failing,
    async setItem(k, v) { if (k === DEMO_BASELINE_KEY) throw new Error("disk full"); return failing.setItem(k, v); },
  };
  const d = createDemoBaselineStore({ storage: brokenStore, reference: REFERENCE, now: nowDate, log: quiet });
  const run = await startEvent({ storage: brokenStore, demo: d, pick: B });
  check(run.res !== null && run.record.session_status === "SCORE_ONLY" && (await run.sessions.getSession(run.record.session_id)),
    "the session completes and is stored");
  check(run.observed.outcome.action === DEMO_ACTION.SKIPPED && run.observed.error !== null && !run.observed.thrown, "the demo baseline reports the failure, without throwing");
  check((await d.load()).state.initialized === false, "nothing is recorded as processed");
  const unreadable = memoryStorage();
  unreadable.map.set(DEMO_BASELINE_KEY, "{broken");
  const d2 = createDemoBaselineStore({ storage: unreadable, reference: REFERENCE, now: nowDate, log: quiet });
  const run2 = await startEvent({ storage: unreadable, demo: d2, pick: A });
  check(run2.res !== null && run2.observed.outcome.action === DEMO_ACTION.SKIPPED && unreadable.map.get(DEMO_BASELINE_KEY) === "{broken",
    "an unreadable stored baseline is reported and left alone; the session completes");
  check(json(run.record.assessments) === json((await startEvent({ storage: memoryStorage(), demo: createDemoBaselineStore({ storage: memoryStorage(), reference: REFERENCE, log: quiet }), pick: B })).record.assessments),
    "Stage 9 output is the same with a failing or a working demo baseline");
});

await test("14. Stage 9 outputs unchanged; the session record carries no demo data", async () => {
  for (const s of [s1, s2, s3]) {
    const ref = INHALATION_RECORDINGS.find((r) => r.id === s.record.analysis_source.reference_id);
    const pcm = await new WavPcmSource(readAsset(ref.asset), { inputDomain: "reference_dataset", sourceId: ref.recordingId }).acquire();
    const direct = await assessRecording(pipeline, await pipeline.run({ acquire: async () => pcm }), pcm);
    check(json(s.record.assessments[0]) === json(direct), `${ref.id}: Stage 9 output = direct assessment of the same input`);
    check(!/demo_?baseline|contributions/i.test(Object.keys(s.record).join(",")), `${ref.id}: no demo baseline field in the session record`);
  }
  const stored = await s1.sessions.getSession(s1.record.session_id);
  check(json(stored.record) === json(s1.record), "the stored session is exactly the analysed record");
  const device = await analyseHardwareRecording(async () => pipeline, { pcm: CAPTURE.subarray(0, 24000), sampleRate: 8000, recordingId: "x", transfer: { verified: true } }, { now: nowMs });
  check(!demoBaselineInput(device, REFERENCE).eligible, "a device-analysed session is never used");
});

await test("15. Entry 19 selection and long press unchanged", () => {
  check(INHALATION_RECORDINGS.length === 8 && pickAnalysisRecording(SELECTION.NO_INHALATION) === NO_INHALATION_RECORDING, "8 inhalation references; long press → no-inhalation");
  let prev = null;
  let repeats = 0;
  for (let i = 0; i < 200; i++) {
    const r = pickAnalysisRecording(SELECTION.INHALATION, { previousId: prev });
    repeats += r.id === prev;
    prev = r.id;
  }
  check(repeats === 0, "no consecutive repeat");
  const ctx = src("context/AppContext.js");
  check(/analysis: long \? SELECTION\.NO_INHALATION : SELECTION\.INHALATION/.test(ctx) && /selectAnalysis: \(selection\) => selector\.select\(selection\)/.test(ctx)
    && /analyseReferenceInput\(getPipeline, recording, \{ analysisRecording, loadAnalysisBytes, audioFile \}\)/.test(ctx), "Start Event wiring unchanged");
  check((src("components/RecordingPanel.js").match(/onLongPress=\{onStartLong\}/g) ?? []).length === 3, "press and long press on the start controls");
  check(applyDemoBaseline && typeof applyDemoBaseline === "function", "the demo baseline is a separate module");
});

// ─── 16-20: presentation as "Personal Baseline" (no change to the baseline itself) ─────────────────

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const code = (rel) => stripComments(src(rel));
const oneSpace = (s) => s.replace(/\s/g, " "); // ICU may put a narrow no-break space before AM/PM

await test("16. User-facing wording: \"Personal Baseline\", with an accurate explanation", async () => {
  const card = code("components/DemoBaselineCard.js");
  const dash = code("screens/DashboardScreen.js");
  check(/>Personal Baseline</.test(card) && /Reset personal baseline/.test(card) && /Reset the personal baseline\?/.test(card)
    && /This clears only the personal baseline and its processing record/.test(card) && /Personal baseline not reset/.test(card),
    "session screen: title, reset control and confirmation say Personal Baseline");
  check(/>Personal Baseline</.test(dash), "Dashboard: the Personal Baseline section");
  check(![card, dash, code("utils/researchView.js"), code("screens/SessionDetailScreen.js")].some((s) => /demo baseline|demonstration/i.test(s)),
    "no \"Demo Baseline\" wording left in the feature's screens");
  const unreadable = memoryStorage();
  unreadable.map.set(DEMO_BASELINE_KEY, "{broken");
  const broken = await createDemoBaselineStore({ storage: unreadable, reference: REFERENCE, log: quiet }).load();
  const failing = { ...memoryStorage(), async setItem() { throw new Error("disk full"); } };
  const notSaved = await createDemoBaselineStore({ storage: failing, reference: REFERENCE, now: nowDate, log: quiet }).observe(s1.record);
  check(broken.error === "The personal baseline could not be read. Reset it to start again." && notSaved.error === "The personal baseline could not be saved.",
    "the storage messages shown on screen");
  const views = [
    describeDemoBaseline({ state: state1, error: null }, s1.record), describeDemoBaseline({ state: state2, error: null }, s2.record),
    describeDemoBaseline({ state: emptyDemoBaseline(REFERENCE.referenceId), error: null }, s1.record),
    describeBaselineSummary({ state: state3, error: null }), describeBaselineSummary({ state: emptyDemoBaseline(REFERENCE.referenceId), error: null }),
  ];
  check(views.every((v) => !/\bdemo\b|demo baseline|demonstration/i.test(json(v))), "no text of the session section or the Dashboard summary says demo");
  check(DEMO_BASELINE_EXPLANATION === "Preliminary baseline derived from reference inhalation recordings. It demonstrates baseline "
    + "initialization and adaptation and is not yet personalized to an individual's inhalation patterns."
    && views.every((v) => v.explanation === DEMO_BASELINE_EXPLANATION), "explanation: derived from reference recordings, not yet personalized");
  check(!/your own|your inhalation|learn|clinical|validated|quality|technique|score/i.test(DEMO_BASELINE_EXPLANATION),
    "it claims no learning from the user's inhalations and no validated or quality score");
});

await test("17. Dashboard summary: not initialized, initialized, read-only", () => {
  const dash = code("screens/DashboardScreen.js");
  check(describeBaselineSummary({ state: null, error: null }) === null && describeBaselineSummary(undefined) === null, "nothing before the baseline is loaded");
  const empty = describeBaselineSummary({ state: emptyDemoBaseline(REFERENCE.referenceId), error: null });
  check(empty.stateLabel === "Not initialized" && empty.initialized === false && empty.sessionsProcessed === null && empty.uniqueReferences === null
    && empty.lastDistance === null && empty.lastUpdated === null && empty.error === null, "not initialized: no counts, distance or time");
  check(/\{baseline\?\.initialized && \(/.test(dash) && /baseline\?\.stateLabel \?\? "—"/.test(dash), "the Dashboard shows the rows only when initialized");
  const one = describeBaselineSummary({ state: state1, error: null });
  check(one.stateLabel === "Initialized" && one.sessionsProcessed === 1 && one.uniqueReferences === 1 && one.lastDistance === "—"
    && one.lastUpdated === formatTimestamp(state1.updated_at), "after the first session: 1 session, 1 reference, no distance yet");
  const three = describeBaselineSummary({ state: state3, error: null });
  check(three.sessionsProcessed === state3.sessions_processed && three.sessionsProcessed === 3 && three.uniqueReferences === 2
    && three.lastDistance === state3.last_deviation.toFixed(3), `the stored counts and the latest distance (${three.lastDistance})`);
  check(state3.updated_at === state3.contributions[s3.record.session_id].at && three.lastUpdated === formatTimestamp(state3.updated_at)
    && three.lastUpdated !== "—", `last update = the time of the last baseline update (${oneSpace(three.lastUpdated)})`);
  check(describeBaselineSummary({ state: state3, error: "x" }).error === "x", "a storage error is passed through");
  const before = json(state3);
  for (let i = 0; i < 5; i++) describeBaselineSummary({ state: state3, error: null });
  check(json(state3) === before, "building the summary changes nothing");
  check(!/\.observe\(|\.reset\(|setItem|getItem|AsyncStorage|createDemoBaselineStore|resetDemoBaseline|setDemoBaseline/.test(dash),
    "the Dashboard only reads the baseline (no update, reset or storage call)");
  check(!/observe|createDemoBaselineStore/.test(src("screens/DashboardScreen.js")), "the Dashboard cannot update the baseline");
});

await test("18. The Dashboard summary follows the stored state after a new eligible session", async () => {
  const dash = code("screens/DashboardScreen.js");
  check(/demoBaseline,\s*\} = useAppContext\(\)/.test(dash) && /describeBaselineSummary\(demoBaseline\)/.test(dash), "the Dashboard reads AppContext.demoBaseline");
  check(/setDemoBaseline\(\{ state: result\.state, error: result\.error \}\)/.test(src("context/AppContext.js")),
    "AppContext replaces it with the state observe() returns after a session is stored");
  // The same steps as the app: start-up load, then each stored session's observe() result becomes the context value.
  const st = memoryStorage();
  const d = createDemoBaselineStore({ storage: st, reference: REFERENCE, now: nowDate, log: quiet });
  const start = describeBaselineSummary(await d.load());
  const r1 = await startEvent({ storage: st, demo: d, pick: B });
  const after1 = describeBaselineSummary({ state: r1.observed.state, error: r1.observed.error });
  const r2 = await startEvent({ storage: st, demo: d, pick: A });
  const after2 = describeBaselineSummary({ state: r2.observed.state, error: r2.observed.error });
  check(start.stateLabel === "Not initialized" && after1.stateLabel === "Initialized" && after1.sessionsProcessed === 1 && after1.uniqueReferences === 1,
    "first eligible session: Not initialized → Initialized");
  check(after2.sessionsProcessed === 2 && after2.uniqueReferences === 2 && after2.lastDistance === r2.observed.outcome.deviation.toFixed(3)
    && after2.lastUpdated === formatTimestamp(r2.observed.state.updated_at), "second session: counts, distance and time refreshed");
  check(json(describeBaselineSummary(await d.load())) === json(after2), "the summary equals what a restart would load");
  const long = await startEvent({ storage: st, demo: d, selection: SELECTION.NO_INHALATION });
  check(json(describeBaselineSummary({ state: long.observed.state, error: long.observed.error })) === json(after2), "a long press leaves the summary as it was");
  check(describeBaselineSummary(await d.reset()).stateLabel === "Not initialized", "after the existing reset: Not initialized");
});

await test("19-20. Reference recordings are named by kind and original recording time; ids unchanged", () => {
  // 19. Source-recording times: from the dataset recording id (the dataset's file-name timestamp)
  check(oneSpace(referenceRecordingLabel("ref-inhalation-01")) === "Inhalation reference — Jan 23, 2018, 11:00 AM"
    && oneSpace(referenceRecordingLabel("ref-inhalation-06")) === "Inhalation reference — May 3, 2018, 11:43 AM"
    && oneSpace(referenceRecordingLabel("ref-no-inhalation-01")) === "No-inhalation reference — Jan 23, 2018, 11:00 AM",
    `labels: "${oneSpace(referenceRecordingLabel("ref-inhalation-06"))}", "${oneSpace(referenceRecordingLabel("ref-no-inhalation-01"))}"`);
  for (const r of ANALYSIS_RECORDINGS) {
    const [, y, mo, d, h, mi, s] = /^rec(\d{4})-(\d{2})-(\d{2})_(\d{2})h(\d{2})m(\d{2})\.\d{3}s\.wav$/.exec(r.recordingId).map(Number);
    const t = referenceRecordedAt(r.recordingId);
    check(t && t.getFullYear() === y && t.getMonth() + 1 === mo && t.getDate() === d && t.getHours() === h && t.getMinutes() === mi && t.getSeconds() === s
      && referenceRecordingLabel(r.id).endsWith(formatTimestamp(t)), `${r.id}: recorded ${r.recordingId}`);
  }
  // Session times are never used: the label depends only on the reference.
  for (const s of [s1, s2, s3]) {
    const label = referenceRecordingLabel(s.record.analysis_source.reference_id);
    check(/2018/.test(label) && !/2026/.test(label), `${s.record.session_id}: the 2018 recording time, not the 2026 session time`);
  }
  check(referenceRecordingLabel(s1.record.analysis_source.reference_id) === referenceRecordingLabel(s3.record.analysis_source.reference_id),
    "two sessions with the same reference at different times: the same label");
  // 20. Fallbacks: no usable recording time → a generic name, never a date
  const registry = [
    { id: "x-inhalation", selection: SELECTION.INHALATION, recordingId: "inhale_take_3.wav" },
    { id: "x-no-inhalation", selection: SELECTION.NO_INHALATION, recordingId: null },
    { id: "x-impossible", selection: SELECTION.INHALATION, recordingId: "rec2018-02-31_11h00m14.641s.wav" },
  ];
  check(referenceRecordingLabel("x-inhalation", registry) === "Inhalation reference recording"
    && referenceRecordingLabel("x-no-inhalation", registry) === "No-inhalation reference recording"
    && referenceRecordingLabel("x-impossible", registry) === "Inhalation reference recording", "no time, or an impossible date: generic name");
  check(referenceRecordingLabel("ref-unknown") === "Reference recording" && referenceRecordingLabel(null) === "—" && referenceRecordingLabel(undefined) === "—"
    && referenceRecordedAt("rec2018-01-23_25h00m14.641s.wav") === null && referenceRecordedAt(42) === null, "unknown or missing reference");
  // Ids unchanged; the stored state keeps ids, never labels; contributions stay keyed by session id
  check(json(ANALYSIS_RECORDINGS.map((r) => [r.id, r.asset])) === json([
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => [`ref-inhalation-0${i}`, `demo_recordings/demo_0${i}.wav`]),
    ["ref-no-inhalation-01", "analysis_recordings/no_inhalation_01.wav"],
  ]), "reference ids and WAV assets unchanged");
  check(state3.last_reference_id === A.id && json(state3.unique_reference_ids) === json([A.id, B.id])
    && json(Object.keys(state3.contributions)) === json([s1, s2, s3].map((s) => s.record.session_id)), "the state stores ids and is keyed by session id");
  const view = describeDemoBaseline({ state: state3, error: null }, s3.record);
  check(view.lastReference === referenceRecordingLabel(A.id) && !/ref-|\.wav/.test(json(view)), `session screen: "${oneSpace(view.lastReference)}", not the id`);
  check(describeDemoBaseline({ state: { ...state3, last_reference_id: "ref-gone" }, error: null }, s3.record).lastReference === "Reference recording"
    && describeDemoBaseline({ state: emptyDemoBaseline(REFERENCE.referenceId), error: null }, s1.record).lastReference === "—", "session screen fallbacks");
});

await test("21. Session-screen card layout: the long reference label gets its own line", () => {
  // No React renderer is installed for tests: the layout is checked in the component source.
  const card = code("components/DemoBaselineCard.js");
  const rows = [...card.matchAll(/<Row label="([^"]+)" value=\{[^}]+\}( stacked)? \/>/g)].map((m) => [m[1], Boolean(m[2])]);
  check(json(rows) === json([["State", false], ["Eligible sessions processed", false], ["Unique reference recordings", false],
    ["Most recent reference", true], ["Most recent distance (before update)", false]]), "only the reference row is stacked; the other rows keep label and value side by side");
  check(/style=\{\[styles\.row, stacked && styles\.rowStacked\]\}/.test(card)
    && /rowStacked: \{ flexDirection: "column", alignItems: "flex-start"/.test(card), "stacked row: label above value, both at full card width");
  check(/row: \{\s*flexDirection: "row",\s*justifyContent: "space-between"/.test(card) && /rowLabel: \{ color: COLORS\.textSecondary, fontSize: 14, flexShrink: 1 \}/.test(card)
    && /rowValue: \{ color: COLORS\.text, fontSize: 14, fontWeight: "600" \}/.test(card), "row, label and value styles otherwise unchanged");
  check(referenceRecordingLabel("ref-inhalation-06").length > 40, "the reference value is long enough to need its own line");
});

console.log(`\n${passed} checks passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
