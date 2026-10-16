import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, SPACING, RADIUS, SHADOW } from "../utils/theme";
import { formatTimestamp } from "../utils/formatters";

/**
 * CaptureCard — how a PRISM device recording was captured and received (utils/captureView.js):
 * the device, the transfer verification and the firmware's capture checks.
 *
 * @param {{ capture: Object }} props - describeCapture() result
 */
export default function CaptureCard({ capture }) {
  return (
    <View style={[styles.card, SHADOW.card]}>
      <Text style={styles.sectionTitle}>Recording and transfer</Text>
      <Row label="Device" value={capture.deviceName ?? capture.deviceId ?? "—"} />
      {capture.firmware && <Row label="Firmware" value={capture.firmware} />}
      {capture.recordedAt && <Row label="Recorded" value={formatTimestamp(new Date(capture.recordedAt))} />}
      <Row label="Length" value={capture.durationS !== null ? `${capture.durationS.toFixed(1)} s` : "—"} />
      <Row
        label="Sample rate"
        value={`${capture.sampleRate ?? "—"} Hz${capture.measuredRate !== null ? ` (device clock: ${capture.measuredRate.toFixed(0)} Hz)` : ""}`}
      />
      <View style={styles.checks}>
        {capture.checks.map((c, i) => (
          <View key={i} style={styles.check}>
            <Ionicons name={c.ok ? "checkmark-circle-outline" : "alert-circle-outline"} size={16} color={c.ok ? COLORS.success : COLORS.warning} />
            <Text style={styles.checkText}>{c.text}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.note}>{capture.audioNote}</Text>
    </View>
  );
}

function Row({ label, value }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: SPACING.sm,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: SPACING.xs,
  },
  row: { flexDirection: "row", justifyContent: "space-between", gap: SPACING.md },
  rowLabel: { color: COLORS.textSecondary, fontSize: 13 },
  rowValue: { color: COLORS.text, fontSize: 13, fontWeight: "500", flexShrink: 1, textAlign: "right" },
  checks: { gap: SPACING.xs, marginTop: SPACING.xs },
  check: { flexDirection: "row", gap: SPACING.sm, alignItems: "flex-start" },
  checkText: { flex: 1, color: COLORS.textSecondary, fontSize: 12, lineHeight: 18 },
  note: { color: COLORS.textMuted, fontSize: 12, lineHeight: 18 },
});
