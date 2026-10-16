import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, SPACING, RADIUS, SHADOW } from "../utils/theme";
import { describeRecordingState, STEPS } from "../utils/recordingView";

/**
 * RecordingPanel — the on-board recording on the Dashboard: the start button, then the real
 * lifecycle of the recording (utils/recordingView.js), its progress, and the error with the next
 * action. It never falls back to another audio source.
 *
 * @param {{ state: Object, deviceStatus: string, deviceName: string|null, recordingSeconds: number,
 *   onStart: Function, onConnect: Function, onViewResult: Function, onDismiss: Function }} props
 */
export default function RecordingPanel({ state, deviceStatus, deviceName, recordingSeconds, onStart, onConnect, onViewResult, onDismiss }) {
  const view = describeRecordingState(state);
  const connected = deviceStatus === "Connected";
  // After a lost connection: once a device is connected again, retrying is the next step.
  const showConnect = view.actions.connect && !connected;
  const showRetry = view.actions.retry || (view.actions.connect && connected);

  return (
    <View style={[styles.card, SHADOW.card, view.error && styles.cardError]}>
      <Text style={styles.cardTitle}>On-board recording</Text>

      {view.phase === "IDLE" ? (
        <>
          <Text style={styles.body}>
            {connected
              ? `${deviceName ?? "PRISM device"} is connected. Press the button, then use the inhaler: the device records ${recordingSeconds} s.`
              : "Records with the PRISM inhaler device over Bluetooth. If no device is connected, the app connects to the nearest one first."}
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={onStart} activeOpacity={0.8}>
            <Ionicons name="mic-outline" size={20} color="#fff" />
            <Text style={styles.primaryBtnText}>Test On-Board Recording</Text>
          </TouchableOpacity>
          {!connected && (
            <TouchableOpacity style={styles.linkBtn} onPress={onConnect} activeOpacity={0.7}>
              <Ionicons name="bluetooth-outline" size={16} color={COLORS.primary} />
              <Text style={styles.linkBtnText}>Choose a device</Text>
            </TouchableOpacity>
          )}
        </>
      ) : (
        <>
          <View style={styles.steps}>
            {STEPS.map((step, i) => {
              const done = view.step > i || view.phase === "COMPLETED";
              const current = view.step === i && view.phase !== "COMPLETED";
              const failed = current && view.error;
              const color = failed ? COLORS.danger : done ? COLORS.success : current ? COLORS.primary : COLORS.textMuted;
              return (
                <View key={step.phase} style={styles.step}>
                  <Ionicons
                    name={failed ? "close-circle" : done ? "checkmark-circle" : current ? "ellipse" : "ellipse-outline"}
                    size={18}
                    color={color}
                  />
                  <Text style={[styles.stepLabel, { color }]}>{step.label}</Text>
                </View>
              );
            })}
          </View>

          <View style={styles.titleRow}>
            {view.active && <ActivityIndicator color={COLORS.primary} size="small" />}
            <Text style={[styles.title, view.error && { color: COLORS.danger }]}>{view.title}</Text>
          </View>
          {view.error && <Text style={styles.errorText}>{view.error.text}</Text>}
          {view.error?.reason ? <Text style={styles.reason}>{view.error.reason}</Text> : null}
          {view.detail && <Text style={styles.body}>{view.detail}</Text>}

          {view.progress && (
            <View style={styles.progressWrap}>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.round(view.progress.value * 1000) / 10}%` }]} />
              </View>
              <Text style={styles.progressLabel}>{view.progress.label}</Text>
            </View>
          )}

          <View style={styles.actions}>
            {view.actions.viewResult && <Action icon="document-text-outline" label="View result" onPress={onViewResult} filled />}
            {showRetry && <Action icon="refresh-outline" label="Try again" onPress={onStart} filled />}
            {showConnect && <Action icon="bluetooth-outline" label="Connect device" onPress={onConnect} filled />}
            {view.actions.start && view.phase === "COMPLETED" && <Action icon="mic-outline" label="Record again" onPress={onStart} />}
            {view.actions.dismiss && <Action icon="close-outline" label="Close" onPress={onDismiss} />}
          </View>
        </>
      )}
    </View>
  );
}

function Action({ icon, label, onPress, filled = false }) {
  return (
    <TouchableOpacity
      style={[styles.actionBtn, filled ? styles.actionFilled : styles.actionOutline]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <Ionicons name={icon} size={16} color={filled ? "#fff" : COLORS.primary} />
      <Text style={[styles.actionText, { color: filled ? "#fff" : COLORS.primary }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.primary + "60",
    gap: SPACING.sm,
  },
  cardError: { borderColor: COLORS.danger + "80" },
  cardTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  body: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 19 },
  primaryBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: SPACING.sm,
    marginTop: SPACING.xs,
  },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  linkBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: SPACING.xs, paddingVertical: SPACING.xs },
  linkBtnText: { color: COLORS.primary, fontSize: 13, fontWeight: "600" },

  steps: { flexDirection: "row", justifyContent: "space-between", marginVertical: SPACING.xs },
  step: { alignItems: "center", gap: 2, flex: 1 },
  stepLabel: { fontSize: 11, fontWeight: "600" },

  titleRow: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  title: { fontSize: 16, fontWeight: "700", color: COLORS.text, flexShrink: 1 },
  errorText: { fontSize: 14, color: COLORS.danger, lineHeight: 20 },
  reason: { fontSize: 12, color: COLORS.textMuted, lineHeight: 18 },

  progressWrap: { gap: SPACING.xs },
  progressTrack: { height: 8, borderRadius: RADIUS.full, backgroundColor: COLORS.surfaceAlt, overflow: "hidden" },
  progressFill: { height: 8, borderRadius: RADIUS.full, backgroundColor: COLORS.primary },
  progressLabel: { fontSize: 12, color: COLORS.textMuted },

  actions: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.sm, marginTop: SPACING.xs },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.xs,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  actionFilled: { backgroundColor: COLORS.primary },
  actionOutline: { borderWidth: 1, borderColor: COLORS.primary },
  actionText: { fontSize: 14, fontWeight: "700" },
});
