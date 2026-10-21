import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { AppState, Vibration } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getSessions } from "../services/sessionService";
import { localSessionStore, sessionSync } from "../services/appServices";
import { mergeSessionLists, withTimeout } from "../services/syncService";
import { getRecorder } from "../services/bleService";
import { createRecordingWorkflow, LIFECYCLE } from "../services/recordingWorkflow";
import { analyseHardwareRecording, analyseReferenceInput, deviceHistory } from "../services/hardwareSession";
import { saveRecordingAudio, deleteRecordingAudio } from "../services/audioFiles";
import { createAnalysisSelector, SELECTION } from "../services/analysisRecordings";
import { loadAnalysisBytes } from "../services/analysisAudio";
import { getPipeline } from "../services/inferenceService";
import { saveDevice } from "../services/deviceService";
import { saveLastDevice } from "../services/storageService";

const SETTINGS_KEY = "@PRISM:settings";
/** App settings kept on this phone. recordingSeconds: length of an on-board recording. */
export const DEFAULT_SETTINGS = Object.freeze({ recordingSeconds: 15, vibrateOnResult: true });
export const RECORDING_SECONDS_CHOICES = Object.freeze([5, 10, 15]);

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

  // Device state: driven by the BLE recorder (services/bleService.js), never simulated.
  const [deviceStatus, setDeviceStatus] = useState("Disconnected");
  const [deviceId, setDeviceId] = useState(null);
  const [deviceName, setDeviceName] = useState(null);
  const [deviceInfo, setDeviceInfo] = useState(null);
  // The hardware has no battery measurement, so no level is ever reported.
  const batteryLevel = null;

  // On-board recording lifecycle (services/recordingWorkflow.js)
  const [recordingState, setRecordingState] = useState({ phase: LIFECYCLE.IDLE });
  const sessionsRef = useRef([]);
  const workflowRef = useRef(null);

  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const settingsRef = useRef(DEFAULT_SETTINGS);

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
      const merged = mergeSessionLists(entries, remoteSessionsRef.current);
      sessionsRef.current = merged;
      setSessions(merged);
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
  const addNewSessionRef = useRef(addNewSession);
  addNewSessionRef.current = addNewSession;

  /**
   * Prepends a session object to the list (kept for callers of the previous API; BLE sessions are
   * stored through addNewSession like every other session).
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

  const setDeviceConnected = useCallback((device) => {
    setDeviceStatus("Connected");
    setDeviceId(device?.deviceId ?? null);
    setDeviceName(device?.name ?? null);
    setDeviceInfo(device ?? null);
  }, []);

  const setDeviceDisconnected = useCallback(() => {
    setDeviceStatus("Disconnected");
    setDeviceId(null);
    setDeviceName(null);
    setDeviceInfo(null);
  }, []);

  // The recorder reports connects and disconnects (including a device that goes out of range).
  // Every new connection (Device screen, on-board recording, start-up reconnect) is remembered on
  // this phone for the next start-up, and registered in Firestore in the background.
  useEffect(() => {
    let lastBleId = null;
    return getRecorder().subscribe(({ connected, device }) => {
      if (!connected) {
        lastBleId = null;
        setDeviceDisconnected();
        return;
      }
      setDeviceConnected(device);
      if (device.bleId === lastBleId) return;
      lastBleId = device.bleId;
      saveLastDevice({ bleId: device.bleId, deviceId: device.deviceId, deviceName: device.name })
        .catch((err) => console.warn("[AppContext] last device not saved:", err?.message ?? err));
      const uid = userIdRef.current;
      if (uid) {
        saveDevice(uid, { deviceId: device.deviceId, name: device.name ?? device.deviceId })
          .catch((err) => console.warn("[AppContext] device not registered in Firestore:", err?.message ?? err));
      }
    });
  }, [setDeviceConnected, setDeviceDisconnected]);

  /** Connect to a PRISM device (bleId null: the first one found) and remember it. Throws RecorderError. */
  const connectDevice = useCallback(async (bleId = null) => {
    setDeviceStatus("Connecting");
    try {
      const device = await getRecorder().connect({ deviceId: bleId });
      setDeviceConnected(device); // also remembered by the recorder subscription above
      return device;
    } catch (e) {
      setDeviceStatus(getRecorder().isConnected() ? "Connected" : "Disconnected");
      throw e;
    }
  }, [setDeviceConnected]);

  const disconnectDevice = useCallback(async () => {
    await getRecorder().disconnect();
    setDeviceDisconnected();
  }, [setDeviceDisconnected]);

  // ─── Settings ────────────────────────────────────────────────────────────────

  useEffect(() => {
    AsyncStorage.getItem(SETTINGS_KEY).then((raw) => {
      if (!raw) return;
      try {
        const stored = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
        if (!RECORDING_SECONDS_CHOICES.includes(stored.recordingSeconds)) stored.recordingSeconds = DEFAULT_SETTINGS.recordingSeconds;
        settingsRef.current = stored;
        setSettings(stored);
      } catch {
        console.warn("[AppContext] settings unreadable; defaults used");
      }
    }).catch((e) => console.warn("[AppContext] settings not loaded:", e?.message ?? e));
  }, []);

  const updateSettings = useCallback(async (change) => {
    const next = { ...settingsRef.current, ...change };
    settingsRef.current = next;
    setSettings(next);
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  }, []);

  // ─── On-board recording ──────────────────────────────────────────────────────

  if (!workflowRef.current) {
    const selector = createAnalysisSelector({ storage: AsyncStorage });
    workflowRef.current = createRecordingWorkflow({
      recorder: getRecorder(),
      keepAudio: saveRecordingAudio,
      selectAnalysis: (selection) => selector.select(selection),
      discardAudio: deleteRecordingAudio,
      // Start Event sessions analyse the chosen reference recording; the capture is only kept and played.
      analyse: (recording, { audioFile, analysisRecording }) => (analysisRecording
        ? analyseReferenceInput(getPipeline, recording, { analysisRecording, loadAnalysisBytes, audioFile })
        : analyseHardwareRecording(getPipeline, recording, {
          audioFile,
          history: deviceHistory(sessionsRef.current, recording.device?.deviceId ?? null),
        })),
      save: (record) => addNewSessionRef.current(record),
      onState: (state) => {
        setRecordingState(state);
        if (state.phase === LIFECYCLE.COMPLETED && settingsRef.current.vibrateOnResult) Vibration.vibrate(200);
      },
    });
  }

  /** Record with the connected (or first found) PRISM device, analyse, save. Never throws. */
  const startOnBoardRecording = useCallback(() => {
    const workflow = workflowRef.current;
    if (workflow.isRunning()) return Promise.resolve(null);
    const seconds = settingsRef.current.recordingSeconds;
    return workflow.run({ nSamples: Math.round(seconds * 8000) });
  }, []);

  /**
   * Start Event: a press (long: false) or a long press (long: true) on a start control. Chooses the
   * analysis recording, then records with the device as above. Never throws; a second call while a
   * recording runs is ignored.
   */
  const startEvent = useCallback(({ long = false } = {}) => {
    const workflow = workflowRef.current;
    if (workflow.isRunning()) return Promise.resolve(null);
    const seconds = settingsRef.current.recordingSeconds;
    return workflow.run({ nSamples: Math.round(seconds * 8000), analysis: long ? SELECTION.NO_INHALATION : SELECTION.INHALATION });
  }, []);

  const dismissRecording = useCallback(() => workflowRef.current.reset(), []);

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
        deviceInfo,
        batteryLevel,
        setDeviceConnected,
        setDeviceDisconnected,
        connectDevice,
        disconnectDevice,
        recordingState,
        startOnBoardRecording,
        startEvent,
        dismissRecording,
        settings,
        updateSettings,
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
