/**
 * services/syncService.js
 *
 * Offline-first upload of the sessions stored on the phone (services/localSessionStore.js) to
 * Firestore.
 *
 * - saveSession(record) stores the session on the phone, then requests a sync. It never waits
 *   for Firestore: a session is visible and safe as soon as it is on the phone.
 * - The Firestore document ID is the session_id. A retry therefore overwrites the same document,
 *   so a write that reached the server but whose confirmation was lost cannot create a duplicate.
 * - One sync pass runs at a time. A request during a pass schedules one more pass afterwards.
 * - A session is marked synced only when the upload promise resolves: Firestore resolves a write
 *   only after the server has committed it. A failure or a missing confirmation leaves the session
 *   pending for the next pass.
 * - Firestore keeps an unconfirmed write in memory and sends it when the connection returns. If
 *   that confirmation arrives after a pass gave up waiting, the session is still marked synced
 *   and another pass starts for the rest of the queue.
 * - Sessions are on the phone before any upload starts, so closing the app during a sync loses
 *   nothing: the next pass finds them pending and uploads them again under the same ID.
 *
 * Passes are triggered by the app (after a save, at start-up, when the app returns to the
 * foreground, and by "Sync now"); no network detection is needed.
 *
 * Dependencies are injected so the logic runs in the Node tests (services/test_sessions.js):
 *   store                  createLocalSessionStore() instance
 *   uploadSession          (userId, record) => Promise, resolves once the server confirmed the write
 *   getUserId              () => Promise<string|null>, null when not signed in (offline, no Firebase)
 *   sessionExistsRemotely  optional (userId, sessionId) => Promise<boolean>, a server read used after
 *                          a rejected write (e.g. security rules that refuse overwriting a document
 *                          an earlier, unconfirmed attempt already created)
 */

import { isLegacyRecord } from "./sessionRecord.js";
import { SYNC_STATE } from "./localSessionStore.js";

const TIMEOUT = Symbol("timeout");

/** Resolve with the promise's value, or with `fallback` after `ms` (the promise keeps running). */
export function withTimeout(promise, ms, fallback = TIMEOUT) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const messageOf = (e) => (e?.code ? `${e.code}: ${e.message ?? ""}` : e?.message ?? String(e));

/** Outcome of the last pass, for the UI. */
export const SYNC_OUTCOME = Object.freeze({
  SYNCED: "synced", // every pending session was confirmed (or nothing was pending)
  PARTIAL: "partial", // some uploads failed; they stay pending
  NO_CONFIRMATION: "no_confirmation", // the server did not confirm in time (probably offline)
  NOT_SIGNED_IN: "not_signed_in", // no Firebase user: offline, or Firebase not configured
  ERROR: "error", // the local store could not be read
});

/**
 * @param {Object} deps - see the file header
 * @param {number} [deps.confirmTimeoutMs=20000] - how long a pass waits for one confirmation
 */
export function createSyncService({
  store,
  uploadSession,
  getUserId,
  sessionExistsRemotely = null,
  confirmTimeoutMs = 20000,
  now = () => new Date(),
  log = console,
}) {
  /** session_id → { promise, gaveUp }: uploads Firestore may still confirm. */
  const inflight = new Map();
  const listeners = new Set();
  let running = null;
  let rerun = false;
  let status = {
    running: false,
    pending: null,
    userId: null,
    lastOutcome: null,
    lastError: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
  };

  const iso = () => now().toISOString();
  const notify = () => {
    const snapshot = { ...status };
    for (const fn of listeners) {
      try {
        fn(snapshot);
      } catch (e) {
        log.warn?.("[syncService] listener failed:", e);
      }
    }
  };

  async function refreshPendingCount() {
    try {
      status.pending = (await store.listPending()).length;
    } catch {
      // the store error is reported by the pass itself
    }
  }

  /** Start (or join) the upload of one session. Always resolves with { kind, error? }. */
  function startUpload(userId, record) {
    const id = record.session_id;
    const existing = inflight.get(id);
    if (existing) return existing;

    const tracked = { gaveUp: false, promise: null };
    tracked.promise = (async () => {
      try {
        try {
          await uploadSession(userId, record);
        } catch (e) {
          // A rejected write may still have an earlier copy on the server (same document ID).
          let exists = false;
          if (sessionExistsRemotely) {
            try {
              exists = await sessionExistsRemotely(userId, id);
            } catch {
              exists = false;
            }
          }
          if (!exists) throw e;
        }
      } catch (e) {
        inflight.delete(id);
        await store.markFailed(id, messageOf(e), { at: iso() }).catch((err) => log.warn?.("[syncService]", err));
        return { kind: "failed", error: messageOf(e) };
      }
      inflight.delete(id);
      await store.markSynced(id, { userId, at: iso() }).catch((err) => log.warn?.("[syncService]", err));
      status.lastSuccessAt = iso();
      if (tracked.gaveUp) {
        // Confirmed after the pass stopped waiting: the connection is back, continue the queue.
        notify();
        requestSync("late confirmation");
      }
      return { kind: "synced" };
    })();
    inflight.set(id, tracked);
    return tracked;
  }

  async function pass() {
    status.lastAttemptAt = iso();
    let pending;
    try {
      pending = await store.listPending();
    } catch (e) {
      status.lastOutcome = SYNC_OUTCOME.ERROR;
      status.lastError = `local store unreadable: ${messageOf(e)}`;
      return;
    }
    status.pending = pending.length;

    let userId = null;
    try {
      userId = await getUserId();
    } catch {
      userId = null;
    }
    if (userId) status.userId = userId;
    if (pending.length === 0) {
      status.lastOutcome = SYNC_OUTCOME.SYNCED;
      status.lastError = null;
      return;
    }
    if (!userId) {
      status.lastOutcome = SYNC_OUTCOME.NOT_SIGNED_IN;
      status.lastError = null;
      return;
    }

    let failures = 0;
    let lastError = null;
    for (const entry of pending) {
      const id = entry.record.session_id;
      const tracked = startUpload(userId, entry.record);
      const result = await withTimeout(tracked.promise, confirmTimeoutMs);
      if (result === TIMEOUT) {
        // Probably offline. Firestore keeps the write and may still confirm it (handled in
        // startUpload); stop here instead of queueing every pending session in memory.
        tracked.gaveUp = true;
        await store.markFailed(id, `no server confirmation within ${Math.round(confirmTimeoutMs / 1000)} s`, { at: iso() })
          .catch((err) => log.warn?.("[syncService]", err));
        status.lastOutcome = SYNC_OUTCOME.NO_CONFIRMATION;
        status.lastError = null;
        return;
      }
      if (result.kind === "failed") {
        failures += 1;
        lastError = result.error;
      }
      notify();
    }
    status.lastOutcome = failures === 0 ? SYNC_OUTCOME.SYNCED : SYNC_OUTCOME.PARTIAL;
    status.lastError = lastError;
  }

  /**
   * Run a sync pass now, or join the one that is running (which then runs once more).
   * Never rejects.
   * @returns {Promise<Object>} the status after the pass(es)
   */
  function syncNow() {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      status.running = true;
      notify();
      try {
        do {
          rerun = false;
          await pass();
        } while (rerun);
      } catch (e) {
        status.lastOutcome = SYNC_OUTCOME.ERROR;
        status.lastError = messageOf(e);
        log.warn?.("[syncService] sync pass failed:", e);
      }
      await refreshPendingCount();
      status.running = false;
      running = null;
      notify();
      return { ...status };
    })();
    return running;
  }

  /** Fire-and-forget sync request. */
  function requestSync(reason = "request") { // eslint-disable-line no-unused-vars
    syncNow();
  }

  return {
    /**
     * Store a session on the phone, then request an upload in the background.
     * Resolves as soon as the session is stored; it does not wait for Firestore.
     * @param {Object} record - services/sessionRecord.buildSessionRecord() result
     * @returns {Promise<Object>} the stored entry
     */
    async saveSession(record) {
      const entry = await store.saveSession(record);
      await refreshPendingCount();
      notify();
      requestSync("saved");
      return entry;
    },
    syncNow,
    requestSync,
    getStatus: () => ({ ...status }),
    /** @returns {() => void} unsubscribe */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// ─── Local + remote history ──────────────────────────────────────────────────

const timeOf = (item) => {
  const t = item.timestamp instanceof Date ? item.timestamp.getTime() : Date.parse(item.timestamp);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * One history list from the sessions on the phone and the documents in Firestore, without
 * duplicates. A session is identified by its session_id (documents of the legacy schemas, which
 * have none, by their document ID). The phone's copy wins, because it carries the sync state.
 * Each item is the record plus { id, legacy, timestamp, sync, origin }.
 *
 * @param {Object[]} localEntries - localSessionStore entries
 * @param {Object[]} [remoteSessions] - sessionService.getSessions() items ({ id, ...data, legacy, timestamp })
 * @returns {Object[]} newest first
 */
export function mergeSessionLists(localEntries, remoteSessions = []) {
  const items = [];
  const seen = new Set();
  for (const entry of localEntries) {
    const id = entry.record.session_id;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      ...entry.record,
      id,
      legacy: isLegacyRecord(entry.record),
      timestamp: new Date(entry.saved_at),
      sync: { ...entry.sync },
      origin: "local",
    });
  }
  for (const doc of remoteSessions) {
    const legacy = doc.legacy ?? isLegacyRecord(doc);
    const id = !legacy && typeof doc.session_id === "string" ? doc.session_id : doc.id;
    const key = legacy ? `doc:${doc.id}` : id;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ ...doc, id, legacy, sync: { state: SYNC_STATE.SYNCED }, origin: "remote" });
  }
  return items.sort((a, b) => timeOf(b) - timeOf(a));
}
