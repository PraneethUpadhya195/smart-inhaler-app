import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { COLORS, RADIUS, SPACING, SHADOW } from "../utils/theme";
import ResultBadge from "./ResultBadge";
import StatusTag from "./StatusTag";
import { formatTimestamp, formatDuration } from "../utils/formatters";

/**
 * SessionCard — compact card for use in History list.
 * Reads from the PRISM session schema (event_classification, quality_assessment).
 *
 * @param {{ session: Object, onPress: Function }} props
 */
export default function SessionCard({ session, onPress }) {
  const { timestamp, duration, quality_assessment, source, status } = session;
  const compositeLabel = quality_assessment?.composite_label;

  return (
    <TouchableOpacity style={[styles.card, SHADOW.card]} onPress={onPress} activeOpacity={0.75}>
      {/* Top row: result badge + tags */}
      <View style={styles.topRow}>
        <ResultBadge label={compositeLabel} size="sm" />
        <View style={styles.tagsRow}>
          <StatusTag type="source" value={source} />
          {status === "interrupted" && <StatusTag type="status" value="interrupted" />}
        </View>
      </View>

      {/* Timestamp */}
      <Text style={styles.timestamp}>{formatTimestamp(timestamp)}</Text>

      {/* Stats row */}
      <View style={styles.statsRow}>
        <Stat label="Duration" value={formatDuration(duration)} />
      </View>
    </TouchableOpacity>
  );
}

function Stat({ label, value }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    marginHorizontal: SPACING.md,
    marginBottom: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: SPACING.xs + 2,
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  tagsRow: {
    flexDirection: "row",
    gap: SPACING.xs,
  },
  timestamp: {
    fontSize: 12,
    color: COLORS.textMuted,
  },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: SPACING.xs,
  },
  stat: {
    flex: 1,
    alignItems: "center",
  },
  statValue: {
    fontSize: 16,
    fontWeight: "700",
    color: COLORS.text,
  },
  statLabel: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  divider: {
    width: 1,
    height: 28,
    backgroundColor: COLORS.border,
  },
});
