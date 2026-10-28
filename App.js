import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { NavigationContainer, DefaultTheme } from "@react-navigation/native";
import { StatusBar } from "expo-status-bar";

import { AppProvider, useAppContext } from "./context/AppContext";
import AppNavigator from "./navigation/AppNavigator";

import { ensureSignedIn } from "./services/authService";
import { getLastDevice } from "./services/storageService";
import { reconnectIfPermitted } from "./services/bleService";

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
  const { initUser, loadSessions, requestSync } = useAppContext();
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

      // 2. The last PRISM device, in the background: only if Bluetooth permissions were granted
      //    before (no prompt at start-up); the recorder reports the connection to AppContext.
      attemptAutoReconnect();

      // 3. Cloud, in the background and best effort. Offline or without Firebase the app keeps
      //    working locally and pending sessions are uploaded by a later sync.
      requestSync("startup");
      // Sign in anonymously (Firebase SDK persists UID via AsyncStorage)
      const userId = await ensureSignedIn();
      if (cancelled || !userId) return;
      initUser(userId);

      // No seeding: a new user starts with an empty history.

      // Merge the Firestore history into the local one
      await loadSessions(userId);
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

/**
 * Reconnect to the PRISM device used last (its BLE id is kept on this phone). Entries written by
 * earlier app versions (simulated devices, no BLE id) are ignored. Best effort: failures are logged.
 */
async function attemptAutoReconnect() {
  try {
    const saved = await getLastDevice();
    if (!saved?.bleId) return;
    const device = await reconnectIfPermitted(saved.bleId);
    if (device) console.log("[App] Reconnected to", device.name ?? device.deviceId);
  } catch (e) {
    console.warn("[App] Auto-reconnect failed:", e?.message ?? e);
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
