"""Write pipeline/zcr_reference.json: a librosa zero-crossing-rate reference for the app's DSP test.

The signal exercises the cases where the app's former ZCR differed from librosa (F7):
exact zeros (16-bit audio has many), values within the 1e-10 threshold, a negative first
sample and a zero last sample (edge padding), and ordinary sign changes.

Run with the research venv (librosa 0.11.0):
    python tools/pipeline_compat/make_zcr_fixture.py
"""
import json
from pathlib import Path

import librosa
import numpy as np

rng = np.random.default_rng(20261007)
n = 6000
y = (rng.integers(-3, 4, size=n) / 32768.0).astype(np.float32)   # many exact zeros, small values
y[1000:1400] = 0.0                                               # a run of exact zeros
y[1400:1500] = np.where(np.arange(100) % 2, 1e-11, -1e-11)       # inside the 1e-10 threshold
y[2000:2500] = np.sin(np.arange(500) * 0.3).astype(np.float32) * 0.5
y[0] = -0.25                                                     # negative edge value (edge padding)
y[-1] = 0.0                                                      # zero edge value
zcr = librosa.feature.zero_crossing_rate(y, frame_length=2048, hop_length=64, center=True)[0]

out = Path(__file__).resolve().parents[2] / "pipeline" / "zcr_reference.json"
out.write_text(json.dumps({
    "generator": "tools/pipeline_compat/make_zcr_fixture.py",
    "librosa_version": librosa.__version__,
    "call": "librosa.feature.zero_crossing_rate(y, frame_length=2048, hop_length=64, center=True)",
    "signal_float32": [float(v) for v in y],
    "zcr": [float(v) for v in zcr],
}) + "\n")
print(out, len(zcr), "frames")
