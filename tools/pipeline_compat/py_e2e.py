"""Python reference for the end-to-end app check: full contract output of every reference WAV.

For every WAV in ../PRISM smart inhaler/data this writes one JSON line with:
- the complete `prism_inference.analyze_recording` output (the canonical contract object),
  with input_domain="reference_dataset" and recording_id=<file name>, recorded_at=None;
- the detector's window labels (argmax of the raw logits) and the logits rounded to 5 decimals;
- the 124-dim frame features for the recordings named on the command line (CSV, %.9g).

The research code is imported unchanged. Usage (research venv):
    python tools/pipeline_compat/py_e2e.py <out.jsonl> <frames dir> <file1,file2,...>
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3] / "PRISM smart inhaler"
sys.path.insert(0, str(ROOT / "src"))

import numpy as np  # noqa: E402

from feature_extractor import create_feature_windows  # noqa: E402
from librosa_extractor import extract_features_from_audio  # noqa: E402
from post_event import OnnxEventClassifier  # noqa: E402
from prism_inference import analyze_recording, load_baseline, read_wav  # noqa: E402

out_path, frames_dir = Path(sys.argv[1]), Path(sys.argv[2])
frame_files = set(sys.argv[3].split(",")) if len(sys.argv) > 3 else set()
frames_dir.mkdir(parents=True, exist_ok=True)
detector, baseline = OnnxEventClassifier(), load_baseline()
with out_path.open("w") as out:
    for wav in sorted((ROOT / "data").glob("*.wav")):
        x, sr = read_wav(wav)
        feats = extract_features_from_audio(x, sr)
        windows = create_feature_windows(feats, window_size=25, stride=2)
        logits = detector.session.run([detector.output_name], {detector.input_name: windows.astype(np.float32)})[0]
        result = analyze_recording(x, sr, detector=detector, baseline=baseline, input_domain="reference_dataset",
                                   recording_id=wav.name)
        out.write(json.dumps({"file": wav.name, "n_frames": int(len(feats)), "n_windows": int(len(windows)),
                              "labels": "".join(str(int(i)) for i in logits.argmax(axis=1)),
                              "logits": np.round(logits, 5).tolist(),
                              "output": result}) + "\n")
        if wav.name in frame_files:
            np.savetxt(frames_dir / wav.name.replace(".wav", ".frames.csv"), feats, delimiter=",", fmt="%.9g")
print("done")
