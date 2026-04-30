import React from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import ResultBadge from "../components/ResultBadge";
import ErrorList from "../components/ErrorList";
import StatusTag from "../components/StatusTag";
import { COLORS, SPACING, RADIUS, SHADOW } from "../utils/theme";
import { formatTimestamp, formatDuration } from "../utils/formatters";

export default function SessionDetailScreen({ route }) {
  const { session } = route.params;
  const {
    timestamp,
    duration,
    quality,
    errors,
    label,
    source,
    status,
    deviceId,
  } = session;

  const isInterrupted = status === "interrupted";

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* Interrupted warning banner */}
      {isInterrupted && (
        <View style={styles.warningBanner}>
          <Text style={styles.warningIcon}>⚠️</Text>
          <Text style={styles.warningText}>
            This session was interrupted — the device disconnected mid-inhalation.
            Data may be incomplete.
          </Text>
        </View>
      )}

      {/* Result + tags */}
      <View style={[styles.card, SHADOW.card]}>
        <Row label="Result">
          <ResultBadge label={label || "—"} />
        </Row>
        <Row label="Source">
          <StatusTag type="source" value={source} />
        </Row>
        {isInterrupted && (
          <Row label="Status">
            <StatusTag type="status" value="interrupted" />
          </Row>
        )}
        <Row label="Timestamp">
          <Text style={styles.value}>{formatTimestamp(timestamp)}</Text>
        </Row>
      </View>

      {/* Metrics */}
      <View style={[styles.card, SHADOW.card]}>
        <Text style={styles.sectionTitle}>Metrics</Text>
        <View style={styles.metricsGrid}>
          <MetricBox label="Duration" value={formatDuration(duration)} />
          <MetricBox
            label="Quality"
            value={quality != null ? `${quality}%` : "—"}
            color={
              quality == null ? COLORS.textMuted
              : quality >= 70 ? COLORS.success
              : quality >= 40 ? COLORS.warning
              : COLORS.danger
            }
          />
        </View>
      </View>

      {/* Errors */}
      <View style={[styles.card, SHADOW.card]}>
        <Text style={styles.sectionTitle}>Errors Detected</Text>
        <ErrorList errors={errors} />
      </View>

      {/* Device info */}
      {deviceId && (
        <View style={[styles.card, SHADOW.card]}>
          <Text style={styles.sectionTitle}>Device</Text>
          <Text style={styles.deviceId}>{deviceId}</Text>
        </View>
      )}
    </ScrollView>
  );
}

function Row({ label, children }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {children}
    </View>
  );
}

function MetricBox({ label, value, color }) {
  return (
    <View style={styles.metricBox}>
      <Text style={[styles.metricValue, color && { color }]}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.md, paddingBottom: SPACING.xl, gap: SPACING.md },

  warningBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACING.sm,
    backgroundColor: COLORS.warning + "18",
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.warning + "50",
    padding: SPACING.md,
  },
  warningIcon: { fontSize: 18 },
  warningText: { flex: 1, color: COLORS.warning, fontSize: 13, lineHeight: 20 },

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

  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  rowLabel: { color: COLORS.textSecondary, fontSize: 14 },
  value: { color: COLORS.text, fontSize: 14, fontWeight: "500" },

  metricsGrid: {
    flexDirection: "row",
    gap: SPACING.md,
  },
  metricBox: {
    flex: 1,
    backgroundColor: COLORS.surfaceAlt,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    alignItems: "center",
    gap: 4,
  },
  metricValue: { fontSize: 28, fontWeight: "700", color: COLORS.text },
  metricLabel: { fontSize: 12, color: COLORS.textMuted },

  deviceId: { color: COLORS.textSecondary, fontSize: 13, fontFamily: "monospace" },
});
