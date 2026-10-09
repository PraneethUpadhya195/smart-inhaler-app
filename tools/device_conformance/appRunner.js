/**
 * tools/device_conformance/appRunner.js — DEV-ONLY on-device conformance run.
 *
 * Runs recordings through the app's own React Native pipeline (services/inferenceService:
 * onnxruntime-react-native, the bundled model, the frozen V2 baseline) and the app's session
 * layer (SessionAggregator + buildSessionRecord), and writes everything to a JSON file that the
 * host script (run_device_conformance.mjs) pulls and compares with the reference outputs.
 *
 * Nothing runs unless the host script has placed request.json in
 * <document directory>/prism_conformance/, which needs `adb shell run-as` (debuggable builds).
 * Nothing is written to Firestore. index.js loads this module only when __DEV__ is true.
 */

import * as ort from "onnxruntime-react-native";
import { Directory, File, Paths } from "expo-file-system";

import { getPipeline } from "../../services/inferenceService";
import { loadModelBytes } from "../../pipeline/runtime/reactNative";
import { buildSessionRecord } from "../../services/sessionRecord";
import { runSimulatedSession } from "../../services/simulationService";
import OnnxDetector from "../../pipeline/OnnxDetector";
import PcmSource from "../../pipeline/PcmSource";
import SessionAggregator from "../../pipeline/SessionAggregator";
import WavPcmSource from "../../pipeline/sources/WavPcmSource";

const TAG = "[PRISM-CONFORMANCE]";
const DIR_NAME = "prism_conformance";
const RESULTS_SCHEMA = "prism-device-conformance-v1";

/** PCM built from a small JSON description (contract input-error cases). */
class InlinePcmSource extends PcmSource {
  constructor(spec, sourceId) {
    super("test");
    this.spec = spec;
    this.sourceId = sourceId;
  }

  async acquire() {
    const samples = new Float32Array(this.spec.n);
    for (const [index, value] of this.spec.set ?? []) samples[index] = value === "NaN" ? NaN : value;
    return {
      samples,
      sampleRate: this.spec.sampleRate,
      channels: this.spec.channels ?? 1,
      sourceType: this.sourceType,
      sourceId: this.sourceId,
      recordedAt: null,
      inputDomain: this.spec.input_domain ?? "unknown",
    };
  }
}

const errorInfo = (e) => ({ name: e?.name ?? "Error", message: e?.message ?? String(e) });

/** The session the app would store for this recording (same path as runSimulatedSession). */
function sessionFor(caseName, output, processingError) {
  const session = new SessionAggregator().aggregate(
    `conformance_${caseName}`,
    output ? [output] : [],
    { processingErrors: processingError ? [processingError] : [] },
  );
  return buildSessionRecord(session, { source: "wav", simulated: false, note: "on-device conformance run" });
}

async function runCase(pipeline, dir, c) {
  const started = Date.now();
  const sourceId = c.source_id ?? c.file ?? null; // inline cases: null, as in the golden files
  let output = null;
  let error = null;
  try {
    let source;
    if (c.file) {
      const bytes = await new File(dir, c.file).bytes();
      source = new WavPcmSource(bytes, { inputDomain: c.input_domain ?? "unknown", sourceId });
    } else {
      source = new InlinePcmSource(c.inline, sourceId);
    }
    output = await pipeline.run(source);
  } catch (e) {
    error = errorInfo(e);
  }
  const ms = Date.now() - started;
  let session = null;
  let sessionError = null;
  try {
    session = sessionFor(c.case, output, error ? { recording_id: sourceId, message: error.message } : null);
  } catch (e) {
    sessionError = errorInfo(e);
  }
  const summary = output
    ? `${output.recording_status}${output.error ? ` (${output.error})` : ""}, ${output.n_events} event(s), ${output.n_scored} scored`
    : `run() threw ${error.name}: ${error.message}`;
  console.log(`${TAG} ${c.case}: ${summary}; session ${session?.session_status ?? "not built"}; ${ms} ms`);
  return { case: c.case, ms, output, error, session, session_error: sessionError };
}

/** Failure paths: each must surface an error and never yield a contract output. */
async function errorPaths(modelBytes) {
  const results = [];
  const record = async (name, fn) => {
    try {
      const value = await fn();
      results.push({ name, threw: false, value });
    } catch (e) {
      results.push({ name, threw: true, error: errorInfo(e) });
    }
    const last = results[results.length - 1];
    console.log(`${TAG} error path ${name}: ${last.threw ? `threw ${last.error.name}: ${last.error.message}` : "did not throw"}`);
  };
  await record("tampered_model_bytes", async () => {
    const tampered = modelBytes.slice();
    tampered[tampered.length - 1] ^= 0xff;
    await OnnxDetector.create(ort, tampered);
  });
  await record("ort_invalid_model_bytes", async () => {
    await ort.InferenceSession.create(new Uint8Array([8, 1, 18, 3, 1, 2, 3]));
  });
  await record("pipeline_factory_failure_session", async () => {
    const session = await runSimulatedSession(() => Promise.reject(new Error("injected pipeline failure")));
    return { session_status: session.session_status, n_recordings: session.n_recordings,
      recordings: session.recordings.length, processing_errors: session.processing_errors };
  });
  return results;
}

export async function runIfRequested() {
  const dir = new Directory(Paths.document, DIR_NAME);
  const requestFile = new File(dir, "request.json");
  if (!dir.exists || !requestFile.exists) return;
  const request = JSON.parse(await requestFile.text());
  requestFile.delete(); // one run per request
  console.log(`${TAG} request ${request.id}: ${request.cases.length} case(s)`);

  const results = {
    schema: RESULTS_SCHEMA,
    request_id: request.id,
    started_at: new Date().toISOString(),
    runtime: {
      ort_versions: { ...ort.env.versions },
      ort_native_version: globalThis.OrtApi?.version ?? null,
      hermes: typeof globalThis.HermesInternal === "object",
    },
    model: null,
    pipeline_error: null,
    cases: [],
    simulated_session: null,
    error_paths: null,
    finished_at: null,
  };
  try {
    const started = Date.now();
    const pipeline = await getPipeline();
    const detector = pipeline._detector;
    results.model = {
      load_ms: Date.now() - started,
      sha256: detector.modelSha256,
      input_names: detector.session.inputNames,
      output_names: detector.session.outputNames,
      input_metadata: detector.session.inputMetadata ?? null,
      output_metadata: detector.session.outputMetadata ?? null,
    };
    console.log(`${TAG} model loaded in ${results.model.load_ms} ms, sha256 ${detector.modelSha256}`);
    for (const c of request.cases) results.cases.push(await runCase(pipeline, dir, c));

    const sim = await runSimulatedSession(getPipeline);
    results.simulated_session = sim;
    console.log(`${TAG} simulated session: ${sim.session_status}, simulated=${sim.simulated}`);

    results.error_paths = await errorPaths(await loadModelBytes());
  } catch (e) {
    results.pipeline_error = errorInfo(e);
    console.error(`${TAG} pipeline could not run: ${e?.message ?? e}`);
  }
  results.finished_at = new Date().toISOString();
  const resultsFile = new File(dir, "results.json");
  if (!resultsFile.exists) resultsFile.create();
  resultsFile.write(JSON.stringify(results));
  console.log(`${TAG} done: results.json written (${results.cases.length} case(s))`);
}
