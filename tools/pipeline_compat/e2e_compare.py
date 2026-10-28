"""Compare the app's run() outputs (e2e_run.mjs) with the research reference (py_e2e.py).

Every recording's canonical output is compared field by field at the contract's golden
tolerances (inference_contract_v2.json -> conformance.tolerances):
  status, error, event count, event status, reasons, window count: exact
  start/end/duration: 1e-9 s;  detector confidence: 1e-4 abs
  feature values and mean_rms: 1e-4 relative;  z-scores and anomaly_score: 0.01 abs
Also: detector window labels and logits, and frame features for the recordings dumped by both.

    python tools/pipeline_compat/e2e_compare.py <dir with py_e2e.jsonl, js_e2e*.jsonl, frames_py/, frames_js/>
"""
import json
import sys
from pathlib import Path

import numpy as np

S = Path(sys.argv[1])
FEATS = ["spectral_centroid_mean", "spectral_flatness_mean", "spectral_centroid_std", "spectral_rolloff_std"]
TOL = {"time": 1e-9, "conf": 1e-4, "feat_rel": 1e-4, "rms_rel": 1e-4, "z": 0.01, "score": 0.01}


def load(paths):
    rows = {}
    for p in paths:
        for line in Path(p).read_text().splitlines():
            r = json.loads(line)
            rows[r["file"]] = r
    return rows


py = load([S / "py_e2e.jsonl"])
js = load(sorted(S.glob("js_e2e*.jsonl")))
assert py.keys() == js.keys(), f"recording sets differ: {len(py)} vs {len(js)}"
s = {"n_recordings": len(py)}

# Detector
label_total = label_diff = 0
max_logit = 0.0
for f in py:
    a, b = py[f]["labels"], js[f]["labels"]
    assert len(a) == len(b), f"{f}: window count {len(a)} vs {len(b)}"
    label_total += len(a)
    label_diff += sum(x != y for x, y in zip(a, b))
    if a:
        max_logit = max(max_logit, float(np.abs(np.array(py[f]["logits"]) - np.array(js[f]["logits"])).max()))
s["frames_count_match"] = sum(py[f]["n_frames"] == js[f]["n_frames"] for f in py)
s["windows_count_match"] = sum(py[f]["n_windows"] == js[f]["n_windows"] for f in py)
s["window_label_disagreements"] = f"{label_diff}/{label_total}"
s["max_abs_logit_diff"] = max_logit

# Recording level
TOP_EXACT = ["contract_version", "baseline_id", "detector_model_sha256", "recording_status", "error",
             "baseline_domain_validated", "feature_order", "n_events", "n_scored", "interpretation", "input"]
top_mismatch = [(f, k) for f in py for k in TOP_EXACT if py[f]["output"][k] != js[f]["output"][k]]
s["recording_field_mismatches"] = top_mismatch[:20]
s["n_recording_field_mismatches"] = len(top_mismatch)
s["key_order_mismatches"] = [f for f in py if list(py[f]["output"]) != list(js[f]["output"])]
s["recording_status_counts_py"] = {}
s["recording_status_counts_js"] = {}
for name, src in (("py", py), ("js", js)):
    for f in src:
        k = src[f]["output"]["recording_status"]
        s[f"recording_status_counts_{name}"][k] = s[f"recording_status_counts_{name}"].get(k, 0) + 1

# Event level
worst = {k: 0.0 for k in ("start", "end", "duration", "conf", "max_conf", "feat_rel", "rms_rel", "z", "score")}
over = {k: [] for k in worst}
exact_mismatch = []
n_events = n_scored_py = n_scored_js = 0
bit_identical_times = 0
for f in py:
    pe, je = py[f]["output"]["events"], js[f]["output"]["events"]
    if len(pe) != len(je):
        exact_mismatch.append((f, "event count", len(pe), len(je)))
        continue
    for p, j in zip(pe, je):
        n_events += 1
        n_scored_py += p["status"] == "SCORE_ONLY"
        n_scored_js += j["status"] == "SCORE_ONLY"
        for k in ("event_id", "window_count", "status", "not_scoreable_reasons"):
            if p[k] != j[k]:
                exact_mismatch.append((f, p["event_id"], k, p[k], j[k]))
        bit_identical_times += p["start_time"] == j["start_time"] and p["end_time"] == j["end_time"]

        def note(key, value, limit, where=(f, p["event_id"])):
            worst[key] = max(worst[key], value)
            if value > limit:
                over[key].append((*where, value))

        note("start", abs(p["start_time"] - j["start_time"]), TOL["time"])
        note("end", abs(p["end_time"] - j["end_time"]), TOL["time"])
        note("duration", abs(p["duration_s"] - j["duration_s"]), TOL["time"])
        note("conf", abs(p["detector_confidence"] - j["detector_confidence"]), TOL["conf"])
        note("max_conf", abs(p["detector_max_confidence"] - j["detector_max_confidence"]), TOL["conf"])
        if (p["feature_values"] is None) != (j["feature_values"] is None):
            exact_mismatch.append((f, p["event_id"], "feature_values presence"))
        elif p["feature_values"] is not None:
            note("feat_rel", max(abs(p["feature_values"][k] - j["feature_values"][k]) / abs(p["feature_values"][k]) for k in FEATS), TOL["feat_rel"])
        if (p["mean_rms"] is None) != (j["mean_rms"] is None):
            exact_mismatch.append((f, p["event_id"], "mean_rms presence"))
        elif p["mean_rms"] is not None:
            note("rms_rel", abs(p["mean_rms"] - j["mean_rms"]) / abs(p["mean_rms"]), TOL["rms_rel"])
        if (p["anomaly_score"] is None) != (j["anomaly_score"] is None):
            exact_mismatch.append((f, p["event_id"], "anomaly_score presence"))
        elif p["anomaly_score"] is not None:
            note("score", abs(p["anomaly_score"] - j["anomaly_score"]), TOL["score"])
            note("z", max(abs(p["feature_z_scores"][k] - j["feature_z_scores"][k]) for k in FEATS), TOL["z"])

s["events_py_js"] = [sum(len(py[f]["output"]["events"]) for f in py), sum(len(js[f]["output"]["events"]) for f in js)]
s["scored_py_js"] = [n_scored_py, n_scored_js]
s["events_with_bit_identical_start_and_end"] = f"{bit_identical_times}/{n_events}"
s["exact_field_mismatches"] = exact_mismatch[:20]
s["n_exact_field_mismatches"] = len(exact_mismatch)
s["max_abs_or_rel_diff"] = worst
s["n_over_tolerance"] = {k: len(v) for k, v in over.items()}
s["over_tolerance_examples"] = {k: v[:5] for k, v in over.items() if v}

# Frame features
groups = {"mfcc": slice(0, 40), "delta": slice(40, 80), "delta2": slice(80, 120), "centroid": slice(120, 121),
          "flatness": slice(121, 122), "rolloff": slice(122, 123), "zcr": slice(123, 124)}
frames = {}
for p in sorted((S / "frames_py").glob("*.csv")):
    q = S / "frames_js" / p.name
    if not q.exists():
        continue
    a, b = np.loadtxt(p, delimiter=","), np.loadtxt(q, delimiter=",")
    d = np.abs(a - b)
    frames[p.name.replace(".frames.csv", "")] = {
        "max_per_dim_mae": float(d.mean(axis=0).max()), **{g: float(d[:, sl].max()) for g, sl in groups.items()},
        "zcr_frames_differing": int((d[:, 123] > 1e-6).sum()), "rolloff_frames_differing": int((d[:, 122] > 1e-6).sum()),
        "n_frames": int(len(a))}
s["frame_features"] = frames
s["js_total_seconds"] = round(sum(js[f].get("ms", 0) for f in js) / 1000, 1)
print(json.dumps(s, indent=1, default=str))
