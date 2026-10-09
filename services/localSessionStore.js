/**
 * services/localSessionStore.js
 *
 * Sessions stored on the phone (offline-first). One storage key per session:
 *
 *   "@PRISM:session:<session_id>" → JSON envelope
 *   {
 *     format:   "prism-local-session-v1",
 *     saved_at: ISO time the session was stored on this phone,
 *     record:   the session record exactly as built by buildSessionRecord (never modified here),
 *     sync:     { state: "pending" | "synced", attempts, last_attempt_at, last_error,
 *                 synced_at, synced_user_id }
 *   }
 *
 * The record (contract outputs + app metadata) and the synchronization state are kept apart:
 * sync bookkeeping only ever rewrites `sync`, and `record` is what gets uploaded.
 *
 * `storage` is injected: the app passes AsyncStorage (services/appServices.js), the Node tests an
 * in-memory object with the same methods (getItem, setItem, getAllKeys, multiGet).
 * Unreadable entries are skipped and reported, never overwritten or deleted.
 */

import { assertFirestoreSafe, isValidSessionId } from "./sessionRecord.js";

export const SESSION_KEY_PREFIX = "@PRISM:session:";
export const LOCAL_SESSION_FORMAT = "prism-local-session-v1";
export const SYNC_STATE = Object.freeze({ PENDING: "pending", SYNCED: "synced" });

export class LocalStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalStoreError";
  }
}

const keyFor = (sessionId) => `${SESSION_KEY_PREFIX}${sessionId}`;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Parse one stored value. Returns { entry } or { reason } (corrupt or foreign data).
 * @param {string} key
 * @param {string|null} raw
 */
function parseEntry(key, raw) {
  if (raw == null) return { reason: "missing" };
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { reason: "not valid JSON" };
  }
  if (!isObject(value) || value.format !== LOCAL_SESSION_FORMAT) return { reason: "unknown format" };
  if (!isObject(value.record) || !isValidSessionId(value.record.session_id)) return { reason: "no valid session record" };
  if (keyFor(value.record.session_id) !== key) return { reason: "session_id does not match the storage key" };
  if (!isObject(value.sync) || !Object.values(SYNC_STATE).includes(value.sync.state)) return { reason: "invalid sync state" };
  if (typeof value.saved_at !== "string" || Number.isNaN(Date.parse(value.saved_at))) return { reason: "invalid saved_at" };
  return { entry: value };
}

/**
 * @param {{ getItem: Function, setItem: Function, getAllKeys: Function, multiGet: Function }} storage
 * @param {Object} [options]
 * @param {() => Date} [options.now]
 * @param {{ warn: Function }} [options.log]
 */
export function createLocalSessionStore(storage, { now = () => new Date(), log = console } = {}) {
  // Writes run one after another, in the order they were requested, so a late sync result can
  // never be overtaken by an older one.
  let writeChain = Promise.resolve();
  const serialized = (fn) => {
    const result = writeChain.then(fn);
    writeChain = result.catch(() => {});
    return result;
  };

  async function read(sessionId) {
    const key = keyFor(sessionId);
    return parseEntry(key, await storage.getItem(key));
  }

  async function updateSync(sessionId, update) {
    return serialized(async () => {
      const { entry, reason } = await read(sessionId);
      if (!entry) {
        log.warn?.(`[localSessionStore] sync state of ${sessionId} not updated: ${reason}`);
        return null;
      }
      const sync = update({ ...entry.sync });
      if (!sync) return entry;
      const next = { ...entry, sync };
      await storage.setItem(keyFor(sessionId), JSON.stringify(next));
      return next;
    });
  }

  /**
   * Every readable stored session, newest first, plus the keys that could not be read.
   * @returns {Promise<{ entries: Object[], corrupt: { key: string, reason: string }[] }>}
   */
  async function listSessions() {
    const keys = (await storage.getAllKeys()).filter((k) => k.startsWith(SESSION_KEY_PREFIX));
    const pairs = keys.length > 0 ? await storage.multiGet(keys) : [];
    const entries = [];
    const corrupt = [];
    for (const [key, raw] of pairs) {
      const { entry, reason } = parseEntry(key, raw);
      if (entry) entries.push(entry);
      else corrupt.push({ key, reason });
    }
    if (corrupt.length > 0) log.warn?.(`[localSessionStore] skipped ${corrupt.length} unreadable entr${corrupt.length === 1 ? "y" : "ies"}`);
    entries.sort((a, b) => (Date.parse(b.saved_at) - Date.parse(a.saved_at))
      || b.record.session_id.localeCompare(a.record.session_id));
    return { entries, corrupt };
  }

  return {
    /**
     * Store a new session (state "pending"). Saving the identical record again is a no-op;
     * a different record under an existing session_id is refused.
     * @param {Object} record - services/sessionRecord.buildSessionRecord() result
     * @returns {Promise<Object>} the stored entry
     */
    saveSession(record) {
      return serialized(async () => {
        if (!isObject(record) || !isValidSessionId(record.session_id)) {
          throw new LocalStoreError("a session record needs a valid session_id");
        }
        assertFirestoreSafe(record);
        const json = JSON.stringify(record);
        const existing = await read(record.session_id);
        if (existing.entry) {
          if (JSON.stringify(existing.entry.record) === json) return existing.entry;
          throw new LocalStoreError(`a different session ${record.session_id} is already stored`);
        }
        if (existing.reason !== "missing") {
          throw new LocalStoreError(`storage key of ${record.session_id} holds unreadable data (${existing.reason})`);
        }
        const entry = {
          format: LOCAL_SESSION_FORMAT,
          saved_at: now().toISOString(),
          record: JSON.parse(json),
          sync: {
            state: SYNC_STATE.PENDING,
            attempts: 0,
            last_attempt_at: null,
            last_error: null,
            synced_at: null,
            synced_user_id: null,
          },
        };
        await storage.setItem(keyFor(record.session_id), JSON.stringify(entry));
        return entry;
      });
    },

    /** @returns {Promise<Object|null>} the entry, or null when missing or unreadable */
    async getSession(sessionId) {
      if (!isValidSessionId(sessionId)) return null;
      const { entry, reason } = await read(sessionId);
      if (!entry && reason !== "missing") log.warn?.(`[localSessionStore] ${sessionId} unreadable: ${reason}`);
      return entry ?? null;
    },

    listSessions,

    /** @returns {Promise<Object[]>} sessions not yet confirmed by the server, oldest first */
    async listPending() {
      const { entries } = await listSessions();
      return entries.filter((e) => e.sync.state === SYNC_STATE.PENDING).reverse();
    },

    /** The server confirmed the upload. */
    markSynced(sessionId, { userId = null, at = now().toISOString() } = {}) {
      return updateSync(sessionId, (sync) => ({
        ...sync,
        state: SYNC_STATE.SYNCED,
        attempts: (sync.attempts ?? 0) + 1,
        last_attempt_at: at,
        last_error: null,
        synced_at: at,
        synced_user_id: userId,
      }));
    },

    /** An upload failed or was not confirmed; the session stays pending (a synced one stays synced). */
    markFailed(sessionId, message, { at = now().toISOString() } = {}) {
      return updateSync(sessionId, (sync) => (sync.state === SYNC_STATE.SYNCED ? null : {
        ...sync,
        state: SYNC_STATE.PENDING,
        attempts: (sync.attempts ?? 0) + 1,
        last_attempt_at: at,
        last_error: String(message),
      }));
    },
  };
}
