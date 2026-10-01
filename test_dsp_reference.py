import librosa
import numpy as np
import scipy.signal
import json

sr = 8000
n_fft = 256
hop_length = 64
n_mels = 128
fmin = 50
fmax = 4000
n_mfcc = 40

def extract_features_librosa(y):
    # 1. STFT -> Power Spectrogram
    # center=True (default in librosa) pad_mode='constant' (default is 'reflect', so we must specify 'constant')
    # wait, the contract specifies: "pad_mode constant"
    S = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop_length, window='hann', center=True, pad_mode='constant'))**2

    # 2. Mel Spectrogram
    mel_basis = librosa.filters.mel(sr=sr, n_fft=n_fft, n_mels=n_mels, fmin=fmin, fmax=fmax)
    S_mel = np.dot(mel_basis, S)

    # 3. Power to DB
    # power_to_db(ref 1, amin 1e-10, top_db 80)
    S_db = librosa.power_to_db(S_mel, ref=1.0, amin=1e-10, top_db=80.0)

    # 4. MFCC
    # librosa default dct_type=2, norm='ortho'
    mfcc = librosa.feature.mfcc(S=S_db, n_mfcc=n_mfcc, dct_type=2, norm='ortho')

    # 5. Deltas
    # width 9, mode 'interp'
    # Wait, scipy savgol_filter 'interp' mode isn't valid for delta if order doesn't match?
    # actually librosa.feature.delta defaults: width=9, order=1, axis=-1, mode='interp'
    delta = librosa.feature.delta(mfcc, width=9, order=1, mode='interp')
    delta2 = librosa.feature.delta(mfcc, width=9, order=2, mode='interp')

    # 6. Spectral Features (uses magnitude spectrum S_mag = sqrt(S))
    S_mag = np.sqrt(S)
    
    # centroid (librosa normalizes by sr/2 if not specified? No, librosa returns Hz)
    centroid = librosa.feature.spectral_centroid(S=S_mag, sr=sr, n_fft=n_fft)[0] / (sr/2)

    # flatness (librosa uses power spectrum S)
    # librosa adds amin=1e-10
    flatness = librosa.feature.spectral_flatness(S=S, amin=1e-10, power=1.0)[0] # Wait, power=1.0? Librosa default is power=1.0 for spectral_flatness but wait, librosa spectral_flatness defaults to power=2 (if S is magnitude, S**2). If we pass S (which is already power), we should set power=1.0. Actually, librosa docs: S is power spectrogram.
    
    # rolloff (default roll_percent=0.85)
    rolloff = librosa.feature.spectral_rolloff(S=S_mag, sr=sr, n_fft=n_fft, roll_percent=0.85)[0] / (sr/2)

    # 7. ZCR
    # frame 2048, hop 64, center=True, pad=True, pad_mode='constant' (wait, default is 'edge' in librosa for zcr? Actually default pad_mode for zcr is 'edge', but zcr doesn't use STFT, it uses time domain. Contract: "center=True". Librosa default pad is True, pad_mode 'edge' for zcr?)
    # Contract just says: "librosa.feature.zero_crossing_rate frame 2048, hop 64, center=True"
    zcr = librosa.feature.zero_crossing_rate(y, frame_length=2048, hop_length=hop_length, center=True)[0]

    # Transpose all to time-major
    return {
        "mfcc": mfcc.T.tolist(),
        "delta": delta.T.tolist(),
        "delta2": delta2.T.tolist(),
        "centroid": centroid.tolist(),
        "flatness": flatness.tolist(),
        "rolloff": rolloff.tolist(),
        "zcr": zcr.tolist()
    }

# Generate synthetic PCM (0.5s of 440Hz sine wave + noise)
t = np.linspace(0, 0.5, int(sr * 0.5), endpoint=False)
y = 0.5 * np.sin(2 * np.pi * 440 * t) + 0.1 * np.random.randn(len(t))
y = y.astype(np.float32)

ref_features = extract_features_librosa(y)

out = {
    "pcm": y.tolist(),
    "features": ref_features
}

with open('pipeline/parity_data.json', 'w') as f:
    json.dump(out, f)

print("Python reference data generated.")
