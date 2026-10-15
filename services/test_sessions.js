/**
 * services/test_sessions.js — offline-first session storage and Firestore synchronization.
 *
 * Runs the real services/localSessionStore.js and services/syncService.js against in-memory
 * stand-ins for AsyncStorage and for the Firestore upload (the app wires them to AsyncStorage and
 * Firestore in services/appServices.js). Session records are built from the golden contract
 * outputs (assets/ml/v2_validation/golden/expected/) with the app's own SessionAggregator and
 * buildSessionRecord. The last section loads services/sessionService.js and services/authService.js
 * with fake `firebase/*` modules (node:module registerHooks) to check the actual Firestore calls.
 * Test 15 runs a bundled demo recording (services/demoSession.js) through the Node pipeline and
 * the same store and sync path.
 *
 * Run: node services/test_sessions.js   (part of npm test)
 */
import fs from "node:fs";
import * as nodeModule from "node:module";
import { createHash } from "node:crypto";

import SessionAggregator from "../pipeline/SessionAggregator.js";
// Loaded before the fake-firebase resolve hook below is registered (it rewrites relative imports).
import { createNodePipeline } from "../pipeline/runtime/node.js";
import WavPcmSource from "../pipeline/sources/WavPcmSource.js";
import * as demo from "./demoSession.js";
import { buildSessionRecord, assertFirestoreSafe } from "./sessionRecord.js";
import { createLocalSessionStore, SESSION_KEY_PREFIX, LocalStoreError } from "./localSessionStore.js";
import { createSyncService, mergeSessionLists, withTimeout } from "./syncService.js";

let passed = 0;
let failed = 0;
let skipped = 0;
function check(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}
async function test(name, fn) {
  console.log(name);
  try {
    await fn();
  } catch (e) {
    failed++;
    console.error(`  FAIL: threw ${e?.stack ?? e}`);
  }
}
async function rejects(promise, ErrorType, message) {
  try {
    await promise;
    check(false, `${message} (no error)`);
  } catch (e) {
    check(e instanceof ErrorType, `${message} (threw ${e?.name}: ${e?.message})`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { warn() {} };

// ─── Fixtures ────────────────────────────────────────────────────────────────

const GOLDEN = new URL("../assets/ml/v2_validation/golden/expected/", import.meta.url);
const GOLDEN_CASES = fs.readdirSync(GOLDEN).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
const golden = (name) => JSON.parse(fs.readFileSync(new URL(`${name}.json`, GOLDEN), "utf8"));

let seq = 0;
/** A session record as the app stores it, from one golden contract output. */
function makeRecord(caseName = "close_neighbors_not_scoreable") {
  seq += 1;
  const session = new SessionAggregator().aggregate(`test_sess_${seq}`, [golden(caseName)]);
  return buildSessionRecord(session, { source: "wav", simulated: false, note: null });
}
function makeProcessingErrorRecord() {
  seq += 1;
  const session = new SessionAggregator().aggregate(`test_sess_${seq}`, [], {
    processingErrors: [{ recording_id: null, message: "injected failure" }],
  });
  return buildSessionRecord(session, { source: "simulation", simulated: true, note: "simulated" });
}

let clock = Date.parse("2026-10-10T08:00:00.000Z");
const now = () => new Date((clock += 1000));

/** AsyncStorage stand-in (the methods localSessionStore uses). */
class MemoryStorage {
  constructor(map = new Map()) {
    this.map = map;
    this.failReads = false;
  }
  async getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async setItem(key, value) {
    if (typeof value !== "string") throw new Error("AsyncStorage stores strings only");
    this.map.set(key, value);
  }
  async getAllKeys() {
    if (this.failReads) throw new Error("storage unavailable");
    return [...this.map.keys()];
  }
  async multiGet(keys) {
    return keys.map((k) => [k, this.map.has(k) ? this.map.get(k) : null]);
  }
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

/**
 * Firestore stand-in for uploadSession(userId, record): documents by path, every write logged.
 * `modes` is consumed one per write (default "ok"):
 *   ok                  commit, then confirm
 *   reject              fail before reaching the server (e.g. offline "unavailable")
 *   hang                never confirm (offline; Firestore keeps the write in memory)
 *   commit-then-reject  the server commits, but the confirmation is lost (error reported)
 *   commit-then-hang    the server commits, but the confirmation never arrives
 *   deferred            the server commits and confirms when the test calls release()
 * With `createOnly`, overwriting an existing document is refused (restrictive security rules).
 */
function fakeFirestore() {
  const fs_ = {
    docs: new Map(),
    writes: [],
    modes: [],
    createOnly: false,
    gate: null,
    active: 0,
    maxActive: 0,
    held: [],
  };
  const path = (uid, id) => `users/${uid}/sessions/${id}`;
  const commit = (uid, record) => {
    const p = path(uid, record.session_id);
    if (fs_.createOnly && fs_.docs.has(p)) {
      throw Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" });
    }
    fs_.docs.set(p, JSON.parse(JSON.stringify(record)));
  };
  fs_.path = path;
  fs_.uploadSession = async (userId, record) => {
    fs_.writes.push({ userId, docId: record.session_id });
    fs_.active += 1;
    fs_.maxActive = Math.max(fs_.maxActive, fs_.active);
    try {
      if (fs_.gate) await fs_.gate;
      const mode = fs_.modes.length > 0 ? fs_.modes.shift() : "ok";
      if (mode === "ok") return commit(userId, record);
      if (mode === "reject") {
        throw Object.assign(new Error("Failed to get document because the client is offline."), { code: "unavailable" });
      }
      if (mode === "hang") return await new Promise(() => {});
      if (mode === "commit-then-hang") {
        commit(userId, record);
        return await new Promise(() => {});
      }
      if (mode === "commit-then-reject") {
        commit(userId, record);
        throw Object.assign(new Error("Deadline exceeded"), { code: "deadline-exceeded" });
      }
      if (mode === "deferred") {
        const d = deferred();
        fs_.held.push(() => { commit(userId, record); d.resolve(); });
        return await d.promise;
      }
      throw new Error(`unknown mode ${mode}`);
    } finally {
      fs_.active -= 1;
    }
  };
  fs_.sessionExistsRemotely = async (userId, sessionId) => fs_.docs.has(path(userId, sessionId));
  fs_.release = () => fs_.held.splice(0).forEach((fn) => fn());
  return fs_;
}

function setup({ map = new Map(), remote = fakeFirestore(), userId = "u1", confirmTimeoutMs = 40, withExistsCheck = true } = {}) {
  const storage = new MemoryStorage(map);
  const store = createLocalSessionStore(storage, { now, log: quiet });
  const sync = createSyncService({
    store,
    uploadSession: remote.uploadSession,
    getUserId: async () => userId,
    sessionExistsRemotely: withExistsCheck ? remote.sessionExistsRemotely : null,
    confirmTimeoutMs,
    now,
    log: quiet,
  });
  return { map, storage, store, sync, remote };
}

const json = (v) => JSON.stringify(v);

// ─── Tests ───────────────────────────────────────────────────────────────────

await test("1. Local save/load round trip", async () => {
  const { store, map } = setup();
  const record = makeRecord();
  const before = json(record);
  const entry = await store.saveSession(record);
  check(json(record) === before, "saveSession does not modify the record");
  check(json(entry.record) === before, "returned entry holds the record unchanged");
  const loaded = await store.getSession(record.session_id);
  check(loaded && json(loaded.record) === before, "getSession returns the record unchanged");
  check(map.has(`${SESSION_KEY_PREFIX}${record.session_id}`) && map.size === 1, "one storage key per session, named by session_id");
  const raw = JSON.parse(map.get(`${SESSION_KEY_PREFIX}${record.session_id}`));
  check(raw.format === "prism-local-session-v1" && json(raw.record) === before, "stored envelope keeps the record verbatim");
  check(raw.sync.state === "pending" && raw.sync.attempts === 0 && raw.sync.last_error === null, "new session starts pending");
  check(!("sync" in raw.record) && !("saved_at" in raw.record), "sync state is kept outside the ML record");
  assertFirestoreSafe(loaded.record);
  passed++;

  const again = await store.saveSession(record);
  check(json(again) === json(entry) && map.size === 1, "saving the identical record again is a no-op");
  const other = { ...makeRecord("single_scored_event"), session_id: record.session_id };
  await rejects(store.saveSession(other), LocalStoreError, "a different record under an existing session_id is refused");
  check(json((await store.getSession(record.session_id)).record) === before, "refused save leaves the stored record intact");
  for (const badId of ["a/b", "", "__x__", "..", null]) {
    await rejects(store.saveSession({ ...record, session_id: badId }), LocalStoreError, `invalid session_id ${json(badId)} is refused`);
  }
  check(map.size === 1, "refused saves write nothing");
  check((await store.getSession("missing_id")) === null, "getSession of a missing session returns null");

  // Every golden contract output and a processing-error session survive the round trip.
  const records = [...GOLDEN_CASES.map((c) => makeRecord(c)), makeProcessingErrorRecord()];
  for (const r of records) await store.saveSession(r);
  const { entries, corrupt } = await store.listSessions();
  for (const r of records) {
    const e = entries.find((x) => x.record.session_id === r.session_id);
    check(e && json(e.record) === json(r), `round trip of ${r.session_id} (${r.session_status})`);
  }
  check(corrupt.length === 0 && entries.length === records.length + 1, "listSessions returns every stored session");
  check(entries.every((e, i) => i === 0 || Date.parse(entries[i - 1].saved_at) >= Date.parse(e.saved_at)), "listSessions is newest first");
});

await test("2. Persistence across simulated restarts", async () => {
  const map = new Map();
  const first = setup({ map });
  const a = makeRecord();
  const b = makeRecord("no_inhalation_detected");
  await first.store.saveSession(a);
  await first.store.saveSession(b);
  await first.store.markSynced(a.session_id, { userId: "u1" });

  const restarted = setup({ map }); // new store instance over the same persisted data
  const { entries } = await restarted.store.listSessions();
  const ea = entries.find((e) => e.record.session_id === a.session_id);
  const eb = entries.find((e) => e.record.session_id === b.session_id);
  check(entries.length === 2, "both sessions are found after a restart");
  check(ea && json(ea.record) === json(a) && ea.sync.state === "synced" && ea.sync.synced_user_id === "u1", "synced session keeps record and sync state");
  check(eb && json(eb.record) === json(b) && eb.sync.state === "pending", "pending session is still pending");
  const pending = await restarted.store.listPending();
  check(pending.length === 1 && pending[0].record.session_id === b.session_id, "listPending after restart");
});

await test("3. Session visible while Firestore never confirms", async () => {
  const remote = fakeFirestore();
  remote.modes = ["hang", "hang", "hang"];
  const { store, sync } = setup({ remote });
  const record = makeRecord();
  const saved = await withTimeout(sync.saveSession(record), 500, "TIMEOUT");
  check(saved !== "TIMEOUT", "saveSession returns without waiting for Firestore");
  const listed = (await store.listSessions()).entries.find((e) => e.record.session_id === record.session_id);
  check(listed && listed.sync.state === "pending", "the session is listed (pending) immediately");

  // With a realistic confirmation timeout the save must still return at once.
  const slowRemote = fakeFirestore();
  slowRemote.modes = ["hang"];
  const slow = setup({ remote: slowRemote, confirmTimeoutMs: 60000 });
  const started = Date.now();
  const slowSaved = await withTimeout(slow.sync.saveSession(makeRecord()), 1000, "TIMEOUT");
  check(slowSaved !== "TIMEOUT" && Date.now() - started < 1000, "saveSession does not wait for the upload (60 s confirmation timeout)");
  check(slow.sync.getStatus().running === true && slowRemote.writes.length === 1, "the upload runs in the background");

  const status = await sync.syncNow();
  check(status.lastOutcome === "no_confirmation" && status.pending === 1, `pass ends without confirmation (${status.lastOutcome})`);
  const after = await store.getSession(record.session_id);
  check(after.sync.state === "pending" && /no server confirmation/.test(after.sync.last_error), "unconfirmed upload stays pending with a reason");
  check(remote.writes.length === 1, `the write Firestore still holds is not sent again (${remote.writes.length} writes)`);
  check(remote.docs.size === 0, "nothing was committed");
});

await test("4. Late confirmation after a pass gave up", async () => {
  const remote = fakeFirestore();
  remote.modes = ["deferred"];
  const { store, sync } = setup({ remote });
  const a = makeRecord();
  const b = makeRecord("single_scored_event");
  await store.saveSession(a);
  await store.saveSession(b);
  const status = await sync.syncNow();
  check(status.lastOutcome === "no_confirmation", "first pass stops at the unconfirmed upload");
  check((await store.getSession(a.session_id)).sync.state === "pending", "still pending before the confirmation");
  remote.release(); // connection back: Firestore delivers the held write and confirms it
  await sleep(50);
  await sync.syncNow();
  check((await store.getSession(a.session_id)).sync.state === "synced", "late confirmation marks the session synced");
  check((await store.getSession(b.session_id)).sync.state === "synced", "the rest of the queue is uploaded afterwards");
  check(remote.docs.size === 2 && remote.writes.filter((w) => w.docId === a.session_id).length === 1, "one write and one document per session");
});

await test("5. App closed during sync: nothing lost, retried after restart", async () => {
  const map = new Map();
  const remote = fakeFirestore();
  remote.modes = ["hang"];
  const first = setup({ map, remote });
  const record = makeRecord();
  await first.sync.saveSession(record);
  await first.sync.syncNow();
  // "Restart": the process (and Firestore's in-memory write) is gone; storage remains.
  const restarted = setup({ map, remote });
  const status = await restarted.sync.syncNow();
  check(status.lastOutcome === "synced" && status.pending === 0, `retry after restart succeeds (${status.lastOutcome})`);
  const doc = remote.docs.get(remote.path("u1", record.session_id));
  check(remote.docs.size === 1 && doc && json(doc) === json(record), "exactly one remote document, equal to the record");
  check((await restarted.store.getSession(record.session_id)).sync.state === "synced", "marked synced after confirmation");
});

await test("6. Successful sync and pending-state updates", async () => {
  const { store, sync, remote } = setup();
  const record = makeRecord();
  await sync.saveSession(record);
  const status = await sync.syncNow();
  const entry = await store.getSession(record.session_id);
  check(entry.sync.state === "synced" && entry.sync.attempts === 1 && entry.sync.synced_user_id === "u1"
    && entry.sync.last_error === null && typeof entry.sync.synced_at === "string", "entry marked synced with its metadata");
  check(remote.docs.has(remote.path("u1", record.session_id)), "document ID is the session_id");
  check(status.pending === 0 && status.lastOutcome === "synced" && status.userId === "u1", "status reports nothing pending");
  const writes = remote.writes.length;
  await sync.syncNow();
  check(remote.writes.length === writes, "a synced session is not uploaded again");
  check(json(entry.record) === json(record), "sync bookkeeping leaves the record unchanged");
});

await test("7. Failed sync stays pending, then retry succeeds", async () => {
  const remote = fakeFirestore();
  remote.modes = ["reject", "ok"];
  const { store, sync } = setup({ remote });
  const record = makeRecord();
  await store.saveSession(record);
  const s1 = await sync.syncNow();
  const e1 = await store.getSession(record.session_id);
  check(e1.sync.state === "pending" && e1.sync.attempts === 1 && /unavailable/.test(e1.sync.last_error), "failed upload stays pending with its error");
  check(s1.lastOutcome === "partial" && s1.pending === 1, `status reports the failure (${s1.lastOutcome})`);
  const s2 = await sync.syncNow();
  const e2 = await store.getSession(record.session_id);
  check(e2.sync.state === "synced" && e2.sync.attempts === 2 && e2.sync.last_error === null, "retry marks it synced");
  check(s2.lastOutcome === "synced" && s2.pending === 0, "status after retry");
  check(remote.writes.length === 2 && remote.writes.every((w) => w.docId === record.session_id), "both attempts used the same document ID");
  check(remote.docs.size === 1, "one remote document");
});

await test("8. Idempotent retry when the server committed but the confirmation was lost", async () => {
  // a) The write is committed, its confirmation lost (rejected): the retry overwrites the same document.
  const remote = fakeFirestore();
  remote.modes = ["commit-then-reject", "ok"];
  const plain = setup({ remote, withExistsCheck: false });
  const record = makeRecord();
  await plain.store.saveSession(record);
  await plain.sync.syncNow();
  check((await plain.store.getSession(record.session_id)).sync.state === "pending", "lost confirmation leaves the session pending");
  check(remote.docs.size === 1, "the server already holds the document");
  await plain.sync.syncNow();
  check(remote.docs.size === 1 && remote.writes.length === 2 && remote.writes.every((w) => w.docId === record.session_id),
    "the retry writes the same document ID (no duplicate)");
  check((await plain.store.getSession(record.session_id)).sync.state === "synced", "retry is confirmed");

  // b) Same, with the server check: the rejected write is found on the server and confirmed at once.
  const checked = fakeFirestore();
  checked.modes = ["commit-then-reject"];
  const c = setup({ remote: checked });
  const r1 = makeRecord("single_scored_event");
  await c.store.saveSession(r1);
  await c.sync.syncNow();
  check((await c.store.getSession(r1.session_id)).sync.state === "synced" && checked.writes.length === 1,
    "a rejected write that reached the server is confirmed by a server read");

  // c) Rules that refuse overwrites; the confirmation was lost when the app closed.
  const map = new Map();
  const strict = fakeFirestore();
  strict.createOnly = true;
  strict.modes = ["commit-then-hang"];
  const before = setup({ map, remote: strict });
  const r2 = makeRecord("short_event_not_scoreable");
  await before.store.saveSession(r2);
  await before.sync.syncNow(); // committed, never confirmed; then the app is closed
  const after = setup({ map, remote: strict });
  await after.sync.syncNow(); // overwrite refused → server read finds the document
  check(strict.docs.size === 1 && strict.writes.length === 2, "two attempts, one document");
  check((await after.store.getSession(r2.session_id)).sync.state === "synced", "server copy confirmed by a server read → synced");

  // d) The same without the server check stays pending (never falsely synced) and never duplicates.
  const map2 = new Map();
  const strict2 = fakeFirestore();
  strict2.createOnly = true;
  strict2.modes = ["commit-then-hang"];
  const b2 = setup({ map: map2, remote: strict2, withExistsCheck: false });
  await b2.store.saveSession(r2);
  await b2.sync.syncNow();
  const a2 = setup({ map: map2, remote: strict2, withExistsCheck: false });
  await a2.sync.syncNow();
  check(strict2.docs.size === 1, "refused overwrite creates no duplicate");
  check((await a2.store.getSession(r2.session_id)).sync.state === "pending", "unconfirmed session is not marked synced");
});

await test("9. Concurrent sync requests", async () => {
  const remote = fakeFirestore();
  const gate = deferred();
  remote.gate = gate.promise;
  const { store, sync } = setup({ remote });
  const records = [makeRecord(), makeRecord("single_scored_event"), makeRecord("short_event_not_scoreable")];
  for (const r of records) await store.saveSession(r);
  const calls = Array.from({ length: 5 }, () => sync.syncNow());
  check(new Set(calls).size === 1, "concurrent syncNow calls share one run");
  check(sync.getStatus().running === true, "status shows the running sync");
  // A session saved while a pass runs is picked up by the follow-up pass.
  const late = makeRecord("boundary_event_not_scoreable");
  const savedLate = sync.saveSession(late);
  gate.resolve();
  remote.gate = null;
  await savedLate;
  await Promise.all(calls);
  await sync.syncNow();
  check(remote.maxActive === 1, `uploads never overlap (max ${remote.maxActive} at once)`);
  check(remote.writes.length === 4 && new Set(remote.writes.map((w) => w.docId)).size === 4, `one upload per session (${remote.writes.length} writes)`);
  const { entries } = await store.listSessions();
  check(entries.length === 4 && entries.every((e) => e.sync.state === "synced"), "all sessions synced, including the one saved mid-pass");
  check(sync.getStatus().running === false, "no sync running afterwards");
});

await test("10. Local/remote merge without duplicates", async () => {
  const { store } = setup();
  const a = makeRecord();
  const b = makeRecord("single_scored_event");
  await store.saveSession(a);
  await store.saveSession(b);
  await store.markSynced(b.session_id, { userId: "u1" });
  const c = makeRecord("no_inhalation_detected");
  const ts = (iso) => new Date(iso);
  const remote = [
    { id: b.session_id, ...b, legacy: false, timestamp: ts("2026-10-10T09:00:00Z") },
    // written by the previous app version with a random document ID
    { id: "Xq7RandomDocId", ...c, legacy: false, timestamp: ts("2026-10-01T09:00:00Z") },
    { id: "Yq8RandomDocId", ...c, legacy: false, timestamp: ts("2026-10-01T09:00:01Z") },
    { id: "oldGoodPoorDoc", status: "complete", quality_assessment: { composite_label: "GOOD" }, legacy: true, timestamp: ts("2026-01-01T09:00:00Z") },
  ];
  const { entries } = await store.listSessions();
  const merged = mergeSessionLists(entries, remote);
  const ids = merged.map((m) => m.id);
  check(merged.length === 4 && new Set(ids).size === 4, `no duplicates (${ids.join(", ")})`);
  const mb = merged.find((m) => m.id === b.session_id);
  check(mb.origin === "local" && mb.sync.state === "synced", "the phone's copy wins for a session in both places");
  const mc = merged.filter((m) => m.session_id === c.session_id);
  check(mc.length === 1 && mc[0].origin === "remote" && mc[0].sync.state === "synced", "remote-only session listed once, as synced");
  const legacy = merged.find((m) => m.id === "oldGoodPoorDoc");
  check(legacy && legacy.legacy === true, "legacy document kept and flagged");
  check(merged.find((m) => m.id === a.session_id).sync.state === "pending", "local pending session keeps its state");
  check(merged.every((m, i) => i === 0 || merged[i - 1].timestamp.getTime() >= m.timestamp.getTime()), "newest first");
  check(json(mergeSessionLists(entries, remote)) === json(merged), "merge is deterministic");
  check(mergeSessionLists(entries, []).length === 2, "local history alone when no remote history is available");
  const local = merged.find((m) => m.id === a.session_id);
  const { id, legacy: l, timestamp, sync, origin, ...rest } = local; // eslint-disable-line no-unused-vars
  check(json(rest) === json(a), "a list item is the record plus display metadata");
});

await test("11. Corrupt and foreign local entries", async () => {
  const map = new Map();
  const valid = makeRecord();
  const envelope = (record, extra = {}) => json({
    format: "prism-local-session-v1",
    saved_at: "2026-10-10T08:00:00.000Z",
    record,
    sync: { state: "pending", attempts: 0 },
    ...extra,
  });
  const corruptValues = {
    [`${SESSION_KEY_PREFIX}bad_json`]: "{not json",
    [`${SESSION_KEY_PREFIX}bad_array`]: "[1,2]",
    [`${SESSION_KEY_PREFIX}bad_no_record`]: json({ format: "prism-local-session-v1", saved_at: "2026-10-10T08:00:00.000Z", sync: { state: "pending" } }),
    [`${SESSION_KEY_PREFIX}bad_mismatch`]: envelope({ ...valid, session_id: "other_id" }),
    [`${SESSION_KEY_PREFIX}bad_format`]: envelope(valid, { format: "something-else" }),
    [`${SESSION_KEY_PREFIX}bad_sync`]: envelope({ ...valid, session_id: "bad_sync" }, { sync: { state: "weird" } }),
  };
  for (const [k, v] of Object.entries(corruptValues)) map.set(k, v);
  map.set("@SmartInhaler:lastDevice", json({ deviceId: "BLE-1" })); // another feature's key
  const remote = fakeFirestore();
  const { store, sync, storage } = setup({ map, remote });
  await store.saveSession(valid);

  const { entries, corrupt } = await store.listSessions();
  check(entries.length === 1 && entries[0].record.session_id === valid.session_id, "the valid session is listed");
  check(corrupt.length === Object.keys(corruptValues).length, `every corrupt entry is reported (${corrupt.length})`);
  check(!corrupt.some((c) => c.key === "@SmartInhaler:lastDevice"), "keys of other features are ignored");
  check((await store.getSession("bad_json")) === null, "getSession of a corrupt entry returns null");
  const status = await sync.syncNow();
  check(status.lastOutcome === "synced" && remote.docs.size === 1, "sync uploads the valid session and skips corrupt ones");
  check(Object.entries(corruptValues).every(([k, v]) => map.get(k) === v), "corrupt entries are left untouched (not deleted or overwritten)");
  await rejects(store.saveSession({ ...valid, session_id: "bad_json" }), LocalStoreError, "a save never overwrites unreadable data");
  check(map.get(`${SESSION_KEY_PREFIX}bad_json`) === "{not json", "unreadable data still intact");
  check((await store.markSynced("bad_json")) === null, "sync update of a corrupt entry is skipped");

  storage.failReads = true;
  await rejects(store.listSessions(), Error, "an unreadable store rejects listSessions (the caller reports it)");
  const s = await sync.syncNow();
  check(s.lastOutcome === "error" && /local store unreadable/.test(s.lastError), `sync reports an unreadable store without throwing (${s.lastOutcome})`);
});

await test("12. Not signed in (offline first launch or no Firebase)", async () => {
  const remote = fakeFirestore();
  const { store, sync } = setup({ remote, userId: null });
  const record = makeRecord();
  await sync.saveSession(record);
  const status = await sync.syncNow();
  check(status.lastOutcome === "not_signed_in" && status.pending === 1, "sync reports not signed in");
  check(remote.writes.length === 0, "nothing is uploaded without a user");
  check((await store.getSession(record.session_id)).sync.state === "pending", "session stays pending on the phone");
});

// ─── Firestore and Auth calls (fake firebase modules) ───────────────────────

const FIRESTORE_FAKE = `
const s = globalThis.__prismFakeFirebase;
export const collection = (db, ...segments) => ({ kind: "collection", path: segments.join("/") });
export const doc = (parent, ...segments) => {
  if (segments.length === 0) throw new Error("doc() without an ID (auto ID) is not expected");
  const path = parent.kind === "collection" ? [parent.path, ...segments].join("/") : segments.join("/");
  return { kind: "doc", path, id: segments[segments.length - 1] };
};
export const setDoc = (ref, data, options) => { s.calls.push({ op: "setDoc", path: ref.path, data, options }); return s.setDocResult(ref.path); };
export const addDoc = async (ref, data) => { s.calls.push({ op: "addDoc", path: ref.path, data }); return { id: "random" }; };
export const getDocs = async () => ({ docs: s.remoteDocs.map(([id, data]) => ({ id, data: () => data })) });
export const getDocFromServer = async (ref) => { const d = s.server.get(ref.path); return { exists: () => d !== undefined, data: () => d }; };
export const query = (ref) => ref;
export const orderBy = () => null;
export const serverTimestamp = () => ({ __serverTimestamp: true });
`;
const AUTH_FAKE = `
const s = globalThis.__prismFakeFirebase;
export const signInAnonymously = async () => s.signIn();
`;
const CONFIG_FAKE = `
export const db = { fake: "db" };
export const auth = { fake: "auth" };
export const firebaseInitError = null;
`;
const dataUrl = (src) => `data:text/javascript,${encodeURIComponent(src)}`;

if (typeof nodeModule.registerHooks !== "function") {
  skipped += 1;
  console.log("13–14. SKIPPED: node:module registerHooks needs Node >= 22.15");
} else {
  const fake = (globalThis.__prismFakeFirebase = {
    calls: [],
    remoteDocs: [],
    server: new Map(),
    setDocResult: () => Promise.resolve(),
    signIn: async () => ({ user: { uid: "u1" } }),
  });
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "firebase/firestore") return { url: dataUrl(FIRESTORE_FAKE), shortCircuit: true };
      if (specifier === "firebase/auth") return { url: dataUrl(AUTH_FAKE), shortCircuit: true };
      if (specifier.endsWith("/firebase/firebaseConfig")) return { url: dataUrl(CONFIG_FAKE), shortCircuit: true };
      // app modules import siblings without an extension (Metro style)
      if (/^\.\.?\//.test(specifier) && !/\.[cm]?js$/.test(specifier) && context.parentURL?.startsWith("file:")) {
        return nextResolve(`${specifier}.js`, context);
      }
      return nextResolve(specifier, context);
    },
  });
  const sessionService = await import("./sessionService.js");
  const authService = await import("./authService.js");

  await test("13. sessionService: deterministic document ID, server check, history mapping", async () => {
    const record = makeRecord();
    const id1 = await sessionService.addSession("u1", record);
    const id2 = await sessionService.addSession("u1", record);
    const writes = fake.calls.filter((c) => c.op === "setDoc" || c.op === "addDoc");
    check(id1 === record.session_id && id2 === record.session_id, "addSession returns the session_id");
    check(writes.length === 2 && writes.every((c) => c.op === "setDoc" && c.path === `users/u1/sessions/${record.session_id}`),
      "every write (including a retry) is setDoc on users/{uid}/sessions/{session_id}");
    const { timestamp, ...data } = writes[0].data;
    check(json(data) === json(record) && timestamp?.__serverTimestamp === true, "document = record + server timestamp");
    await rejects(sessionService.addSession("u1", { ...record, session_id: "a/b" }), Error, "an invalid session_id is refused");

    fake.server.set(`users/u1/sessions/${record.session_id}`, { ...record });
    check(await sessionService.sessionExistsRemotely("u1", record.session_id) === true, "sessionExistsRemotely finds a server document");
    check(await sessionService.sessionExistsRemotely("u1", "absent_id") === false, "sessionExistsRemotely: absent document");

    fake.remoteDocs = [
      [record.session_id, { ...record, timestamp: { toDate: () => new Date("2026-10-10T09:00:00Z") } }],
      ["legacyDoc", { status: "complete", quality_assessment: {}, timestamp: { toDate: () => new Date("2026-01-01T00:00:00Z") } }],
      ["inProgress", { status: "in_progress", timestamp: null }],
    ];
    const history = await sessionService.getSessions("u1");
    check(history.length === 2 && history[0].legacy === false && history[1].legacy === true, "getSessions flags legacy documents and hides in_progress");
    check(history[0].timestamp instanceof Date, "getSessions converts timestamps to Date");
  });

  await test("14. authService: sign-in never waits for the profile write; failures are not fatal", async () => {
    fake.calls = [];
    fake.setDocResult = () => new Promise(() => {}); // offline: Firestore never confirms
    const uid = await withTimeout(authService.signInAnonymously(), 500, "TIMEOUT");
    check(uid === "u1", `signInAnonymously resolves while the profile write is unconfirmed (${String(uid)})`);
    check(fake.calls.some((c) => c.op === "setDoc" && c.path === "users/u1" && c.options?.merge === true), "profile write was issued");
    fake.setDocResult = () => Promise.resolve();
    fake.signIn = async () => { throw Object.assign(new Error("network"), { code: "auth/network-request-failed" }); };
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      check(await authService.ensureSignedIn() === null, "ensureSignedIn returns null when sign-in fails");
      fake.signIn = async () => ({ user: { uid: "u2" } });
      const [x, y] = await Promise.all([authService.ensureSignedIn(), authService.ensureSignedIn()]);
      check(x === "u2" && y === "u2", "concurrent ensureSignedIn calls share one attempt");
    } finally {
      console.warn = origWarn;
    }
    check(authService.isFirebaseConfigured() === true, "isFirebaseConfigured with a configured fake");
  });
}

// ─── Demo sessions (reference recordings bundled with the app) ───────────────

await test("15. Demo sessions: bundled recordings, real pipeline output, stored and synced like any session", async () => {
  const DEMO_DIR = new URL("../assets/demo_recordings/", import.meta.url);
  const DATASET_DIR = new URL("../../PRISM%20smart%20inhaler/data/", import.meta.url);
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

  const files = fs.readdirSync(DEMO_DIR).filter((f) => f.endsWith(".wav")).sort();
  check(json(files) === json(demo.DEMO_RECORDINGS.map((r) => r.file)), `every bundled file is listed, and only those (${files.length})`);
  const loader = fs.readFileSync(new URL("./demoRecordings.js", import.meta.url), "utf8");
  let comparedWithDataset = 0;
  for (const r of demo.DEMO_RECORDINGS) {
    check(sha(fs.readFileSync(new URL(r.file, DEMO_DIR))) === r.sha256, `${r.file} has the listed SHA-256`);
    check(loader.includes(`require("../assets/demo_recordings/${r.file}")`), `${r.file} is bundled by services/demoRecordings.js`);
    const original = new URL(r.recordingId, DATASET_DIR);
    if (fs.existsSync(original)) {
      comparedWithDataset += 1;
      check(sha(fs.readFileSync(original)) === r.sha256, `${r.file} is byte-identical to the dataset's ${r.recordingId}`);
    }
  }
  if (comparedWithDataset === 0) console.log("  (../PRISM smart inhaler/data not found: bundled copies not compared with the dataset)");
  check(demo.pickDemoRecording(() => 0) === demo.DEMO_RECORDINGS[0]
    && demo.pickDemoRecording(() => 0.9999999999) === demo.DEMO_RECORDINGS.at(-1), "the random pick stays within the bundled set");

  const recording = demo.DEMO_RECORDINGS[0];
  const bytes = new Uint8Array(fs.readFileSync(new URL(recording.file, DEMO_DIR)));
  const pipeline = await createNodePipeline();
  const record = await demo.analyseDemoRecording(async () => pipeline, recording, bytes, { now: () => 1791740000000 });
  const direct = await pipeline.run(new WavPcmSource(bytes, { inputDomain: "reference_dataset", sourceId: recording.recordingId }));
  check(record.session_id === "demo_sess_1791740000000" && record.source === "wav" && record.simulated === false,
    `demo record identity (${record.session_id}, ${record.source}, simulated ${record.simulated})`);
  check(record.note.includes(recording.recordingId) && /not recorded with this phone/.test(record.note), "the note names the dataset recording");
  check(record.n_recordings === 1 && json(record.recordings[0]) === json(direct),
    "the stored output is exactly the pipeline's output for the recording (nothing mocked)");
  check(record.recordings[0].input.input_domain === "reference_dataset" && record.recordings[0].baseline_domain_validated === true,
    "input domain is the reference dataset");
  check(record.session_status !== "PROCESSING_ERROR", `the pipeline ran (${record.session_status})`);
  assertFirestoreSafe(record);

  check(demo.demoRecordingOf(record) === recording, "a demo session is traced back to its bundled recording");
  check(demo.demoRecordingOf(makeRecord()) === null && demo.demoRecordingOf(makeProcessingErrorRecord()) === null,
    "other sessions have no bundled recording");

  const { store, sync, remote } = setup();
  await sync.saveSession(record);
  await sync.syncNow();
  const entry = await store.getSession(record.session_id);
  check(entry.sync.state === "synced" && remote.docs.has(remote.path("u1", record.session_id)) && json(entry.record) === json(record),
    "stored on the phone and uploaded unchanged under its session_id");

  const broken = await demo.analyseDemoRecording(() => Promise.reject(new Error("injected pipeline failure")), recording, bytes);
  check(broken.session_status === "PROCESSING_ERROR" && broken.n_recordings === 0 && broken.note.includes(recording.recordingId)
    && demo.demoRecordingOf(broken) === null, "a pipeline failure is stored as a processing error, not as a result");

  const wave = demo.waveformEnvelope(bytes, 96);
  check(wave.peaks.length === 96 && Math.max(...wave.peaks) === 1 && wave.peaks.every((p) => p >= 0 && p <= 1),
    "waveform envelope: 96 peaks scaled to [0, 1]");
  check(wave.durationS === record.recordings[0].input.duration_s, `waveform duration matches the recording (${wave.durationS} s)`);
});

console.log(`\n${passed} checks passed, ${failed} failed, ${skipped} section(s) skipped`);
process.exit(failed === 0 ? 0 : 1);
