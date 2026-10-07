// End-to-end app run on the reference recordings: InferencePipeline.run() exactly as the app calls it.
// Writes one JSON line per WAV: the canonical output, plus the window labels and logits observed
// (read-only) from runInference, plus frame features for the selected recordings.
//
//   node tools/pipeline_compat/e2e_run.mjs <data dir> <out.jsonl> [frames dir] [file1,file2,...] [--shard i/n]
//
// Compare with e2e_compare.py against py_e2e.py. Paths are resolved from the module, not the cwd.
import fs from "node:fs";
import path from "node:path";
import { createNodePipeline } from "../../pipeline/runtime/node.js";
import WavPcmSource from "../../pipeline/sources/WavPcmSource.js";

const args = process.argv.slice(2);
const shardArg = args.indexOf("--shard");
const [shardIndex, shardCount] = shardArg >= 0 ? args.splice(shardArg, 2)[1].split("/").map(Number) : [0, 1];
const [dataDir, outPath, framesDir, frameList] = args;
const wantFrames = new Set((frameList || "").split(",").filter(Boolean));

const pipeline = await createNodePipeline();
let observed = null;
const runInference = pipeline.runInference.bind(pipeline);
pipeline.runInference = async (windows) => {
  const predictions = await runInference(windows);
  observed.predictions = predictions;
  return predictions;
};
const extractFrameFeatures = pipeline.extractFrameFeatures.bind(pipeline);
pipeline.extractFrameFeatures = async (pcm) => {
  const frames = await extractFrameFeatures(pcm);
  observed.frames = frames;
  return frames;
};

const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".wav")).sort()
  .filter((_, i) => i % shardCount === shardIndex);
const out = fs.createWriteStream(outPath);
const t0 = Date.now();
for (const file of files) {
  observed = { predictions: [], frames: [] };
  const t = Date.now();
  const output = await pipeline.run(new WavPcmSource(fs.readFileSync(path.join(dataDir, file)),
    { inputDomain: "reference_dataset", sourceId: file }));
  out.write(JSON.stringify({
    file,
    ms: Date.now() - t,
    n_frames: observed.frames.length,
    n_windows: observed.predictions.length,
    labels: observed.predictions.map((p) => p.predictedClass).join(""),
    logits: observed.predictions.map((p) => Array.from(p.logits, (v) => +v.toFixed(5))),
    output,
  }) + "\n");
  if (framesDir && wantFrames.has(file)) {
    fs.mkdirSync(framesDir, { recursive: true });
    const rows = observed.frames.map((fr) => Array.from(fr.features).join(","));
    fs.writeFileSync(path.join(framesDir, file.replace(".wav", ".frames.csv")), rows.join("\n") + "\n");
  }
}
await new Promise((resolve) => out.end(resolve));
console.log(`shard ${shardIndex}/${shardCount}: ${files.length} recordings in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
