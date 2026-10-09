import React from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppContext } from "../context/AppContext";
import ResultBadge from "../components/ResultBadge";
import StatusTag from "../components/StatusTag";
import { COLORS, SPACING, RADIUS, SHADOW } from "../utils/theme";
import { formatTimestamp, formatTime } from "../utils/formatters";
import { describeSession } from "../utils/sessionView";

export default function SessionDetailScreen({ route }) {
  const { sessions } = useAppContext();
  // The list entry is looked up again so the sync state stays current while the screen is open.
  const passed = route.params.session;
  const session = sessions.find((s) => s.id === passed.id) ?? passed;
  const view = describeSession(session);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* Simulated / legacy notes */}
      {view.simulated && (
        <Banner
          icon="flask-outline"
          color={COLORS.tagSim}
          text={view.note ?? "Simulated session: synthetic test audio, not a recording."}
        />
      )}
      {view.legacy && <Banner icon="archive-outline" color={COLORS.textSecondary} text={view.status.description} />}

      {/* Input / processing errors */}
      {view.problems.length > 0 && (
        <Banner
          icon="alert-circle-outline"
          color={COLORS.warning}
          text={view.problems.map((p) => p.text).join("\n")}
        />
      )}

      {/* Status + metadata */}
      <View style={[styles.card, SHADOW.card]}>
        <Row label="Status">
          <ResultBadge label={view.status.key} />
        </Row>
        {!view.legacy && <Text style={styles.description}>{view.status.description}</Text>}
        <Row label="Source">
          <Text style={styles.value}>{view.sourceLabel}</Text>
        </Row>
        <Row label="Saved">
          <Text style={styles.value}>{formatTimestamp(view.savedAt)}</Text>
        </Row>
        {view.recordedAt && (
          <Row label="Recorded">
            <Text style={styles.value}>{formatTimestamp(view.recordedAt)}</Text>
          </Row>
        )}
        <Row label="Cloud sync">
          <StatusTag type="sync" value={view.sync.state} />
        </Row>
        {view.sync.detail && <Text style={styles.small}>Last attempt: {view.sync.detail}</Text>}
      </View>

      {/* Counts */}
      {view.counts && (
        <View style={[styles.card, SHADOW.card]}>
          <Text style={styles.sectionTitle}>Summary</Text>
          <View style={styles.metricsGrid}>
            <MetricBox label="Recordings" value={view.counts.recordings} />
            <MetricBox label="Events" value={view.counts.events} />
            <MetricBox label="Not scoreable" value={view.counts.notScoreable} />
          </View>
        </View>
      )}

      {/* Individual Events */}
      {view.events.length > 0 && (
        <View style={[styles.card, SHADOW.card]}>
          <Text style={styles.sectionTitle}>Detected Events</Text>
          {view.events.map((ev) => (
            <View key={ev.key} style={styles.event}>
              <Text style={styles.eventTitle}>
                Event {ev.number}
                {ev.recordingNumber ? ` · recording ${ev.recordingNumber}` : ""} · {ev.statusLabel}
              </Text>
              <DetailRow
                icon="time-outline"
                label="Time in recording"
                value={`${formatTime(ev.startTime)} – ${formatTime(ev.endTime)}`}
              />
              <DetailRow
                icon="resize-outline"
                label="Duration"
                value={formatTime(ev.durationS)}
              />
              {ev.reasons.map((reason) => (
                <Text key={reason} style={styles.reason}>• {reason}</Text>
              ))}
            </View>
          ))}
        </View>
      )}

      {/* Device info */}
      {view.deviceId && (
        <View style={[styles.card, SHADOW.card]}>
          <Text style={styles.sectionTitle}>Device</Text>
          <Text style={styles.deviceId}>{view.deviceId}</Text>
        </View>
      )}
    </ScrollView>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Banner({ icon, color, text }) {
  return (
    <View style={[styles.banner, { backgroundColor: color + "18", borderColor: color + "50" }]}>
      <Ionicons name={icon} size={18} color={color} />
      <Text style={[styles.bannerText, { color }]}>{text}</Text>
    </View>
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

function MetricBox({ label, value }) {
  return (
    <View style={styles.metricBox}>
      <Text style={styles.metricValue} numberOfLines={1} adjustsFontSizeToFit>
        {value ?? "—"}
      </Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function DetailRow({ icon, label, value }) {
  return (
    <View style={styles.detailRow}>
      <Ionicons name={icon} size={16} color={COLORS.textMuted} style={styles.detailIcon} />
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.md, paddingBottom: SPACING.xl, gap: SPACING.md },

  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACING.sm,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    padding: SPACING.md,
  },
  bannerText: { flex: 1, fontSize: 13, lineHeight: 20 },

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
  description: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 19 },
  small: { color: COLORS.textMuted, fontSize: 12 },

  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  rowLabel: { color: COLORS.textSecondary, fontSize: 14 },
  value: { color: COLORS.text, fontSize: 14, fontWeight: "500", flexShrink: 1, textAlign: "right" },

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

  event: {
    marginBottom: SPACING.md,
    paddingBottom: SPACING.sm,
    borderBottomWidth: 1,
    borderColor: COLORS.border,
  },
  eventTitle: { fontWeight: "700", color: COLORS.text, marginBottom: SPACING.xs },
  reason: { fontSize: 12, color: COLORS.textSecondary, marginTop: SPACING.xs },

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
