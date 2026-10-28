import React, { useState } from "react";
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
import { ERROR_TEXT } from "../utils/recordingView";
import { COLORS, SPACING, RADIUS, SHADOW } from "../utils/theme";

/**
 * DeviceScreen — the PRISM recorder (ESP32 + INMP441) over Bluetooth Low Energy: scan, connect,
 * disconnect, identify (blinks the device's LED) and the information the device reports.
 * Everything shown comes from the device; the hardware reports no battery level, so none is shown.
 */
export default function DeviceScreen() {
  const { deviceStatus, deviceInfo, connectDevice, disconnectDevice, recordingState } = useAppContext();
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState(null); // null: not scanned yet
  const [busyId, setBusyId] = useState(null);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isIdentifying, setIsIdentifying] = useState(false);
  const [error, setError] = useState(null);

  const isConnected = deviceStatus === "Connected";
  const recordingActive = !["IDLE", "COMPLETED", "ERROR"].includes(recordingState.phase);

  const describeError = (e) => (e?.code && ERROR_TEXT[e.code] ? `${ERROR_TEXT[e.code]} ${e.message ?? ""}`.trim() : e?.message ?? String(e));

  async function handleScan() {
    setScanning(true);
    setError(null);
    setFound([]);
    try {
      const devices = await bleService.scanForDevices({ timeoutMs: 6000, onUpdate: setFound });
      setFound(devices);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setScanning(false);
    }
  }

  async function handleConnect(bleId) {
    setBusyId(bleId ?? "any");
    setError(null);
    try {
      await connectDevice(bleId);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDisconnect() {
    setIsDisconnecting(true);
    try {
      await disconnectDevice();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setIsDisconnecting(false);
    }
  }

  async function handleIdentify() {
    setIsIdentifying(true);
    try {
      await bleService.identifyDevice();
      Alert.alert("Identify device", "The device's blue LED blinks for 3 seconds.");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setIsIdentifying(false);
    }
  }

  const statusColor = isConnected ? COLORS.success : deviceStatus === "Connecting" ? COLORS.primary : COLORS.textMuted;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      {/* Status Card */}
      <View style={[styles.statusCard, SHADOW.card, { borderColor: isConnected ? COLORS.success : COLORS.border }]}>
        <View style={[styles.statusIndicator, { backgroundColor: statusColor }]} />
        <View style={styles.statusText}>
          <Text style={[styles.statusLabel, { color: statusColor }]}>{deviceStatus}</Text>
          {isConnected && deviceInfo?.name && <Text style={styles.deviceNameText}>{deviceInfo.name}</Text>}
          {isConnected && deviceInfo?.deviceId && <Text style={styles.deviceIdText}>{deviceInfo.deviceId}</Text>}
        </View>
        {deviceStatus === "Connecting" && <ActivityIndicator color={COLORS.primary} />}
      </View>

      {error && (
        <View style={styles.errorCard}>
          <Ionicons name="alert-circle-outline" size={18} color={COLORS.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Device information (as reported by the device) */}
      {isConnected && deviceInfo && (
        <View style={[styles.infoCard, SHADOW.card]}>
          <InfoRow icon="hardware-chip-outline" label="Firmware" value={deviceInfo.firmware ?? "—"} />
          <InfoRow icon="mic-outline" label="Microphone" value={deviceInfo.microphone ?? "—"} />
          <InfoRow icon="pulse-outline" label="Sample rate" value={`${deviceInfo.sampleRate} Hz`} />
          <InfoRow icon="time-outline" label="Recording length" value={`${(deviceInfo.defaultSamples / deviceInfo.sampleRate).toFixed(0)} s default, up to ${deviceInfo.maxSamples ? (deviceInfo.maxSamples / deviceInfo.sampleRate).toFixed(0) : "?"} s`} />
          <InfoRow icon="swap-horizontal-outline" label="Link" value={`Protocol v${deviceInfo.protocol}, ${deviceInfo.mtu}-byte messages`} />
          <InfoRow icon="layers-outline" label="Resend buffer" value={deviceInfo.ringSamples ? `${(deviceInfo.ringSamples / deviceInfo.sampleRate).toFixed(1)} s of audio` : "—"} />
          <InfoRow icon="battery-dead-outline" label="Battery" value="Not measured by this hardware" />
        </View>
      )}

      {/* Actions */}
      <View style={styles.buttonGroup}>
        {isConnected ? (
          <>
            <ActionButton
              icon="flashlight-outline"
              label="Identify device (blink LED)"
              color={COLORS.warning}
              loading={isIdentifying}
              disabled={recordingActive}
              onPress={handleIdentify}
            />
            <ActionButton
              icon="bluetooth-outline"
              label="Disconnect device"
              color={COLORS.danger}
              loading={isDisconnecting}
              disabled={recordingActive}
              onPress={handleDisconnect}
            />
          </>
        ) : (
          <>
            <ActionButton
              icon="search-outline"
              label={scanning ? "Scanning…" : "Scan for PRISM devices"}
              color={COLORS.primary}
              loading={scanning}
              disabled={busyId !== null}
              onPress={handleScan}
            />
            <ActionButton
              icon="bluetooth"
              label="Connect to the nearest device"
              color={COLORS.primary}
              loading={busyId === "any"}
              disabled={scanning || busyId !== null}
              onPress={() => handleConnect(null)}
            />
          </>
        )}
      </View>

      {/* Scan results */}
      {!isConnected && found !== null && (
        <View style={[styles.infoCard, SHADOW.card]}>
          <Text style={styles.sectionTitle}>Devices found</Text>
          {found.length === 0 && !scanning && (
            <Text style={styles.noteText}>No PRISM device found. Check that it is powered and within a few metres.</Text>
          )}
          {found.map((d) => (
            <TouchableOpacity
              key={d.id}
              style={styles.deviceRow}
              onPress={() => handleConnect(d.id)}
              disabled={busyId !== null}
              activeOpacity={0.75}
            >
              <Ionicons name="hardware-chip-outline" size={18} color={COLORS.primary} />
              <View style={styles.deviceRowText}>
                <Text style={styles.deviceRowName}>{d.name ?? "PRISM device"}</Text>
                <Text style={styles.deviceIdText}>{d.id}{d.rssi !== null ? ` · signal ${d.rssi} dBm` : ""}</Text>
              </View>
              {busyId === d.id ? <ActivityIndicator color={COLORS.primary} /> : <Text style={styles.connectText}>Connect</Text>}
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* About the connection */}
      <View style={styles.noteCard}>
        <Ionicons name="information-circle-outline" size={16} color={COLORS.textMuted} />
        <Text style={styles.noteText}>
          The PRISM device records 8 kHz audio with its INMP441 microphone when you start a recording and sends it to
          this phone over Bluetooth Low Energy. The phone checks that every sample arrived (sample count and checksum)
          before analysing it. Android asks once for the "Nearby devices" permission.
        </Text>
      </View>
    </ScrollView>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ActionButton({ icon, label, color, loading, disabled = false, onPress }) {
  return (
    <TouchableOpacity
      style={[styles.actionBtn, { backgroundColor: color + "18", borderColor: color }, (disabled || loading) && styles.disabled]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.75}
    >
      {loading ? <ActivityIndicator color={color} /> : <Ionicons name={icon} size={22} color={color} />}
      <Text style={[styles.actionBtnText, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function InfoRow({ icon, label, value }) {
  return (
    <View style={styles.infoRow}>
      <Ionicons name={icon} size={15} color={COLORS.primary} />
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
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
  statusIndicator: { width: 14, height: 14, borderRadius: 7 },
  statusText: { flex: 1 },
  statusLabel: { fontSize: 18, fontWeight: "700" },
  deviceNameText: { fontSize: 14, color: COLORS.textSecondary, marginTop: 2 },
  deviceIdText: { fontSize: 11, color: COLORS.textMuted, fontFamily: "monospace", marginTop: 1 },

  errorCard: {
    flexDirection: "row",
    gap: SPACING.sm,
    alignItems: "flex-start",
    backgroundColor: COLORS.danger + "18",
    borderColor: COLORS.danger + "60",
    borderWidth: 1,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
  },
  errorText: { flex: 1, color: COLORS.danger, fontSize: 13, lineHeight: 19 },

  infoCard: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.md,
    gap: SPACING.sm,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  infoRow: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  infoLabel: { fontSize: 13, color: COLORS.textSecondary, width: 120 },
  infoValue: { flex: 1, fontSize: 13, color: COLORS.text, textAlign: "right" },

  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  deviceRowText: { flex: 1 },
  deviceRowName: { fontSize: 15, fontWeight: "600", color: COLORS.text },
  connectText: { color: COLORS.primary, fontWeight: "700" },

  buttonGroup: { gap: SPACING.sm },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    borderRadius: RADIUS.lg,
    borderWidth: 1.5,
    padding: SPACING.md,
  },
  disabled: { opacity: 0.5 },
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
});
