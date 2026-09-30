import {
  collection,
  addDoc,
  getDocs,
  doc,
  updateDoc,
  query,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../firebase/firebaseConfig";
import { generateSeedSessions } from "./simulationService";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sessionsRef(userId) {
  return collection(db, "users", userId, "sessions");
}

function sessionDocRef(userId, sessionId) {
  return doc(db, "users", userId, "sessions", sessionId);
}

// ─── Read ──────────────────────────────────────────────────────────────────────

/**
 * Fetches all sessions for a user ordered by timestamp desc.
 * Excludes "in_progress" sessions from the visible history.
 *
 * @param {string} userId
 * @returns {Promise<Array>} array of session objects with id
 */
export async function getSessions(userId) {
  const q = query(sessionsRef(userId), orderBy("timestamp", "desc"));
  const snapshot = await getDocs(q);

  return snapshot.docs
    .map((d) => ({
      id: d.id,
      ...d.data(),
      // Convert Firestore Timestamp → JS Date for consistent handling in UI
      timestamp: d.data().timestamp?.toDate ? d.data().timestamp.toDate() : new Date(d.data().timestamp),
    }))
    .filter((s) => s.status !== "in_progress");
}

// ─── Write (Simulation) ────────────────────────────────────────────────────────

/**
 * Adds a complete simulation session to Firestore.
 * @param {string} userId
 * @param {Object} sessionData — from simulationService.generateMockSession()
 * @returns {Promise<string>} new session document ID
 */
export async function addSession(userId, sessionData) {
  const ref = await addDoc(sessionsRef(userId), {
    ...sessionData,
    timestamp: serverTimestamp(),
  });
  return ref.id;
}

// ─── Write (BLE) ───────────────────────────────────────────────────────────────

/**
 * Creates a BLE session doc with status "in_progress" at session start.
 * @param {string} userId
 * @param {string} deviceId
 * @returns {Promise<string>} sessionId to pass to completeBleSession / interruptBleSession
 */
export async function startBleSession(userId, deviceId) {
  const ref = await addDoc(sessionsRef(userId), {
    timestamp: serverTimestamp(),
    duration: null,
    event_classification: null,
    quality_assessment: null,
    technique_flags: null,
    source: "ble",
    status: "in_progress",
    deviceId,
  });
  return ref.id;
}

/**
 * Updates a BLE session to "complete" with full inhalation data.
 * @param {string} userId
 * @param {string} sessionId
 * @param {Object} data — { duration, quality, errors, label }
 */
export async function completeBleSession(userId, sessionId, data) {
  await updateDoc(sessionDocRef(userId, sessionId), {
    ...data,
    status: "complete",
  });
}

/**
 * Marks a BLE session as "interrupted" when device disconnects mid-session.
 * Saves whatever partial data is available.
 * @param {string} userId
 * @param {string} sessionId
 * @param {Object} partialData — whatever data was collected before disconnect
 */
export async function interruptBleSession(userId, sessionId, partialData = {}) {
  await updateDoc(sessionDocRef(userId, sessionId), {
    ...partialData,
    status: "interrupted",
  });
}

// ─── Seed ──────────────────────────────────────────────────────────────────────

/**
 * Seeds sample sessions if the user's sessions collection is empty.
 * @param {string} userId
 */
export async function seedSampleData(userId) {
  const snapshot = await getDocs(sessionsRef(userId));
  if (!snapshot.empty) return;

  const seeds = generateSeedSessions();
  await Promise.all(seeds.map((s) => addDoc(sessionsRef(userId), s)));
}
