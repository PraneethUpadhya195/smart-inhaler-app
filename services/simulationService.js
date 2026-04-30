/**
 * simulationService.js
 *
 * Generates realistic mock inhalation session data.
 * Source is always "simulation" — deviceId is null.
 *
 * Replace or extend this service when integrating real ML model outputs.
 */

const POSSIBLE_ERRORS = ["too_fast", "too_short", "incomplete_breath", "irregular_flow"];

function pickRandom(arr, count) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

/**
 * Generates a single mock inhalation session.
 * @returns {Object} session data (without Firestore ID)
 */
export function generateMockSession() {
  const duration = parseFloat((Math.random() * 6 + 2).toFixed(1)); // 2.0 – 8.0 seconds
  const quality = Math.floor(Math.random() * 101); // 0 – 100

  const errorCount = quality >= 70 ? 0 : quality >= 40 ? 1 : 2;
  const errors = pickRandom(POSSIBLE_ERRORS, errorCount);

  const label = quality >= 60 ? "Correct" : "Incorrect";

  return {
    timestamp: new Date(),
    duration,
    quality,
    errors,
    label,
    source: "simulation",
    status: "complete",
    deviceId: null,
  };
}

/**
 * Returns sample seed sessions for when Firestore is empty.
 * Timestamps are spread across the past 7 days.
 */
export function generateSeedSessions() {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  return [
    { timestamp: new Date(now - 7 * day), duration: 4.2, quality: 82, errors: [], label: "Correct", source: "simulation", status: "complete", deviceId: null },
    { timestamp: new Date(now - 6 * day), duration: 2.1, quality: 35, errors: ["too_short", "too_fast"], label: "Incorrect", source: "simulation", status: "complete", deviceId: null },
    { timestamp: new Date(now - 5 * day), duration: 5.8, quality: 91, errors: [], label: "Correct", source: "simulation", status: "complete", deviceId: null },
    { timestamp: new Date(now - 4 * day), duration: 3.3, quality: 55, errors: ["incomplete_breath"], label: "Incorrect", source: "simulation", status: "complete", deviceId: null },
    { timestamp: new Date(now - 3 * day), duration: 6.0, quality: 78, errors: [], label: "Correct", source: "simulation", status: "complete", deviceId: null },
    { timestamp: new Date(now - 2 * day), duration: 2.9, quality: 48, errors: ["too_fast"], label: "Incorrect", source: "simulation", status: "interrupted", deviceId: null },
    { timestamp: new Date(now - 1 * day), duration: 5.1, quality: 88, errors: [], label: "Correct", source: "simulation", status: "complete", deviceId: null },
    { timestamp: new Date(now - 2 * 60 * 60 * 1000), duration: 4.7, quality: 74, errors: [], label: "Correct", source: "simulation", status: "complete", deviceId: null },
  ];
}
