# PRISM — Smart Inhaler App

> Mobile companion app for the PRISM smart inhaler platform. Tracks inhalation sessions, evaluates technique quality, and syncs derived analytics to Firebase — no raw audio leaves the device.

[![Expo SDK 54](https://img.shields.io/badge/Expo-SDK%2054-blue.svg)](https://expo.dev/)
[![React Native](https://img.shields.io/badge/React%20Native-0.81-61dafb.svg)](https://reactnative.dev/)
[![Firebase](https://img.shields.io/badge/Firebase-Firestore%20%2B%20Auth-orange.svg)](https://firebase.google.com/)

---

## What It Does

PRISM (Pulmonary Response and Inhaler System Monitor) is a smart inhaler monitoring platform for pressurised Metered-Dose Inhalers (pMDI). This is the **mobile application** component.

The app currently:

- **Simulates inhalation sessions** with realistic data matching the production schema — including drug detection, inhale duration, coordination delay, pre-exhale detection, and composite quality scoring
- **Displays session quality** using 5 clinical labels: `GOOD`, `POOR`, `GOOD_BUT_INCONSISTENT`, `ABNORMAL`, `MISSED_DOSE`
- **Shows detailed event classification** — drug duration, inhale duration, coordination delay, pre-exhale detection
- **Tracks baseline deviation** — deviation scores and flags (`within_baseline`, `mild_deviation`, `significant_deviation`)
- **Identifies technique issues** — insufficient inhalation, late actuation, missed dose, missing pre-exhale
- **Syncs to Firebase** — anonymous auth, Firestore persistence, auto-seed on first launch
- **Manages BLE device connections** (simulated) — connect/disconnect, battery monitoring, auto-reconnect

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React Native (Expo SDK 54) |
| Navigation | React Navigation 7 (bottom tabs + stack) |
| State | React Context API |
| Backend | Firebase (Firestore + Anonymous Auth) |
| Local Storage | AsyncStorage (device persistence) |
| BLE | Simulated (`bleService.js`) — designed for `react-native-ble-plx` swap |

---

## App Architecture

```
┌─────────────────────────────────────────────────────────┐
│  App.js                                                 │
│  ├── Anonymous Auth (Firebase)                          │
│  ├── Seed sample data if empty                          │
│  ├── Load sessions into context                         │
│  └── Auto-reconnect saved BLE device                    │
│                                                         │
│  AppContext (React Context)                              │
│  ├── sessions[]         ← Firestore read/write          │
│  ├── userId             ← Firebase Auth UID             │
│  └── device state       ← BLE connection status         │
│                                                         │
│  Screens                        Services                │
│  ├── DashboardScreen            ├── authService.js      │
│  ├── HistoryScreen              ├── sessionService.js   │
│  ├── SessionDetailScreen        ├── simulationService.js│
│  ├── DeviceScreen               ├── bleService.js       │
│  └── SettingsScreen             ├── deviceService.js    │
│                                 └── storageService.js   │
│  Components                     Utils                   │
│  ├── ResultBadge                ├── formatters.js       │
│  ├── SessionCard                └── theme.js            │
│  ├── IssueList                                          │
│  ├── StatusTag                                          │
│  └── ProgressBar                                        │
└─────────────────────────────────────────────────────────┘
```

### Data Flow

```
simulationService.js  ──generates──▶  Session Document
                                          │
                 sessionService.js  ◀─────┘
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
     Firestore              AppContext
  (persistent)           (in-memory state)
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         Dashboard       History        SessionDetail
```

---

## Firestore Session Schema

Every session document follows the PRISM schema (ARCHITECTURE.md §10):

```json
{
  "timestamp": "2026-09-30T14:30:00Z",
  "duration": 4.2,

  "event_classification": {
    "drug_detected": true,
    "drug_duration_ms": 280,
    "inhale_duration_ms": 2340,
    "coordination_delay_ms": 120,
    "pre_exhale_detected": true
  },

  "quality_assessment": {
    "composite_label": "GOOD",
    "deviation_score": 0.23,
    "deviation_flag": "within_baseline"
  },

  "technique_flags": {
    "insufficient_inhale": false,
    "late_actuation": false,
    "missed_dose": false
  },

  "source": "simulation",
  "status": "complete",
  "deviceId": null,
  "model_version": "cnn_v1.0",
  "app_version": "1.0.0"
}
```

### Firestore Collections

```
users/{uid}/sessions/{id}     ← one per inhalation event
users/{uid}/devices/{mac}     ← registered BLE devices
```

### Composite Quality Labels

| Label | Meaning |
|---|---|
| `GOOD` | Technique within population norms and personal baseline |
| `POOR` | Technique below acceptable quality |
| `GOOD_BUT_INCONSISTENT` | Good technique but deviates from personal baseline |
| `ABNORMAL` | Good technique but significant baseline shift (possible disease change) |
| `MISSED_DOSE` | No drug actuation detected |

---

## Setup & Run

### Prerequisites

- [Node.js](https://nodejs.org/) (18+)
- [Expo CLI](https://docs.expo.dev/get-started/installation/) (`npx expo` works without global install)
- A Firebase project (free Spark plan is fine)

### 1. Clone the Repo

```bash
git clone https://github.com/<your-username>/smart-inhaler-app.git
cd smart-inhaler-app
```

### 2. Configure Firebase

1. Go to the [Firebase Console](https://console.firebase.google.com/) and create a new project
2. Add a **Web App** to get your Firebase configuration object
3. Enable **Firestore Database** (Native mode)
4. Enable **Authentication** → Sign-in method → **Anonymous**
5. Copy the example config:
   ```bash
   cp firebase/example_config.js firebase/config.js
   ```
6. Paste your Firebase credentials into `firebase/config.js`:
   ```js
   export const firebaseConfig = {
     apiKey: "YOUR_API_KEY",
     authDomain: "YOUR_AUTH_DOMAIN",
     projectId: "YOUR_PROJECT_ID",
     storageBucket: "YOUR_STORAGE_BUCKET",
     messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
     appId: "YOUR_APP_ID",
     measurementId: "YOUR_MEASUREMENT_ID",
   };
   ```

> `firebase/config.js` is git-ignored to prevent leaking API keys.

### 3. Install Dependencies

```bash
npm install
```

### 4. Run the App

```bash
npx expo start
```

- Press `w` to open in the browser
- Press `a` to open in an Android Emulator
- Press `i` to open in an iOS Simulator
- Scan the QR code with the **Expo Go** app on your physical device

On first launch the app will auto-seed 8 sample sessions spanning the past 7 days.

---

## Project Structure

```
smart-inhaler-app/
├── App.js                     # Entry point — auth, seed, auto-reconnect
├── app.json                   # Expo configuration
├── package.json
│
├── context/
│   └── AppContext.js           # Global state (sessions, device, auth)
│
├── navigation/
│   └── AppNavigator.js         # Bottom tabs + stack navigator
│
├── screens/
│   ├── DashboardScreen.js      # Dose progress, last session summary, simulate button
│   ├── HistoryScreen.js        # Scrollable session list
│   ├── SessionDetailScreen.js  # Full session breakdown (quality, events, issues)
│   ├── DeviceScreen.js         # BLE connect/disconnect, battery, find inhaler
│   └── SettingsScreen.js       # App settings
│
├── components/
│   ├── ResultBadge.js          # Color-coded quality label pill
│   ├── SessionCard.js          # Compact session card for history list
│   ├── IssueList.js            # Technique issues derived from classification data
│   ├── StatusTag.js            # Source (SIM/BLE) and status (Interrupted) tags
│   └── ProgressBar.js          # Daily dose progress dots
│
├── services/
│   ├── authService.js          # Firebase anonymous authentication
│   ├── sessionService.js       # Firestore CRUD for sessions
│   ├── simulationService.js    # Mock session data (PRISM schema)
│   ├── bleService.js           # BLE device simulation
│   ├── deviceService.js        # Firestore CRUD for devices
│   └── storageService.js       # AsyncStorage for device persistence
│
├── utils/
│   ├── formatters.js           # Date, duration, score, label formatting
│   └── theme.js                # Design tokens (colors, spacing, shadows)
│
└── firebase/
    ├── example_config.js       # Template — copy to config.js
    ├── config.js               # Your credentials (git-ignored)
    └── firebaseConfig.js       # Firebase SDK initialization
```

---

## Future: On-Device ML Integration

The schema is already aligned for on-device ONNX Runtime inference. The planned integration:

```
ESP32 (INMP441 mic + BLE)
  ↓  raw PCM audio via Bluetooth Low Energy
React Native App
  ↓  Native C++ DSP → feature extraction (124-dim vectors)
  ↓  ONNX Runtime → inhaler_cnn.onnx (Drug/Inhale/Exhale/Noise classification)
  ↓  Session analytics → quality scoring → baseline comparison
  ↓  derived analytics only (no audio leaves device)
Firebase
  ↓
Doctor Dashboard
```

When the ML model is integrated, it will produce data in the exact same session schema the app already consumes — the UI requires zero changes.

---

*PRISM — Capstone Project 2026*
