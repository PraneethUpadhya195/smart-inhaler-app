import React, { createContext, useContext, useState, useCallback } from "react";
import { getSessions, addSession } from "../services/sessionService";

// ─── Context ──────────────────────────────────────────────────────────────────

const AppContext = createContext(null);

// ─── Provider ──────────────────────────────────────────────────────────────────

export function AppProvider({ children }) {
  const [userId, setUserId] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);

  // Device state
  const [deviceStatus, setDeviceStatus] = useState("Disconnected");
  const [deviceId, setDeviceId] = useState(null);
  const [deviceName, setDeviceName] = useState(null);
  const [batteryLevel, setBatteryLevel] = useState(null);

  // ─── Auth ────────────────────────────────────────────────────────────────────

  const initUser = useCallback((uid) => {
    setUserId(uid);
  }, []);

  // ─── Sessions ─────────────────────────────────────────────────────────────────

  const loadSessions = useCallback(async (uid) => {
    const id = uid || userId;
    if (!id) return;
    setIsLoadingSessions(true);
    try {
      const data = await getSessions(id);
      setSessions(data);
    } finally {
      setIsLoadingSessions(false);
    }
  }, [userId]);

  /**
   * Adds a completed session to Firestore and prepends it to local state.
   * @param {Object} sessionData
   * @returns {Promise<string>} new sessionId
   */
  const addNewSession = useCallback(async (sessionData) => {
    if (!userId) return;
    const sessionId = await addSession(userId, sessionData);
    const newSession = { id: sessionId, ...sessionData, timestamp: new Date() };
    setSessions((prev) => [newSession, ...prev]);
    return sessionId;
  }, [userId]);

  /**
   * Prepends a session object that was already saved to Firestore (BLE path).
   * Used by DeviceScreen after completeBleSession / interruptBleSession.
   * @param {Object} session — must include id
   */
  const prependSession = useCallback((session) => {
    setSessions((prev) => [session, ...prev.filter((s) => s.id !== session.id)]);
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
        loadSessions,
        addNewSession,
        prependSession,
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
