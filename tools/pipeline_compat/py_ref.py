"""Python reference (PRISM research pipeline, unchanged) for the app compatibility check.

Writes, for every reference WAV: the detector's window labels and logits, and for selected
recordings the 124-dim frame features. Events and scores come from the contract implementation
(prism_inference.analyze_recording), identical to the Stage 1 table (Entry 10, G6b).
"""
import json
import sys
from pathlib import Path

ROOT = Path(r"D:\Code\projects\CAPSTONE\PRISM smart inhaler")
sys.path.insert(0, str(ROOT / "src"))

import numpy as np  # noqa: E402

from feature_extractor import create_feature_windows  # noqa: E402
from librosa_extractor import extract_features_from_audio  # noqa: E402
from post_event import OnnxEventClassifier  # noqa: E402
from prism_inference import analyze_recording, load_baseline, read_wav  # noqa: E402

out_path, frames_dir, frame_files = Path(sys.argv[1]), Path(sys.argv[2]), set(sys.argv[3].split(","))
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
                              "events": result["events"]}) + "\n")
        if wav.name in frame_files:
            np.savetxt(frames_dir / wav.name.replace(".wav", ".frames.csv"), feats, delimiter=",", fmt="%.9g")
print("done")
