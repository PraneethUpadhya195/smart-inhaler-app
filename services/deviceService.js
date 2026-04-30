import { doc, setDoc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase/firebaseConfig";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deviceDocRef(userId, deviceId) {
  return doc(db, "users", userId, "devices", deviceId);
}

// ─── Operations ───────────────────────────────────────────────────────────────

/**
 * Creates or updates a device document under the user's devices subcollection.
 * @param {string} userId
 * @param {{ deviceId: string, name: string }} deviceData
 */
export async function saveDevice(userId, deviceData) {
  const { deviceId, name } = deviceData;
  await setDoc(
    deviceDocRef(userId, deviceId),
    {
      name,
      lastConnected: serverTimestamp(),
      isActive: true,
    },
    { merge: true }
  );
}

/**
 * Fetches a single device document.
 * Used to validate an AsyncStorage-cached deviceId against Firestore.
 *
 * @param {string} userId
 * @param {string} deviceId
 * @returns {Promise<Object|null>} device data or null if not found
 */
export async function getDevice(userId, deviceId) {
  const snap = await getDoc(deviceDocRef(userId, deviceId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

/**
 * Updates lastConnected timestamp and marks device as active.
 * @param {string} userId
 * @param {string} deviceId
 */
export async function updateLastConnected(userId, deviceId) {
  await updateDoc(deviceDocRef(userId, deviceId), {
    lastConnected: serverTimestamp(),
    isActive: true,
  });
}

/**
 * Marks a device as inactive (on disconnect).
 * @param {string} userId
 * @param {string} deviceId
 */
export async function markDeviceInactive(userId, deviceId) {
  await updateDoc(deviceDocRef(userId, deviceId), {
    isActive: false,
  });
}
