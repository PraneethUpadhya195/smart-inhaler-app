import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { NavigationContainer, DefaultTheme } from "@react-navigation/native";
import { StatusBar } from "expo-status-bar";

import { AppProvider, useAppContext } from "./context/AppContext";
import AppNavigator from "./navigation/AppNavigator";

import { signInAnonymously } from "./services/authService";
import { seedSampleData, getSessions } from "./services/sessionService";
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
  const { initUser, loadSessions, setDeviceConnected } = useAppContext();
  const [isReady, setIsReady] = useState(false);
  const [initError, setInitError] = useState(null);

  useEffect(() => {
    async function initialize() {
      try {
        // 1. Sign in anonymously (Firebase SDK persists UID via AsyncStorage)
        const userId = await signInAnonymously();
        initUser(userId);

        // 2. Seed sample data if Firestore sessions collection is empty
        await seedSampleData(userId);

        // 3. Load sessions into context
        await loadSessions(userId);

        // 4. Auto-reconnect: validate saved device against Firestore
        await attemptAutoReconnect(userId, setDeviceConnected);
      } catch (e) {
        console.error("[App] Initialization error:", e);
        setInitError(
          "Failed to connect to Firebase.\nPlease check your firebase/config.js credentials."
        );
      } finally {
        setIsReady(true);
      }
    }

    initialize();
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

  if (initError) {
    return (
      <View style={styles.splash}>
        <StatusBar style="light" />
        <Text style={styles.errorIcon}>⚠️</Text>
        <Text style={styles.errorTitle}>Configuration Error</Text>
        <Text style={styles.errorMessage}>{initError}</Text>
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
  errorIcon: { fontSize: 48 },
  errorTitle: { fontSize: 20, fontWeight: "700", color: COLORS.danger, marginTop: 8 },
  errorMessage: {
    fontSize: 14,
    color: COLORS.textMuted,
    textAlign: "center",
    lineHeight: 22,
    marginTop: 8,
  },
});
