import React from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppContext } from "../context/AppContext";
import ResultBadge from "../components/ResultBadge";
import StatusTag from "../components/StatusTag";
import RecordingPanel from "../components/RecordingPanel";
import { COLORS, SPACING, RADIUS, SHADOW } from "../utils/theme";
import { formatTimestamp } from "../utils/formatters";
import { describeSession, describeSyncStatus } from "../utils/sessionView";
import { describeBaselineSummary } from "../utils/researchView";

export default function DashboardScreen({ navigation }) {
  const {
    sessions, deviceStatus, deviceName, syncStatus, syncNow, localStoreError,
    recordingState, startEvent, dismissRecording, settings, demoBaseline,
  } = useAppContext();
  // Read-only view of the stored baseline; AppContext updates it when a session is stored or it is reset.
  const baseline = describeBaselineSummary(demoBaseline);

  function openSession(id, fallback) {
    const session = sessions.find((s) => s.id === id) ?? fallback;
    if (!session) return;
    navigation.navigate("History", { screen: "SessionDetail", params: { session }, initial: false });
  }

  function handleViewRecordingResult() {
    const { sessionId, record } = recordingState;
    openSession(sessionId, record ? { ...record, id: sessionId, timestamp: new Date(), sync: { state: "pending" } } : null);
  }

  const lastSession = sessions[0] || null;
  const pendingCount = sessions.filter((s) => s.sync?.state === "pending").length;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* Header greeting */}
      <View style={styles.header}>
        <Text style={styles.greeting}>Good {getTimeOfDay()}</Text>
        <Text style={styles.subtitle}>Here's your inhaler summary</Text>
      </View>

      {/* Device status banner (real BLE state) */}
      <TouchableOpacity
        style={[styles.deviceBanner, { borderColor: deviceStatus === "Connected" ? COLORS.success : COLORS.border }]}
        onPress={() => navigation.navigate("Device")}
        activeOpacity={0.8}
      >
        <Ionicons
          name={deviceStatus === "Connected" ? "bluetooth" : "bluetooth-outline"}
          size={16}
          color={deviceStatus === "Connected" ? COLORS.success : COLORS.textMuted}
        />
        <Text style={[styles.deviceBannerText, { color: deviceStatus === "Connected" ? COLORS.success : COLORS.textMuted }]}>
          {deviceStatus === "Connected"
            ? `Connected to ${deviceName ?? "PRISM device"}`
            : deviceStatus === "Connecting" ? "Connecting…" : "No device connected"}
        </Text>
        <Ionicons name="chevron-forward" size={14} color={COLORS.textMuted} style={styles.bannerChevron} />
      </TouchableOpacity>

      {/* Primary action: record with the PRISM device */}
      <RecordingPanel
        state={recordingState}
        deviceStatus={deviceStatus}
        deviceName={deviceName}
        recordingSeconds={settings.recordingSeconds}
        onStart={() => startEvent({ long: false })}
        onStartLong={() => startEvent({ long: true })}
        onConnect={() => navigation.navigate("Device")}
        onViewResult={handleViewRecordingResult}
        onDismiss={dismissRecording}
      />

      {/* Cloud sync card */}
      <View style={[styles.card, SHADOW.card]}>
        <Text style={styles.cardTitle}>Cloud Sync</Text>
        <Text style={styles.syncText}>{describeSyncStatus(syncStatus, pendingCount)}</Text>
        {localStoreError && <Text style={styles.errorText}>{localStoreError}</Text>}
        <TouchableOpacity
          style={[styles.syncBtn, syncStatus.running && styles.btnDisabled]}
          onPress={() => syncNow()}
          disabled={syncStatus.running}
          activeOpacity={0.8}
        >
          {syncStatus.running ? (
            <ActivityIndicator color={COLORS.primary} />
          ) : (
            <>
              <Ionicons name="cloud-upload-outline" size={18} color={COLORS.primary} />
              <Text style={styles.syncBtnText}>Sync now</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* Last Session Card */}
      <View style={[styles.card, SHADOW.card]}>
        <Text style={styles.cardTitle}>Last Session</Text>
        {lastSession ? (
          <LastSessionContent session={lastSession} onOpen={() => openSession(lastSession.id, lastSession)} />
        ) : (
          <Text style={styles.emptyText}>No sessions yet. Record with the PRISM device above.</Text>
        )}
      </View>

      {/* Personal Baseline summary (utils/researchView.describeBaselineSummary; reset is on the session screen) */}
      <View style={[styles.card, SHADOW.card]}>
        <Text style={styles.cardTitle}>Personal Baseline</Text>
        <Text style={styles.syncText}>{baseline?.stateLabel ?? "—"}</Text>
        {baseline && <Text style={styles.description}>{baseline.explanation}</Text>}
        {baseline?.error && <Text style={styles.errorText}>{baseline.error}</Text>}
        {baseline?.initialized && (
          <View>
            <SummaryRow label="Eligible sessions processed" value={String(baseline.sessionsProcessed)} />
            <SummaryRow label="Unique reference recordings" value={String(baseline.uniqueReferences)} />
            <SummaryRow label="Most recent distance (before update)" value={baseline.lastDistance} />
            <SummaryRow label="Last updated" value={baseline.lastUpdated ?? "—"} />
          </View>
        )}
      </View>
    </ScrollView>
  );
}

function LastSessionContent({ session, onOpen }) {
  const view = describeSession(session);

  return (
    <TouchableOpacity style={styles.lastSessionContent} onPress={onOpen} activeOpacity={0.8}>
      <View style={styles.badgeRow}>
        <ResultBadge label={view.status.key} />
        <View style={styles.tagsRow}>
          <StatusTag type="source" value={view.source} />
          <StatusTag type="sync" value={view.sync.state} />
        </View>
      </View>
      <Text style={styles.timestamp}>{formatTimestamp(view.savedAt)}</Text>
      {!view.legacy && <Text style={styles.description}>{view.status.description}</Text>}
      {view.problems.map((p, i) => (
        <Text key={i} style={styles.errorText}>{p.text}</Text>
      ))}
      {view.counts && (
        <View style={styles.statsRow}>
          <MiniStat icon="albums-outline" value={view.counts.recordings} label="Recordings" />
          <MiniStat icon="pulse-outline" value={view.counts.events} label="Events" />
          <MiniStat icon="remove-circle-outline" value={view.counts.notScoreable} label="Not scoreable" />
        </View>
      )}
    </TouchableOpacity>
  );
}

function MiniStat({ icon, value, label }) {
  return (
    <View style={styles.miniStat}>
      <Ionicons name={icon} size={18} color={COLORS.primary} />
      <Text style={styles.miniStatValue}>{value ?? "—"}</Text>
      <Text style={styles.miniStatLabel}>{label}</Text>
    </View>
  );
}

function SummaryRow({ label, value }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.md, paddingBottom: SPACING.xl },

  header: { marginBottom: SPACING.md },
  greeting: { fontSize: 24, fontWeight: "700", color: COLORS.text },
  subtitle: { fontSize: 14, color: COLORS.textSecondary, marginTop: 2 },

  deviceBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.xs,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    padding: SPACING.sm + 2,
    marginBottom: SPACING.md,
  },
  deviceBannerText: { fontSize: 13, fontWeight: "500", flex: 1 },
  bannerChevron: { marginLeft: "auto" },

  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: SPACING.md,
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
  },

  lastSessionContent: { gap: SPACING.sm },
  badgeRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  tagsRow: { flexDirection: "row", gap: SPACING.xs },
  timestamp: { fontSize: 12, color: COLORS.textMuted },
  description: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 19 },
  errorText: { fontSize: 13, color: COLORS.warning, lineHeight: 19 },

  syncText: { fontSize: 14, color: COLORS.text, lineHeight: 20 },
  syncBtn: {
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.primary,
    padding: SPACING.sm,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: SPACING.xs,
  },
  syncBtnText: { color: COLORS.primary, fontSize: 14, fontWeight: "700" },

  statsRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: SPACING.xs,
  },
  miniStat: { alignItems: "center", gap: 4 },
  miniStatValue: { fontSize: 18, fontWeight: "700", color: COLORS.text },
  miniStatLabel: { fontSize: 11, color: COLORS.textMuted },

  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: SPACING.sm,
  },
  summaryLabel: { color: COLORS.textSecondary, fontSize: 14, flexShrink: 1 },
  summaryValue: { color: COLORS.text, fontSize: 14, fontWeight: "600" },

  emptyText: { color: COLORS.textMuted, fontSize: 14, textAlign: "center", paddingVertical: SPACING.md },

  btnDisabled: { opacity: 0.6 },

});
