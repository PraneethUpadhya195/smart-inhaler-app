/**
 * simulationService.js
 *
 * Generates realistic mock inhalation session data aligned with the
 * PRISM session document schema (ARCHITECTURE.md §10).
 *
 * Source is always "simulation" — deviceId is null.
 * Replace or extend this service when integrating real ONNX model outputs.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

// ─── Composite Quality Logic (ARCHITECTURE.md §9) ────────────────────────────
//
// Global      ×  Baseline             → Composite
// GOOD           within_baseline      → GOOD
// GOOD           mild_deviation       → GOOD_BUT_INCONSISTENT
// GOOD           significant_deviation→ ABNORMAL
// POOR           any                  → POOR
// (drug missing)                      → MISSED_DOSE

const COMPOSITE_LABELS = ["GOOD", "POOR", "GOOD_BUT_INCONSISTENT", "ABNORMAL", "MISSED_DOSE"];
const DEVIATION_FLAGS = ["within_baseline", "mild_deviation", "significant_deviation"];

/**
 * Generates a single mock inhalation session matching the PRISM schema.
 * @returns {Object} session data (without Firestore ID)
 */
export function generateMockSession() {
  // Decide the scenario first so all fields are internally consistent
  const scenario = pick(["good", "good", "good", "poor", "poor", "inconsistent", "abnormal", "missed"]);

  let event_classification;
  let quality_assessment;
  let technique_flags;

  switch (scenario) {
    case "good": {
      const inhale_dur = randInt(1800, 3500);
      const drug_dur = randInt(240, 360);
      const coord_delay = randInt(30, 200);
      event_classification = {
        drug_detected: true,
        drug_duration_ms: drug_dur,
        inhale_duration_ms: inhale_dur,
        coordination_delay_ms: coord_delay,
        pre_exhale_detected: Math.random() > 0.3,
      };
      const deviation_flag = "within_baseline";
      quality_assessment = {
        composite_label: "GOOD",
        deviation_score: parseFloat(rand(0.0, 1.4).toFixed(2)),
        deviation_flag,
      };
      technique_flags = {
        insufficient_inhale: false,
        late_actuation: false,
        missed_dose: false,
      };
      break;
    }

    case "poor": {
      const inhale_dur = randInt(400, 900);
      const drug_dur = randInt(200, 340);
      const coord_delay = randInt(300, 800);
      const insufficient = inhale_dur < 1000;
      const late = coord_delay > 500;
      event_classification = {
        drug_detected: true,
        drug_duration_ms: drug_dur,
        inhale_duration_ms: inhale_dur,
        coordination_delay_ms: coord_delay,
        pre_exhale_detected: Math.random() > 0.7,
      };
      quality_assessment = {
        composite_label: "POOR",
        deviation_score: parseFloat(rand(1.0, 4.0).toFixed(2)),
        deviation_flag: pick(DEVIATION_FLAGS),
      };
      technique_flags = {
        insufficient_inhale: insufficient,
        late_actuation: late,
        missed_dose: false,
      };
      break;
    }

    case "inconsistent": {
      const inhale_dur = randInt(1500, 2800);
      const drug_dur = randInt(250, 350);
      const coord_delay = randInt(80, 300);
      event_classification = {
        drug_detected: true,
        drug_duration_ms: drug_dur,
        inhale_duration_ms: inhale_dur,
        coordination_delay_ms: coord_delay,
        pre_exhale_detected: true,
      };
      quality_assessment = {
        composite_label: "GOOD_BUT_INCONSISTENT",
        deviation_score: parseFloat(rand(1.5, 2.9).toFixed(2)),
        deviation_flag: "mild_deviation",
      };
      technique_flags = {
        insufficient_inhale: false,
        late_actuation: false,
        missed_dose: false,
      };
      break;
    }

    case "abnormal": {
      const inhale_dur = randInt(2000, 3200);
      const drug_dur = randInt(250, 350);
      const coord_delay = randInt(50, 200);
      event_classification = {
        drug_detected: true,
        drug_duration_ms: drug_dur,
        inhale_duration_ms: inhale_dur,
        coordination_delay_ms: coord_delay,
        pre_exhale_detected: true,
      };
      quality_assessment = {
        composite_label: "ABNORMAL",
        deviation_score: parseFloat(rand(3.0, 5.5).toFixed(2)),
        deviation_flag: "significant_deviation",
      };
      technique_flags = {
        insufficient_inhale: false,
        late_actuation: false,
        missed_dose: false,
      };
      break;
    }

    case "missed":
    default: {
      event_classification = {
        drug_detected: false,
        drug_duration_ms: 0,
        inhale_duration_ms: 0,
        coordination_delay_ms: 0,
        pre_exhale_detected: false,
      };
      quality_assessment = {
        composite_label: "MISSED_DOSE",
        deviation_score: 0,
        deviation_flag: null,
      };
      technique_flags = {
        insufficient_inhale: false,
        late_actuation: false,
        missed_dose: true,
      };
      break;
    }
  }

  // Total session duration from inhale + actuation time, in seconds
  const duration = parseFloat(
    ((event_classification.inhale_duration_ms + event_classification.drug_duration_ms) / 1000).toFixed(1)
  );

  return {
    timestamp: new Date(),
    duration,
    event_classification,
    quality_assessment,
    technique_flags,
    source: "simulation",
    status: "complete",
    deviceId: null,
    model_version: "cnn_v1.0",
    app_version: "1.0.0",
  };
}

/**
 * Returns sample seed sessions for when Firestore is empty.
 * Timestamps are spread across the past 7 days.
 * All sessions use the real PRISM schema.
 */
export function generateSeedSessions() {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  return [
    {
      timestamp: new Date(now - 7 * day),
      duration: 4.2,
      event_classification: {
        drug_detected: true, drug_duration_ms: 280, inhale_duration_ms: 2340,
        coordination_delay_ms: 120, pre_exhale_detected: true,
      },
      quality_assessment: {
        composite_label: "GOOD",
        deviation_score: 0.23, deviation_flag: "within_baseline",
      },
      technique_flags: { insufficient_inhale: false, late_actuation: false, missed_dose: false },
      source: "simulation", status: "complete", deviceId: null,
      model_version: "cnn_v1.0", app_version: "1.0.0",
    },
    {
      timestamp: new Date(now - 6 * day),
      duration: 2.1,
      event_classification: {
        drug_detected: true, drug_duration_ms: 260, inhale_duration_ms: 780,
        coordination_delay_ms: 620, pre_exhale_detected: false,
      },
      quality_assessment: {
        composite_label: "POOR",
        deviation_score: 3.1, deviation_flag: "significant_deviation",
      },
      technique_flags: { insufficient_inhale: true, late_actuation: true, missed_dose: false },
      source: "simulation", status: "complete", deviceId: null,
      model_version: "cnn_v1.0", app_version: "1.0.0",
    },
    {
      timestamp: new Date(now - 5 * day),
      duration: 5.8,
      event_classification: {
        drug_detected: true, drug_duration_ms: 310, inhale_duration_ms: 3100,
        coordination_delay_ms: 90, pre_exhale_detected: true,
      },
      quality_assessment: {
        composite_label: "GOOD",
        deviation_score: 0.45, deviation_flag: "within_baseline",
      },
      technique_flags: { insufficient_inhale: false, late_actuation: false, missed_dose: false },
      source: "simulation", status: "complete", deviceId: null,
      model_version: "cnn_v1.0", app_version: "1.0.0",
    },
    {
      timestamp: new Date(now - 4 * day),
      duration: 3.3,
      event_classification: {
        drug_detected: true, drug_duration_ms: 290, inhale_duration_ms: 2100,
        coordination_delay_ms: 180, pre_exhale_detected: true,
      },
      quality_assessment: {
        composite_label: "GOOD_BUT_INCONSISTENT",
        deviation_score: 2.1, deviation_flag: "mild_deviation",
      },
      technique_flags: { insufficient_inhale: false, late_actuation: false, missed_dose: false },
      source: "simulation", status: "complete", deviceId: null,
      model_version: "cnn_v1.0", app_version: "1.0.0",
    },
    {
      timestamp: new Date(now - 3 * day),
      duration: 6.0,
      event_classification: {
        drug_detected: true, drug_duration_ms: 330, inhale_duration_ms: 2800,
        coordination_delay_ms: 70, pre_exhale_detected: true,
      },
      quality_assessment: {
        composite_label: "GOOD",
        deviation_score: 0.31, deviation_flag: "within_baseline",
      },
      technique_flags: { insufficient_inhale: false, late_actuation: false, missed_dose: false },
      source: "simulation", status: "complete", deviceId: null,
      model_version: "cnn_v1.0", app_version: "1.0.0",
    },
    {
      timestamp: new Date(now - 2 * day),
      duration: 0,
      event_classification: {
        drug_detected: false, drug_duration_ms: 0, inhale_duration_ms: 0,
        coordination_delay_ms: 0, pre_exhale_detected: false,
      },
      quality_assessment: {
        composite_label: "MISSED_DOSE",
        deviation_score: 0, deviation_flag: null,
      },
      technique_flags: { insufficient_inhale: false, late_actuation: false, missed_dose: true },
      source: "simulation", status: "complete", deviceId: null,
      model_version: "cnn_v1.0", app_version: "1.0.0",
    },
    {
      timestamp: new Date(now - 1 * day),
      duration: 5.1,
      event_classification: {
        drug_detected: true, drug_duration_ms: 300, inhale_duration_ms: 2600,
        coordination_delay_ms: 150, pre_exhale_detected: true,
      },
      quality_assessment: {
        composite_label: "ABNORMAL",
        deviation_score: 3.8, deviation_flag: "significant_deviation",
      },
      technique_flags: { insufficient_inhale: false, late_actuation: false, missed_dose: false },
      source: "simulation", status: "complete", deviceId: null,
      model_version: "cnn_v1.0", app_version: "1.0.0",
    },
    {
      timestamp: new Date(now - 2 * 60 * 60 * 1000),
      duration: 4.7,
      event_classification: {
        drug_detected: true, drug_duration_ms: 290, inhale_duration_ms: 2450,
        coordination_delay_ms: 110, pre_exhale_detected: true,
      },
      quality_assessment: {
        composite_label: "GOOD",
        deviation_score: 0.67, deviation_flag: "within_baseline",
      },
      technique_flags: { insufficient_inhale: false, late_actuation: false, missed_dose: false },
      source: "simulation", status: "complete", deviceId: null,
      model_version: "cnn_v1.0", app_version: "1.0.0",
    },
  ];
}
