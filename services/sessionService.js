import {
  collection,
  doc,
  getDocFromServer,
  getDocs,
  query,
  orderBy,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db, firebaseInitError } from "../firebase/firebaseConfig";
import { assertFirestoreSafe, isLegacyRecord, isValidSessionId } from "./sessionRecord";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sessionsRef(userId) {
  if (!db) throw firebaseInitError ?? new Error("Firebase is not configured");
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

/**
 * True when the server (not the local cache) holds the session document.
 * Used after a rejected upload: an earlier attempt may have been committed without its
 * confirmation reaching the app.
 * @param {string} userId
 * @param {string} sessionId
 * @returns {Promise<boolean>}
 */
export async function sessionExistsRemotely(userId, sessionId) {
  const snap = await getDocFromServer(doc(sessionsRef(userId), sessionId));
  return snap.exists() && snap.data()?.session_id === sessionId;
}

// ─── Write ─────────────────────────────────────────────────────────────────────

/**
 * Stores one session record (services/sessionRecord.buildSessionRecord): the canonical contract
 * outputs plus app metadata. `timestamp` is the time the record was stored (server time);
 * the recording's own start time is `recorded_at`.
 *
 * The document ID is the record's session_id, so writing the same session again (a retry after
 * a lost confirmation) replaces the same document instead of creating a duplicate.
 * The promise resolves only when the server has confirmed the write (never while offline);
 * services/syncService.js calls this in the background, never on the UI path.
 *
 * @param {string} userId
 * @param {Object} sessionData — a session record, e.g. from simulationService.runSimulatedSession()
 * @returns {Promise<string>} the session document ID (= session_id)
 * @throws if the record is not plain JSON that Firestore can store unchanged, or has no valid session_id
 */
export async function addSession(userId, sessionData) {
  assertFirestoreSafe(sessionData);
  const sessionId = sessionData.session_id;
  if (!isValidSessionId(sessionId)) throw new Error(`invalid session_id ${JSON.stringify(sessionId)}`);
  await setDoc(doc(sessionsRef(userId), sessionId), {
    ...sessionData,
    timestamp: serverTimestamp(),
  });
  return sessionId;
}

// There is no first-launch seeding: a new user starts with an empty history (F4).
// There are no BLE session writers: no BLE audio source exists yet (F11). A future BLE path
// will deliver PCM to the same pipeline and store its result through services/syncService.
