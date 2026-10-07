/**
 * services/sessionRecord.js
 *
 * The persisted session document (users/{uid}/sessions/{id}) and its Firestore safety check.
 * Pure functions (no Firebase import), so they are testable in Node.
 *
 * A session record is the SessionAggregator session (canonical contract outputs kept verbatim
 * under `recordings`) plus app metadata. It carries no derived quality, technique or clinical
 * field. A received recording is not evidence that a dose was taken.
 */

import { assertPlainJson } from "../pipeline/contract.js";
import { CURRENT_VERSIONS } from "../pipeline/versions.js";

export const SESSION_RECORD_SCHEMA = "prism-app-session-v1";

/** Where the audio came from. 'ble' is reserved: no BLE audio source exists yet. */
export const SESSION_SOURCES = Object.freeze(["simulation", "wav", "ble"]);

/**
 * @param {Object} session - SessionAggregator.aggregate() result
 * @param {Object} meta
 * @param {'simulation'|'wav'|'ble'} meta.source
 * @param {boolean} meta.simulated - true when the audio is synthetic (not a recording)
 * @param {string|null} [meta.deviceId]
 * @param {string|null} [meta.note] - shown with the session, e.g. why it is simulated
 * @returns {Object} plain JSON record
 */
export function buildSessionRecord(session, { source, simulated, deviceId = null, note = null }) {
  if (!SESSION_SOURCES.includes(source)) throw new Error(`unknown session source ${source}`);
  if (typeof simulated !== "boolean") throw new Error("simulated must be true or false");
  const record = {
    schema: SESSION_RECORD_SCHEMA,
    source,
    simulated,
    note,
    device_id: deviceId,
    app_version: CURRENT_VERSIONS.appVersion,
    ...session,
  };
  assertFirestoreSafe(record);
  return record;
}

/**
 * Throw unless `value` can be written to Firestore unchanged: plain JSON (no undefined,
 * NaN/Infinity, typed arrays, Dates or class instances) and no array directly inside an array
 * (Firestore rejects nested arrays).
 * @param {*} value
 * @param {string} [path]
 */
export function assertFirestoreSafe(value, path = "session") {
  assertPlainJson(value, path);
  const walk = (v, p, parentIsArray) => {
    if (Array.isArray(v)) {
      if (parentIsArray) throw new Error(`${p} is an array inside an array (not storable in Firestore)`);
      v.forEach((item, i) => walk(item, `${p}[${i}]`, true));
    } else if (v !== null && typeof v === "object") {
      for (const [k, item] of Object.entries(v)) walk(item, `${p}.${k}`, false);
    }
  };
  walk(value, path, false);
}

/** True for documents written by an earlier app version (legacy schemas). */
export function isLegacyRecord(doc) {
  return doc?.schema !== SESSION_RECORD_SCHEMA;
}
