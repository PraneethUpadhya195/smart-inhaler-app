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
    duration,
    event_classification,
    quality_assessment,
    technique_flags,
    source,
    status,
    deviceId,
    model_version,
  } = session;

  const isInterrupted = status === "interrupted";
  const ec = event_classification || {};
  const qa = quality_assessment || {};

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
          <ResultBadge label={qa.composite_label} />
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
        {model_version && (
          <Row label="Model">
            <Text style={styles.valueMono}>{model_version}</Text>
          </Row>
        )}
      </View>

      {/* Quality Assessment */}
      <View style={[styles.card, SHADOW.card]}>
        <Text style={styles.sectionTitle}>Quality Assessment</Text>
        <View style={styles.metricsGrid}>
          <MetricBox
            label="Duration"
            value={formatDuration(duration)}
          />
        </View>
        <View style={styles.metricsGrid}>
          <MetricBox
            label="Deviation"
            value={qa.deviation_score != null ? qa.deviation_score.toFixed(1) : "—"}
            color={deviationColor(qa.deviation_score)}
          />
          <MetricBox
            label="Baseline"
            value={formatDeviationFlag(qa.deviation_flag)}
            small
          />
        </View>
      </View>

      {/* Event Classification */}
      <View style={[styles.card, SHADOW.card]}>
        <Text style={styles.sectionTitle}>Event Classification</Text>
        <DetailRow
          icon="medical-outline"
          label="Drug Detected"
          value={ec.drug_detected ? "Yes" : "No"}
          valueColor={ec.drug_detected ? COLORS.success : COLORS.danger}
        />
        <DetailRow
          icon="timer-outline"
          label="Drug Duration"
          value={formatMs(ec.drug_duration_ms)}
        />
        <DetailRow
          icon="resize-outline"
          label="Inhale Duration"
          value={formatMs(ec.inhale_duration_ms)}
        />
        <DetailRow
          icon="sync-outline"
          label="Coordination Delay"
          value={formatMs(ec.coordination_delay_ms)}
          valueColor={ec.coordination_delay_ms > 500 ? COLORS.warning : undefined}
        />
        <DetailRow
          icon="swap-vertical-outline"
          label="Pre-Exhale Detected"
          value={ec.pre_exhale_detected ? "Yes" : "No"}
          valueColor={ec.pre_exhale_detected ? COLORS.success : COLORS.warning}
        />
      </View>

      {/* Technique Issues */}
      <View style={[styles.card, SHADOW.card]}>
        <Text style={styles.sectionTitle}>Technique Issues</Text>
        <IssueList
          event_classification={event_classification}
          technique_flags={technique_flags}
        />
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
