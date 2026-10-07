import {
  collection,
  addDoc,
  getDocs,
  query,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../firebase/firebaseConfig";
import { assertFirestoreSafe, isLegacyRecord } from "./sessionRecord";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sessionsRef(userId) {
  return collection(db, "users", userId, "sessions");
}

// ─── Read ──────────────────────────────────────────────────────────────────────

/**
 * Fetches all sessions for a user ordered by timestamp desc.
 * Excludes "in_progress" sessions from the visible history.
 *
 * Documents written by earlier app versions (GOOD/POOR schema, camelCase pipeline schema) are
 * returned with `legacy: true` and are not interpreted by the UI. They are not deleted.
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
      legacy: isLegacyRecord(d.data()),
      // Convert Firestore Timestamp → JS Date for consistent handling in UI
      timestamp: d.data().timestamp?.toDate ? d.data().timestamp.toDate() : new Date(d.data().timestamp),
    }))
    .filter((s) => s.status !== "in_progress");
}

// ─── Write ─────────────────────────────────────────────────────────────────────

/**
 * Stores one session record (services/sessionRecord.buildSessionRecord): the canonical contract
 * outputs plus app metadata. `timestamp` is the time the record was stored (server time);
 * the recording's own start time is `recorded_at`.
 *
 * @param {string} userId
 * @param {Object} sessionData — a session record, e.g. from simulationService.runSimulatedSession()
 * @returns {Promise<string>} new session document ID
 * @throws if the record is not plain JSON that Firestore can store unchanged
 */
export async function addSession(userId, sessionData) {
  assertFirestoreSafe(sessionData);
  const ref = await addDoc(sessionsRef(userId), {
    ...sessionData,
    timestamp: serverTimestamp(),
  });
  return ref.id;
}

// There is no first-launch seeding: a new user starts with an empty history (F4).
// There are no BLE session writers: no BLE audio source exists yet (F11). A future BLE path
// will deliver PCM to the same pipeline and store its result with addSession().
