// Per-stage timing of the app pipeline on one WAV (cwd = app repo root): node tools/pipeline_compat/timing.mjs <wav>
import InferencePipeline from "../../pipeline/InferencePipeline.js";
import WavPcmSource from "../../pipeline/sources/WavPcmSource.js";
const ort = (await import("onnxruntime-node")).default ?? (await import("onnxruntime-node"));
const p = new InferencePipeline();
const pcm = await new WavPcmSource(process.argv[2]).acquire(); pcm.channels = 1;
await p.runInference(p.buildWindows(await p.extractFrameFeatures(pcm)));   // warm-up (model load)
const t = () => performance.now(); let a;
a = t(); const fr = await p.extractFrameFeatures(pcm); const tDsp = t() - a;
a = t(); const w = p.buildWindows(fr); const tWin = t() - a;
a = t(); const pr = await p.runInference(w); const tOnnx = t() - a;
// batched alternative: one [N,25,124] call on the same session
const flat = new Float32Array(w.length * 3100); w.forEach((x, i) => flat.set(x.tensor, i * 3100));
a = t(); const out = await p._baseline.run({ features: new ort.Tensor("float32", flat, [w.length, 25, 124]) }); const tBatch = t() - a;
const L = out.logits.data; let maxd = 0; pr.forEach((q, i) => { for (let k = 0; k < 4; k++) maxd = Math.max(maxd, Math.abs(q.logits[k] - L[i * 4 + k])); });
a = t(); const ev = p.decodeEvents(pr, pcm); for (const e of ev) await p.extractEventFeatures(p.extractEventPcm(e, pcm)); const tEv = t() - a;
console.log(JSON.stringify({ frames: fr.length, windows: w.length, dsp_ms: +tDsp.toFixed(1), windows_ms: +tWin.toFixed(1), onnx_per_window_ms: +tOnnx.toFixed(1), onnx_batched_ms: +tBatch.toFixed(1), batched_vs_per_window_max_logit_diff: maxd, events_features_ms: +tEv.toFixed(1) }));
