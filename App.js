import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { NavigationContainer, DefaultTheme } from "@react-navigation/native";
import { StatusBar } from "expo-status-bar";

import { AppProvider, useAppContext } from "./context/AppContext";
import AppNavigator from "./navigation/AppNavigator";

import { ensureSignedIn } from "./services/authService";
import { getDevice } from "./services/deviceService";
import { getLastDevice, clearLastDevice } from "./services/storageService";
import * as bleService from "./services/bleService";

import { COLORS } from "./utils/theme";

import { LogBox } from 'react-native';

LogBox.ignoreLogs([
  "AsyncStorage has been extracted from react-native and will be removed in a future release. Please install the 'async-storage' package instead",
  "expo-font: Failed to load manifest for font asset",
  "Warning: React Native CLI uses a custom Metro serializer that is not compatible with the default Metro serializer. Please update your React Native CLI configuration or use the default serializer.",
  "Componentwillunmount",
  "componentDidUpdate",
  "ReactNativeART is deprecated and will be removed in a future release",
  "Non-serializable values were found in the navigation state",
  "InteractionManager has been deprecated"
]);


// ─── Root: wrap everything in AppProvider ─────────────────────────────────────

export default function App() {
  return (
    <AppProvider>
      <AppRoot />
    </AppProvider>
  );
}

// ─── AppRoot: handles init logic, then renders navigator ──────────────────────

function AppRoot() {
  const { initUser, loadSessions, requestSync, setDeviceConnected } = useAppContext();
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      // 1. Sessions stored on this phone: no network or Firebase needed.
      try {
        await loadSessions();
      } catch (e) {
        console.error("[App] Local sessions not loaded:", e);
      } finally {
        if (!cancelled) setIsReady(true);
      }

      // 2. Cloud, in the background and best effort. Offline or without Firebase the app keeps
      //    working locally and pending sessions are uploaded by a later sync.
      requestSync("startup");
      // Sign in anonymously (Firebase SDK persists UID via AsyncStorage)
      const userId = await ensureSignedIn();
      if (cancelled || !userId) return;
      initUser(userId);

      // No seeding: a new user starts with an empty history.

      // Merge the Firestore history into the local one
      await loadSessions(userId);

      // Auto-reconnect: validate saved device against Firestore
      await attemptAutoReconnect(userId, setDeviceConnected);
    }

    initialize();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isReady) {
    return (
      <View style={styles.splash}>
        <StatusBar style="light" />
        <Text style={styles.splashTitle}>💨 Smart Inhaler</Text>
        <ActivityIndicator color={COLORS.primary} style={{ marginTop: 24 }} />
        <Text style={styles.splashSubtitle}>Initializing…</Text>
      </View>
    );
  }

  return (
    <NavigationContainer
      theme={{
        dark: true,
        fonts: DefaultTheme.fonts,
        colors: {
          primary: COLORS.primary,
          background: COLORS.background,
          card: COLORS.surface,
          text: COLORS.text,
          border: COLORS.border,
          notification: COLORS.primary,
        },
      }}
    >
      <StatusBar style="light" />
      <AppNavigator />
    </NavigationContainer>
  );
}

// ─── Auto-reconnect helper ────────────────────────────────────────────────────

async function attemptAutoReconnect(userId, setDeviceConnected) {
  try {
    const saved = await getLastDevice();
    if (!saved?.deviceId) return;

    // Validate that this device still exists under the current userId in Firestore
    const deviceDoc = await getDevice(userId, saved.deviceId);
    if (!deviceDoc) {
      // Stale — clear the saved device
      await clearLastDevice();
      console.log("[App] Saved device not found in Firestore — cleared AsyncStorage entry.");
      return;
    }

    // Simulate BLE reconnect
    const result = await bleService.connectToDevice(saved.deviceId);
    setDeviceConnected({
      deviceId: result.deviceId,
      deviceName: saved.deviceName || result.deviceName,
      batteryLevel: result.batteryLevel,
    });
    console.log("[App] Auto-reconnected to", saved.deviceId);
  } catch (e) {
    // Auto-reconnect is best-effort — don't crash the app
    console.warn("[App] Auto-reconnect failed silently:", e);
  }
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
    gap: 8,
  },
  splashTitle: {
    fontSize: 28,
    fontWeight: "700",
    color: COLORS.text,
  },
  splashSubtitle: {
    fontSize: 14,
    color: COLORS.textMuted,
    marginTop: 8,
  },
});
