import librosa
import numpy as np
import scipy.signal
import json
import onnxruntime as ort

def extract_features_librosa(y, sr=8000, n_fft=256, hop_length=64):
    S = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop_length, window='hann', center=True, pad_mode='constant'))**2
    mel_basis = librosa.filters.mel(sr=sr, n_fft=n_fft, n_mels=128, fmin=50, fmax=4000)
    S_mel = np.dot(mel_basis, S)
    S_db = librosa.power_to_db(S_mel, ref=1.0, amin=1e-10, top_db=80.0)
    mfcc = librosa.feature.mfcc(S=S_db, n_mfcc=40, dct_type=2, norm='ortho')
    delta = librosa.feature.delta(mfcc, width=9, order=1, mode='interp')
    delta2 = librosa.feature.delta(mfcc, width=9, order=2, mode='interp')
    S_mag = np.sqrt(S)
    centroid = librosa.feature.spectral_centroid(S=S_mag, sr=sr, n_fft=n_fft)[0] / (sr/2)
    flatness = librosa.feature.spectral_flatness(S=S, amin=1e-10, power=1.0)[0]
    rolloff = librosa.feature.spectral_rolloff(S=S_mag, sr=sr, n_fft=n_fft, roll_percent=0.85)[0] / (sr/2)
    zcr = librosa.feature.zero_crossing_rate(y, frame_length=2048, hop_length=hop_length, center=True)[0]

    features = np.vstack([mfcc, delta, delta2, centroid, flatness, rolloff, zcr])
    return features.T # [N, 124]

def build_windows(features, window_size=25, stride=2):
    N = features.shape[0]
    windows = []
    if N < window_size:
        return np.array(windows)
    
    num_windows = (N - window_size) // stride + 1
    for i in range(num_windows):
        start = i * stride
        windows.append(features[start:start+window_size, :])
    return np.array(windows)

# 1. Load WAV
wav_path = 'assets/ml/v2_validation/golden/inputs/white_noise_3s_minus20dBFS.wav'
y, sr = librosa.load(wav_path, sr=8000, mono=True)

# 2. Extract features
features = extract_features_librosa(y)
print(f"Python frames: {features.shape[0]}")

# 3. Build Windows
windows = build_windows(features)
print(f"Python windows: {windows.shape[0]}")

if windows.shape[0] > 0:
    # 4. ONNX Inference
    session = ort.InferenceSession('assets/ml/inhaler_cnn.onnx')
    input_name = session.get_inputs()[0].name
    
    # ONNX expects float32
    windows_f32 = windows.astype(np.float32)
    
    logits = session.run(None, {input_name: windows_f32})[0]
    print(f"Python logits shape: {logits.shape}")
    
    out = {
        "frames_count": features.shape[0],
        "windows_count": windows.shape[0],
        "first_window_logits": logits[0].tolist(),
        "last_window_logits": logits[-1].tolist()
    }
    
    with open('pipeline/wav_parity_reference.json', 'w') as f:
        json.dump(out, f)
    print("Saved reference logits to pipeline/wav_parity_reference.json")
