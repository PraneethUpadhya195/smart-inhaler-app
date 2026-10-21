import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { COLORS, SPACING, RADIUS, SHADOW } from "../utils/theme";

/**
 * DemoBaselineCard — the Demo Baseline section of a session screen (utils/researchView.describeDemoBaseline):
 * a demonstration built from reference inhalations, separate from the Stage 9 result. Read-only, except
 * for its reset, which clears only the demo baseline (services/demoBaseline.js).
 *
 * @param {{ view: Object, onReset: () => Promise<void> }} props
 */
export default function DemoBaselineCard({ view, onReset }) {
  function confirmReset() {
    Alert.alert(
      "Reset the demo baseline?",
      "This clears only the demo baseline and its processing record. Sessions, recordings and other settings are kept.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Reset", style: "destructive", onPress: () => onReset().catch((e) => Alert.alert("Demo baseline not reset", e?.message ?? String(e))) },
      ],
    );
  }

  return (
    <View style={[styles.card, SHADOW.card]}>
      <Text style={styles.sectionTitle}>Demo Baseline</Text>
      <Text style={styles.small}>{view.explanation}</Text>
      {view.error && <Text style={styles.error}>{view.error}</Text>}
      <Row label="State" value={view.stateLabel} />
      <Row label="Eligible sessions processed" value={String(view.sessionsProcessed)} />
      <Row label="Unique reference recordings" value={String(view.uniqueReferences)} />
      <Row label="Most recent reference" value={view.lastReference} />
      <Row label="Most recent distance (before update)" value={view.lastDistance} />
      <Text style={styles.text}>{view.thisSession}</Text>
      <TouchableOpacity style={styles.resetBtn} onPress={confirmReset} activeOpacity={0.7}>
        <Text style={styles.resetText}>Reset demo baseline</Text>
      </TouchableOpacity>
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
  text: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 19 },
  small: { color: COLORS.textMuted, fontSize: 12, lineHeight: 18 },
  error: { color: COLORS.warning, fontSize: 13, lineHeight: 19 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: SPACING.sm,
  },
  rowLabel: { color: COLORS.textSecondary, fontSize: 14, flexShrink: 1 },
  rowValue: { color: COLORS.text, fontSize: 14, fontWeight: "600" },
  resetBtn: { alignItems: "center", paddingVertical: SPACING.xs },
  resetText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: "600" },
});
