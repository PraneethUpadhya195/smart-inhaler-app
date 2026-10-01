import React from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import ResultBadge from "../components/ResultBadge";
import IssueList from "../components/IssueList";
import StatusTag from "../components/StatusTag";
import { COLORS, SPACING, RADIUS, SHADOW } from "../utils/theme";
import {
  formatTimestamp,
  formatDuration,
  formatMs,
  formatDeviationFlag,
} from "../utils/formatters";

export default function SessionDetailScreen({ route }) {
  const { session } = route.params;
  const {
    timestamp,
    status,
    nEvents,
    nScored,
    aggregateScores,
    events,
    errors,
    source,
    deviceId
  } = session;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* Errors warning banner */}
      {errors && errors.length > 0 && (
        <View style={styles.warningBanner}>
          <Text style={styles.warningIcon}>⚠️</Text>
          <Text style={styles.warningText}>
            This session contained recording errors: {errors.map(e => e.error).join(', ')}
          </Text>
        </View>
      )}

      {/* Result + tags */}
      <View style={[styles.card, SHADOW.card]}>
        <Row label="Result">
          <ResultBadge label={status} />
        </Row>
        <Row label="Source">
          <StatusTag type="source" value={source} />
        </Row>
        <Row label="Timestamp">
          <Text style={styles.value}>{formatTimestamp(timestamp)}</Text>
        </Row>
      </View>

      {/* Aggregate Assessment */}
      <View style={[styles.card, SHADOW.card]}>
        <Text style={styles.sectionTitle}>Session Aggregates</Text>
        <View style={styles.metricsGrid}>
          <MetricBox
            label="Total Events"
            value={nEvents || 0}
          />
          <MetricBox
            label="Scored"
            value={nScored || 0}
          />
        </View>
        {aggregateScores && (
          <View style={styles.metricsGrid}>
            <MetricBox
              label="Mean Score"
              value={aggregateScores.mean.toFixed(2)}
              color={COLORS.primary}
            />
            <MetricBox
              label="Max Score"
              value={aggregateScores.max.toFixed(2)}
            />
          </View>
        )}
      </View>

      {/* Individual Events */}
      {events && events.length > 0 && (
        <View style={[styles.card, SHADOW.card]}>
          <Text style={styles.sectionTitle}>Detected Events</Text>
          {events.map((ev, idx) => (
            <View key={idx} style={{ marginBottom: SPACING.md, paddingBottom: SPACING.sm, borderBottomWidth: 1, borderColor: COLORS.border }}>
              <Text style={{ fontWeight: '700', marginBottom: SPACING.xs }}>Event {ev.eventId} ({ev.status})</Text>
              
              <DetailRow
                icon="time-outline"
                label="Timeline"
                value={`${formatDuration(ev.startTime)} to ${formatDuration(ev.endTime)}`}
              />
              <DetailRow
                icon="resize-outline"
                label="Duration"
                value={formatDuration(ev.durationS)}
              />
              <DetailRow
                icon="analytics-outline"
                label="Model Confidence"
                value={`${Math.round(ev.detectorConfidence * 100)}%`}
              />
              
              {ev.status === 'SCORE_ONLY' && (
                <DetailRow
                  icon="stats-chart-outline"
                  label="Anomaly Score"
                  value={ev.anomalyScore?.toFixed(3)}
                  valueColor={COLORS.primary}
                />
              )}
              {ev.status === 'NOT_SCOREABLE' && ev.notScoreableReasons && (
                <View style={{ marginTop: SPACING.xs }}>
                  <Text style={{ fontSize: 12, color: COLORS.danger }}>Excluded: {ev.notScoreableReasons.join(', ')}</Text>
                </View>
              )}
            </View>
          ))}
        </View>
      )}

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

// ─── Sub-components ───────────────────────────────────────────────────────────

function Row({ label, children }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {children}
    </View>
  );
}

function MetricBox({ label, value, color, small }) {
  return (
    <View style={styles.metricBox}>
      <Text
        style={[
          small ? styles.metricValueSmall : styles.metricValue,
          color && { color },
        ]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function DetailRow({ icon, label, value, valueColor }) {
  return (
    <View style={styles.detailRow}>
      <Ionicons name={icon} size={16} color={COLORS.textMuted} style={styles.detailIcon} />
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, valueColor && { color: valueColor }]}>{value}</Text>
    </View>
  );
}

// ─── Color helpers ────────────────────────────────────────────────────────────

function deviationColor(score) {
  if (score == null) return COLORS.textMuted;
  if (score < 1.5) return COLORS.success;
  if (score < 3.0) return COLORS.warning;
  return COLORS.danger;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

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
  valueMono: { color: COLORS.textSecondary, fontSize: 12, fontFamily: "monospace" },

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
  metricValueSmall: { fontSize: 16, fontWeight: "700", color: COLORS.text },
  metricLabel: { fontSize: 12, color: COLORS.textMuted },

  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: SPACING.xs + 2,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  detailIcon: { marginRight: SPACING.sm },
  detailLabel: { flex: 1, color: COLORS.textSecondary, fontSize: 14 },
  detailValue: { color: COLORS.text, fontSize: 14, fontWeight: "600" },

  deviceId: { color: COLORS.textSecondary, fontSize: 13, fontFamily: "monospace" },
});
