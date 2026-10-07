"""Compare app (JS) pipeline outputs with the PRISM Python reference, stage by stage.

Tolerances are the contract's golden-vector tolerances (inference_contract_v2.json -> conformance).
"""
import json
import sys
from pathlib import Path

import numpy as np

S = Path(sys.argv[1])
FEATS = ["spectral_centroid_mean", "spectral_flatness_mean", "spectral_centroid_std", "spectral_rolloff_std"]
TOL = {"time": 1e-9, "conf": 1e-4, "feat_rel": 1e-4, "rms_rel": 1e-4, "z": 0.01, "score": 0.01}


def load(p):
    return {r["file"]: r for r in map(json.loads, Path(p).read_text().splitlines())}


py, js = load(S / "py_dataset.jsonl"), load(S / "js_dataset.jsonl")
assert py.keys() == js.keys(), "recording sets differ"
summary = {"n_recordings": len(py)}

# ── Stage 2-3: frames, windows, labels, logits ──
frames_ok = sum(py[f]["n_frames"] == js[f]["n_frames"] for f in py)
windows_ok = sum(py[f]["n_windows"] == js[f]["n_windows"] for f in py)
label_total = label_diff = 0
max_logit, rec_label_diff = 0.0, []
for f in py:
    a, b = py[f]["labels"], js[f]["labels"]
    d = sum(x != y for x, y in zip(a, b))
    label_total += len(a)
    label_diff += d
    if d:
        rec_label_diff.append((f, d, len(a)))
    la, lb = np.array(py[f]["logits"]), np.array(js[f]["logits"])
    max_logit = max(max_logit, float(np.abs(la - lb).max()))
summary["frames_count_match"] = f"{frames_ok}/{len(py)}"
summary["windows_count_match"] = f"{windows_ok}/{len(py)}"
summary["window_label_disagreements"] = f"{label_diff}/{label_total}"
summary["recordings_with_label_disagreement"] = rec_label_diff[:20]
summary["max_abs_logit_diff"] = max_logit

# ── Stage 4-7: events, scoreability, features, score ──
rows, status_mismatch, count_mismatch = [], [], []
for f in py:
    pe, je = py[f]["events"], js[f]["events"]
    if (len(pe) == 0) != (len(je) == 0):
        status_mismatch.append(f)
    if len(pe) != len(je):
        count_mismatch.append((f, len(pe), len(je)))
        continue
    for p, j in zip(pe, je):
        r = {"file": f, "d_start": abs(p["start_time"] - j["start"]), "d_end": abs(p["end_time"] - j["end"]),
             "d_conf": abs(p["detector_confidence"] - j["conf"]),
             "d_window_count": p["window_count"] - j["n_windows"],
             "reasons_py": p["not_scoreable_reasons"], "reasons_js": j["reasons"],
             "status_py": p["status"], "scored_js": j["score"] is not None}
        if p["feature_values"] is not None:
            r["feat_rel"] = max(abs(p["feature_values"][k] - j["features"][i]) / abs(p["feature_values"][k]) for i, k in enumerate(FEATS))
        r["rms_rel"] = abs(p["mean_rms"] - j["mean_rms"]) / p["mean_rms"]
        if p["anomaly_score"] is not None and j["score"] is not None:
            r["d_score"] = abs(p["anomaly_score"] - j["score"])
            r["d_z"] = max(abs(p["feature_z_scores"][k] - j["z"][i]) for i, k in enumerate(FEATS))
        rows.append(r)

summary["recording_status_mismatch"] = status_mismatch
summary["event_count_mismatch"] = count_mismatch
summary["events_compared"] = len(rows)
summary["events_py_total"] = sum(len(py[f]["events"]) for f in py)
summary["events_js_total"] = sum(len(js[f]["events"]) for f in js)
summary["no_event_recordings_py_js"] = [sum(not py[f]["events"] for f in py), sum(not js[f]["events"] for f in js)]


def worst(key):
    vals = [r[key] for r in rows if key in r]
    return {"max": max(vals) if vals else None, "n": len(vals)}


summary["start_time"] = worst("d_start") | {"n_over_1e-9": sum(r["d_start"] > TOL["time"] for r in rows)}
summary["end_time"] = worst("d_end") | {"n_over_1e-9": sum(r["d_end"] > TOL["time"] for r in rows)}
summary["end_time_mismatch_events"] = [(r["file"], round(r["d_end"], 6)) for r in rows if r["d_end"] > 1e-6]
summary["detector_confidence"] = worst("d_conf") | {"n_over_tol": sum(r["d_conf"] > TOL["conf"] for r in rows)}
summary["window_count_diff_nonzero"] = sum(r["d_window_count"] != 0 for r in rows)
summary["feature_rel"] = worst("feat_rel") | {"n_over_tol": sum(r.get("feat_rel", 0) > TOL["feat_rel"] for r in rows)}
summary["mean_rms_rel"] = worst("rms_rel") | {"n_over_tol": sum(r["rms_rel"] > TOL["rms_rel"] for r in rows)}
summary["anomaly_score"] = worst("d_score") | {"n_over_tol": sum(r.get("d_score", 0) > TOL["score"] for r in rows)}
summary["z_scores"] = worst("d_z") | {"n_over_tol": sum(r.get("d_z", 0) > TOL["z"] for r in rows)}
summary["reasons_mismatch"] = [(r["file"], r["reasons_py"], r["reasons_js"]) for r in rows if sorted(r["reasons_py"]) != sorted(r["reasons_js"])]
summary["scored_py_js"] = [sum(r["status_py"] == "SCORE_ONLY" for r in rows), sum(r["scored_js"] for r in rows)]

# ── Stage 2 detail: frame features for selected recordings ──
groups = {"mfcc": slice(0, 40), "delta": slice(40, 80), "delta2": slice(80, 120), "centroid": slice(120, 121),
          "flatness": slice(121, 122), "rolloff": slice(122, 123), "zcr": slice(123, 124)}
frame_rows = {}
for p in sorted((S / "frames_py").glob("*.csv")):
    a = np.loadtxt(p, delimiter=",")
    b = np.loadtxt(S / "frames_js" / p.name, delimiter=",")
    d = np.abs(a - b)
    frame_rows[p.name.replace(".frames.csv", "")] = {
        "overall_mae": float(d.mean()), "max_abs": float(d.max()),
        "max_per_dim_mae": float(d.mean(axis=0).max()), "worst_dim": int(d.mean(axis=0).argmax()),
        "max_per_dim_mae_excl_zcr": float(d[:, :123].mean(axis=0).max()),
        **{g: float(d[:, s].max()) for g, s in groups.items()},
        "zcr_frames_differing": int((d[:, 123] > 1e-6).sum()), "n_frames": int(len(a)),
        "zcr_max_crossings_diff": int(round(float(d[:, 123].max()) * 2048)),
    }
summary["frame_features"] = frame_rows
print(json.dumps(summary, indent=1, default=str))
