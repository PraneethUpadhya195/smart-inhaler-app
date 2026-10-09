import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { getSessions } from "../services/sessionService";
import { localSessionStore, sessionSync } from "../services/appServices";
import { mergeSessionLists, withTimeout } from "../services/syncService";

/** How long a background fetch of the Firestore history may take before it is ignored. */
const REMOTE_HISTORY_TIMEOUT_MS = 20000;
const REMOTE_TIMEOUT = Symbol("remote timeout");

// ─── Context ──────────────────────────────────────────────────────────────────

const AppContext = createContext(null);

// ─── Provider ──────────────────────────────────────────────────────────────────

export function AppProvider({ children }) {
  const [userId, setUserId] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [localStoreError, setLocalStoreError] = useState(null);
  const [syncStatus, setSyncStatus] = useState(() => sessionSync.getStatus());

  // Last Firestore history fetched; merged with the local sessions on every refresh.
  const remoteSessionsRef = useRef([]);
  const userIdRef = useRef(null);

  // Device state
  const [deviceStatus, setDeviceStatus] = useState("Disconnected");
  const [deviceId, setDeviceId] = useState(null);
  const [deviceName, setDeviceName] = useState(null);
  const [batteryLevel, setBatteryLevel] = useState(null);

  // ─── Auth ────────────────────────────────────────────────────────────────────

  const initUser = useCallback((uid) => {
    userIdRef.current = uid;
    setUserId(uid);
  }, []);

  // ─── Sessions ─────────────────────────────────────────────────────────────────

  /** Re-read the sessions stored on this phone and merge them with the last remote history. */
  const refreshLocalSessions = useCallback(async () => {
    try {
      const { entries, corrupt } = await localSessionStore.listSessions();
      setLocalStoreError(corrupt.length > 0
        ? `${corrupt.length} stored session(s) could not be read and are not shown.`
        : null);
      setSessions(mergeSessionLists(entries, remoteSessionsRef.current));
    } catch (e) {
      console.error("[AppContext] Local session store unreadable:", e);
      setLocalStoreError(`Sessions on this phone could not be read: ${e?.message ?? e}`);
    }
  }, []);

  /**
   * Loads the session history: the sessions stored on this phone first (no network needed),
   * then, when a user ID is known, the Firestore history merged in without duplicates.
   * Never throws. Callers that must not wait for the network call it without a user ID.
   * @param {string} [uid]
   */
  const loadSessions = useCallback(async (uid) => {
    const id = uid || userIdRef.current;
    setIsLoadingSessions(true);
    try {
      await refreshLocalSessions();
    } finally {
      setIsLoadingSessions(false);
    }
    if (!id) return;
    try {
      const remote = await withTimeout(getSessions(id), REMOTE_HISTORY_TIMEOUT_MS, REMOTE_TIMEOUT);
      if (remote === REMOTE_TIMEOUT) {
        console.warn("[AppContext] Remote history not loaded: no answer from Firestore");
        return;
      }
      remoteSessionsRef.current = remote;
      await refreshLocalSessions();
    } catch (e) {
      console.warn("[AppContext] Remote history not loaded:", e?.message ?? e);
    }
  }, [refreshLocalSessions]);

  /**
   * Stores a completed session on this phone and shows it immediately. The Firestore upload
   * runs in the background (services/syncService.js); this never waits for the network.
   * @param {Object} sessionData — session record (services/sessionRecord.buildSessionRecord)
   * @returns {Promise<string>} sessionId
   * @throws when the session cannot be stored on the phone
   */
  const addNewSession = useCallback(async (sessionData) => {
    const entry = await sessionSync.saveSession(sessionData);
    await refreshLocalSessions();
    return entry.record.session_id;
  }, [refreshLocalSessions]);

  /**
   * Prepends a session object that was already saved to Firestore (BLE path).
   * (No BLE session writer exists yet; kept for a future BLE path.)
   * @param {Object} session — must include id
   */
  const prependSession = useCallback((session) => {
    setSessions((prev) => [session, ...prev.filter((s) => s.id !== session.id)]);
  }, []);

  /** Upload pending sessions now ("Sync now"). Resolves with the sync status; never throws. */
  const syncNow = useCallback(() => sessionSync.syncNow(), []);

  /** Request an upload in the background. */
  const requestSync = useCallback((reason) => sessionSync.requestSync(reason), []);

  // Sync progress → status for the UI, refreshed sync states in the list, and the remote
  // history once a sync pass has signed in (e.g. the app started offline).
  useEffect(() => sessionSync.subscribe((status) => {
    setSyncStatus(status);
    if (status.userId && status.userId !== userIdRef.current) {
      initUser(status.userId);
      loadSessions(status.userId);
    } else {
      refreshLocalSessions();
    }
  }), [initUser, loadSessions, refreshLocalSessions]);

  // Returning to the foreground is a chance that the network is back.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") sessionSync.requestSync("foreground");
    });
    return () => subscription.remove();
  }, []);

  // ─── Device ──────────────────────────────────────────────────────────────────

  const setDeviceConnected = useCallback(({ deviceId: id, deviceName: name, batteryLevel: battery }) => {
    setDeviceStatus("Connected");
    setDeviceId(id);
    setDeviceName(name);
    setBatteryLevel(battery);
  }, []);

  const setDeviceDisconnected = useCallback(() => {
    setDeviceStatus("Disconnected");
    setDeviceId(null);
    setDeviceName(null);
    setBatteryLevel(null);
  }, []);

  // ─── Value ───────────────────────────────────────────────────────────────────

  return (
    <AppContext.Provider
      value={{
        userId,
        initUser,
        sessions,
        isLoadingSessions,
        localStoreError,
        loadSessions,
        addNewSession,
        prependSession,
        syncStatus,
        syncNow,
        requestSync,
        deviceStatus,
        deviceId,
        deviceName,
        batteryLevel,
        setDeviceConnected,
        setDeviceDisconnected,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be used within AppProvider");
  return ctx;
}
