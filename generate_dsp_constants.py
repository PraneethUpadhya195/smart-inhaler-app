import librosa
import numpy as np
import scipy.signal
import json

sr = 8000
n_fft = 256
n_mels = 128
fmin = 50
fmax = 4000
n_mfcc = 40

# 1. Mel basis
# librosa.filters.mel(sr=8000, n_fft=256, n_mels=128, fmin=50, fmax=4000)
mel_basis = librosa.filters.mel(sr=sr, n_fft=n_fft, n_mels=n_mels, fmin=fmin, fmax=fmax)

import scipy.fftpack

# 2. DCT basis
# librosa uses scipy.fftpack.dct(..., type=2, norm='ortho')
identity = np.eye(n_mels)
dct_basis = scipy.fftpack.dct(identity, axis=0, type=2, norm='ortho')[:n_mfcc]

# 3. Delta weights
# librosa uses scipy.signal.savgol_coeffs for deltas. width=9, order=1 and 2
# mode is 'interp' which means it handles edges, but for inner frames we only need the FIR weights
delta_1 = scipy.signal.savgol_coeffs(9, 1, 1)
delta_2 = scipy.signal.savgol_coeffs(9, 2, 2)

# 4. Hann window
window = scipy.signal.get_window('hann', n_fft, fftbins=True) # periodic by default in librosa

out = {
    "mel_basis": mel_basis.tolist(),
    "dct_basis": dct_basis.tolist(),
    "delta_1": delta_1.tolist(),
    "delta_2": delta_2.tolist(),
    "hann_window": window.tolist(),
    "fft_frequencies": librosa.fft_frequencies(sr=sr, n_fft=n_fft).tolist()
}

with open('pipeline/dsp_constants.json', 'w') as f:
    json.dump(out, f)
    
print("DSP constants generated.")
