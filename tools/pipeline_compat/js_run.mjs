// Runs the smart-inhaler-app pipeline code (this repository, unmodified) on reference WAVs.
// Usage (cwd must be the app repo root, because the app uses cwd-relative asset paths):
//   node tools/pipeline_compat/js_run.mjs integration <ref wav>
//   node tools/pipeline_compat/js_run.mjs dataset <data dir> <out.jsonl> [frames-out-dir file1,file2,...]
import fs from "fs";
import path from "path";
import InferencePipeline from "../../pipeline/InferencePipeline.js";
import WavPcmSource from "../../pipeline/sources/WavPcmSource.js";
import SimulatedPcmSource from "../../pipeline/sources/SimulatedPcmSource.js";
import SessionAggregator from "../../pipeline/SessionAggregator.js";

const [mode, ...args] = process.argv.slice(2);

function show(label, value) {
  console.log(`\n### ${label}`);
  console.log(JSON.stringify(value, (k, v) => (v === undefined ? "<<undefined>>" : v), 2));
}

async function integration(wav) {
  // 1. App entry point exactly as written: run(WavPcmSource)
  show("run(new WavPcmSource(wav)) — as written", await new InferencePipeline().run(new WavPcmSource(wav)));

  // 2. Same, with the missing PcmData fields supplied, to expose the result-builder wiring
  class FixedWav extends WavPcmSource {
    async acquire() {
      const d = await super.acquire();
      return { ...d, channels: 1, sourceType: "wav", sourceId: path.basename(wav), recordedAt: "2018-01-22T17:41:49.809" };
    }
  }
  const rec = await new InferencePipeline().run(new FixedWav(wav));
  show("run(WavPcmSource + channels/sourceId/recordedAt supplied)", rec);
  show("JSON round trip of featureZScores (what Firestore/JSON would see)", JSON.parse(JSON.stringify(rec.events?.[0]?.featureZScores ?? null)));

  // 3. SessionAggregator on that result
  show("SessionAggregator.aggregate(result)", new SessionAggregator().aggregate("s1", [rec]));

  // 4. Simulation path used by the Dashboard "Simulate Inhalation" button
  try {
    const { generateMockSession } = await import("../../services/simulationService.js");
    const p = generateMockSession();
    show("generateMockSession() returns (not awaited, as DashboardScreen calls it)", { isPromise: p instanceof Promise });
    show("awaited generateMockSession()", await p);
  } catch (e) {
    show("generateMockSession() threw", String(e));
  }

  // 5. SimulatedPcmSource through run()
  try {
    show("run(SimulatedPcmSource default)", await new InferencePipeline().run(new SimulatedPcmSource()));
  } catch (e) {
    show("run(SimulatedPcmSource) threw", String(e));
  }

  // 6. Input-error behaviour vs contract codes
  const pipe = new InferencePipeline();
  const mk = (samples, extra = {}) => ({ acquire: async () => ({ samples, sampleRate: 8000, channels: 1, sourceType: "test", sourceId: "x", recordedAt: null, ...extra }) });
  const loud = new Float32Array(16000); loud[100] = 1.5;
  show("amplitude 1.5 (contract: INPUT_ERROR amplitude_out_of_range)", (await pipe.run(mk(loud))).error ?? "no error / ran");
  show("16 kHz input (contract: unsupported_sample_rate)", (await pipe.run(mk(new Float32Array(32000), { sampleRate: 16000 }))).error);
  show("1000 samples (contract: shorter_than_one_detector_window)", (await pipe.run(mk(new Float32Array(1000)))).error);
}

async function dataset(dataDir, outPath, framesDir, frameFiles) {
  const pipe = new InferencePipeline();
  const wantFrames = new Set((frameFiles || "").split(",").filter(Boolean));
  const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".wav")).sort();
  const out = fs.createWriteStream(outPath);
  const t0 = Date.now();
  for (const file of files) {
    const pcm = await new WavPcmSource(path.join(dataDir, file)).acquire();
    pcm.channels = 1;
    const frames = await pipe.extractFrameFeatures(pcm);
    const windows = pipe.buildWindows(frames);
    const preds = await pipe.runInference(windows);
    const events = pipe.decodeEvents(preds, pcm);
    const evOut = [];
    for (const ev of events) {
      const seg = pipe.extractEventPcm(ev, pcm);
      const f = await pipe.extractEventFeatures(seg);
      const sc = pipe.checkScoreability(ev, events, pcm, f);
      let score = null, z = null;
      if (sc.isScoreable) {
        const s = await pipe.scoreEvent(f);
        score = s.anomalyScore;
        z = Array.from(s.featureZScores);
      }
      evOut.push({ start: ev.startS, end: ev.endS, duration: ev.durationS, conf: ev.detectorConfidence,
                   max_conf: ev.detectorMaxConfidence, n_windows: ev.windowPredictions.length,
                   features: Array.from(f.features), mean_rms: f.mean_rms, reasons: sc.reasons, score, z });
    }
    out.write(JSON.stringify({ file, n_samples: pcm.samples.length, n_frames: frames.length, n_windows: windows.length,
                               labels: preds.map((p) => p.predictedClass).join(""),
                               logits: preds.map((p) => Array.from(p.logits).map((v) => +v.toFixed(5))),
                               win_end_last: windows.length ? windows[windows.length - 1].endTime : null,
                               events: evOut }) + "\n");
    if (wantFrames.has(file)) {
      const rows = frames.map((fr) => Array.from(fr.features).join(","));
      fs.writeFileSync(path.join(framesDir, file.replace(".wav", ".frames.csv")), rows.join("\n") + "\n");
    }
  }
  out.end();
  console.log(`processed ${files.length} recordings in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

if (mode === "integration") await integration(args[0]);
else if (mode === "dataset") await dataset(args[0], args[1], args[2], args[3]);
else console.log("mode must be integration | dataset");
