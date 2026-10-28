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
delta_1 = scipy.signal.savgol_coeffs(9, 1, 1)
delta_2 = scipy.signal.savgol_coeffs(9, 2, 2)

# Extract edge filters for mode='interp' by applying savgol_filter to identity
# We need the first 4 frames and last 4 frames weights.
# A signal of length L=13 is enough to get the first 4 and last 4 unaffected by each other.
identity_13 = np.eye(13)
savgol_1 = scipy.signal.savgol_filter(identity_13, 9, 1, deriv=1, mode='interp', axis=0)
savgol_2 = scipy.signal.savgol_filter(identity_13, 9, 2, deriv=1, mode='interp', axis=0)

# The first 4 frames of output depend on the first 9 frames of input.
# savgol_1[0, :] gives the weights to apply to the input to get frame 0.
# It should only be non-zero for the first 9 elements.
edge_start_1 = savgol_1[:4, :9].tolist()
edge_end_1 = savgol_1[-4:, -9:].tolist()

savgol_2_d2 = scipy.signal.savgol_filter(identity_13, 9, 2, deriv=2, mode='interp', axis=0)
edge_start_2 = savgol_2_d2[:4, :9].tolist()
edge_end_2 = savgol_2_d2[-4:, -9:].tolist()

# 4. Hann window
window = scipy.signal.get_window('hann', n_fft, fftbins=True) # periodic by default in librosa

out = {
    "mel_basis": mel_basis.tolist(),
    "dct_basis": dct_basis.tolist(),
    "delta_1": delta_1.tolist(),
    "delta_2": delta_2.tolist(),
    "edge_start_1": edge_start_1,
    "edge_end_1": edge_end_1,
    "edge_start_2": edge_start_2,
    "edge_end_2": edge_end_2,
    "hann_window": window.tolist(),
    "fft_frequencies": librosa.fft_frequencies(sr=sr, n_fft=n_fft).tolist()
}

with open('pipeline/dsp_constants.json', 'w') as f:
    json.dump(out, f)
    
print("DSP constants generated.")
