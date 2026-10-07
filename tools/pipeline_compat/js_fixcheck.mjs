// Checks the F14 timing fix WITHOUT changing app code: window times are overwritten with the reference formula.
// cwd = app repo root: node tools/pipeline_compat/js_fixcheck.mjs <data dir> <comma-separated wav list file> <out.jsonl>
import fs from "fs"; import path from "path";
import InferencePipeline from "../../pipeline/InferencePipeline.js";
import WavPcmSource from "../../pipeline/sources/WavPcmSource.js";
const [dataDir, list, outPath] = process.argv.slice(2);
const pipe = new InferencePipeline(); const out = fs.createWriteStream(outPath);
const STRIDE = 2 * 64 / 8000, WIN = 25 * 64 / 8000;
for (const file of fs.readFileSync(list, "utf8").trim().split(",")) {
  const pcm = await new WavPcmSource(path.join(dataDir, file)).acquire(); pcm.channels = 1;
  const preds = await pipe.runInference(pipe.buildWindows(await pipe.extractFrameFeatures(pcm)));
  const dur = pcm.samples.length / 8000;
  for (const p of preds) { p.startTime = p.windowIndex * STRIDE; p.endTime = Math.min(p.startTime + WIN, dur); }
  const events = pipe.decodeEvents(preds, pcm); const evOut = [];
  for (const ev of events) {
    const f = await pipe.extractEventFeatures(pipe.extractEventPcm(ev, pcm));
    const sc = pipe.checkScoreability(ev, events, pcm, f);
    const s = sc.isScoreable ? await pipe.scoreEvent(f) : null;
    evOut.push({ start: ev.startS, end: ev.endS, conf: ev.detectorConfidence, n_windows: ev.windowPredictions.length, features: Array.from(f.features), mean_rms: f.mean_rms, reasons: sc.reasons, score: s ? s.anomalyScore : null, z: s ? Array.from(s.featureZScores) : null });
  }
  out.write(JSON.stringify({ file, events: evOut }) + "\n");
}
out.end();
