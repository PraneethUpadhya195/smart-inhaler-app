import React, { useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppContext } from "../context/AppContext";
import * as bleService from "../services/bleService";
import * as deviceService from "../services/deviceService";
import * as sessionService from "../services/sessionService";
import * as storageService from "../services/storageService";
import { COLORS, SPACING, RADIUS, SHADOW } from "../utils/theme";

export default function DeviceScreen() {
  const {
    userId,
    deviceStatus,
    deviceId,
    deviceName,
    batteryLevel,
    setDeviceConnected,
    setDeviceDisconnected,
    prependSession,
  } = useAppContext();

  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isBeeping, setIsBeeping] = useState(false);

  // Track in-progress BLE session ID so we can interrupt it on disconnect
  const activeBleSessionId = useRef(null);
  const unsubscribeRef = useRef(null);

  const isConnected = deviceStatus === "Connected";

  // ─── Connect ───────────────────────────────────────────────────────────────

  async function handleConnect() {
    setIsConnecting(true);
    try {
      const { deviceId: id, deviceName: name, batteryLevel: battery } =
        await bleService.connectToDevice();

      // Save to Firestore and AsyncStorage
      await deviceService.saveDevice(userId, { deviceId: id, name });
      await storageService.saveLastDevice({ deviceId: id, deviceName: name });

      // Update context
      setDeviceConnected({ deviceId: id, deviceName: name, batteryLevel: battery });

      // Subscribe to BLE inhalation events
      unsubscribeRef.current = bleService.subscribeToInhalationEvents(
        async (eventData) => {
          // BLE session completed successfully
          if (activeBleSessionId.current) {
            await sessionService.completeBleSession(userId, activeBleSessionId.current, {
              ...eventData,
              source: "ble",
            });
            const completedSession = {
              id: activeBleSessionId.current,
              ...eventData,
              source: "ble",
              status: "complete",
              deviceId: id,
              timestamp: new Date(),
            };
            prependSession(completedSession);
            activeBleSessionId.current = null;
          }
        }
      );

      // Start tracking the BLE session in Firestore
      const sessionId = await sessionService.startBleSession(userId, id);
      activeBleSessionId.current = sessionId;
    } catch (e) {
      Alert.alert("Connection Failed", "Could not connect to device. Please try again.");
      console.error("[DeviceScreen] Connect error:", e);
    } finally {
      setIsConnecting(false);
    }
  }

  // ─── Disconnect ────────────────────────────────────────────────────────────

  async function handleDisconnect() {
    setIsDisconnecting(true);
    try {
      // Cancel pending event subscription
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }

      // If a session was in progress, mark it interrupted
      if (activeBleSessionId.current) {
        await sessionService.interruptBleSession(userId, activeBleSessionId.current, {
          duration: null,
          event_classification: null,
          quality_assessment: null,
          technique_flags: null,
        });
        const interruptedSession = {
          id: activeBleSessionId.current,
          source: "ble",
          status: "interrupted",
          deviceId,
          duration: null,
          event_classification: null,
          quality_assessment: null,
          technique_flags: null,
          timestamp: new Date(),
        };
        prependSession(interruptedSession);
        activeBleSessionId.current = null;
      }

      await bleService.disconnectDevice();
      if (deviceId) await deviceService.markDeviceInactive(userId, deviceId);

      setDeviceDisconnected();
    } catch (e) {
      Alert.alert("Error", "Failed to disconnect cleanly.");
      console.error("[DeviceScreen] Disconnect error:", e);
    } finally {
      setIsDisconnecting(false);
    }
  }

  // ─── Beep ──────────────────────────────────────────────────────────────────

  async function handleBeep() {
    setIsBeeping(true);
    try {
      await bleService.triggerBeep();
      Alert.alert("Find Inhaler", "Beep sent to device! 🔔");
    } finally {
      setIsBeeping(false);
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* Status Card */}
      <View style={[styles.statusCard, SHADOW.card, { borderColor: isConnected ? COLORS.success : COLORS.border }]}>
        <View style={[styles.statusIndicator, { backgroundColor: isConnected ? COLORS.success : COLORS.textMuted }]} />
        <View style={styles.statusText}>
          <Text style={[styles.statusLabel, { color: isConnected ? COLORS.success : COLORS.textMuted }]}>
            {deviceStatus}
          </Text>
          {isConnected && deviceName && (
            <Text style={styles.deviceNameText}>{deviceName}</Text>
          )}
          {isConnected && deviceId && (
            <Text style={styles.deviceIdText}>{deviceId}</Text>
          )}
        </View>
        {isConnected && batteryLevel != null && (
          <View style={styles.batteryContainer}>
            <Ionicons name="battery-half-outline" size={20} color={batteryLevelColor(batteryLevel)} />
            <Text style={[styles.batteryText, { color: batteryLevelColor(batteryLevel) }]}>
              {batteryLevel}%
            </Text>
          </View>
        )}
      </View>

      {/* Info row when connected */}
      {isConnected && (
        <View style={[styles.infoCard, SHADOW.card]}>
          <InfoRow icon="pulse-outline" label="Listening for inhalation events…" />
          <InfoRow icon="cloud-upload-outline" label="Sessions auto-save to Firestore" />
        </View>
      )}

      {/* Action Buttons */}
      <View style={styles.buttonGroup}>
        {!isConnected ? (
          <ActionButton
            icon="bluetooth"
            label="Connect Device"
            color={COLORS.primary}
            loading={isConnecting}
            onPress={handleConnect}
          />
        ) : (
          <>
            <ActionButton
              icon="bluetooth-outline"
              label="Disconnect Device"
              color={COLORS.danger}
              loading={isDisconnecting}
              onPress={handleDisconnect}
            />
            <ActionButton
              icon="volume-high-outline"
              label="Find Inhaler"
              color={COLORS.warning}
              loading={isBeeping}
              onPress={handleBeep}
            />
          </>
        )}
      </View>

      {/* BLE note */}
      <View style={styles.noteCard}>
        <Ionicons name="information-circle-outline" size={16} color={COLORS.textMuted} />
        <Text style={styles.noteText}>
          BLE is currently simulated. Replace <Text style={styles.codeText}>bleService.js</Text> with{" "}
          <Text style={styles.codeText}>react-native-ble-plx</Text> to connect real hardware.
        </Text>
      </View>
    </ScrollView>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ActionButton({ icon, label, color, loading, onPress }) {
  return (
    <TouchableOpacity
      style={[styles.actionBtn, { backgroundColor: color + "18", borderColor: color }]}
      onPress={onPress}
      disabled={loading}
      activeOpacity={0.75}
    >
      {loading ? (
        <ActivityIndicator color={color} />
      ) : (
        <Ionicons name={icon} size={22} color={color} />
      )}
      <Text style={[styles.actionBtnText, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function InfoRow({ icon, label }) {
  return (
    <View style={styles.infoRow}>
      <Ionicons name={icon} size={15} color={COLORS.primary} />
      <Text style={styles.infoText}>{label}</Text>
    </View>
  );
}

function batteryLevelColor(level) {
  if (level > 60) return COLORS.success;
  if (level > 30) return COLORS.warning;
  return COLORS.danger;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.md, paddingBottom: SPACING.xl, gap: SPACING.md },

  statusCard: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    borderWidth: 1.5,
    padding: SPACING.md + 4,
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.md,
  },
  statusIndicator: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  statusText: { flex: 1 },
  statusLabel: { fontSize: 18, fontWeight: "700" },
  deviceNameText: { fontSize: 14, color: COLORS.textSecondary, marginTop: 2 },
  deviceIdText: { fontSize: 11, color: COLORS.textMuted, fontFamily: "monospace", marginTop: 1 },

  batteryContainer: { alignItems: "center", gap: 2 },
  batteryText: { fontSize: 12, fontWeight: "600" },

  infoCard: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.md,
    gap: SPACING.sm,
  },
  infoRow: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  infoText: { fontSize: 13, color: COLORS.textSecondary },

  buttonGroup: { gap: SPACING.sm },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    borderRadius: RADIUS.lg,
    borderWidth: 1.5,
    padding: SPACING.md,
  },
  actionBtnText: { fontSize: 16, fontWeight: "600" },

  noteCard: {
    flexDirection: "row",
    gap: SPACING.sm,
    backgroundColor: COLORS.surfaceAlt,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    alignItems: "flex-start",
  },
  noteText: { flex: 1, fontSize: 12, color: COLORS.textMuted, lineHeight: 18 },
  codeText: { fontFamily: "monospace", color: COLORS.primaryLight },
});
