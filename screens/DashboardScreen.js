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
import { runSimulatedSession } from "../services/simulationService";
import { getPipeline } from "../services/inferenceService";
import ResultBadge from "../components/ResultBadge";
import StatusTag from "../components/StatusTag";
import { COLORS, SPACING, RADIUS, SHADOW } from "../utils/theme";
import { formatTimestamp } from "../utils/formatters";
import { describeSession, describeSyncStatus } from "../utils/sessionView";

export default function DashboardScreen() {
  const { sessions, addNewSession, deviceStatus, syncStatus, syncNow, localStoreError } = useAppContext();
  const [isSimulating, setIsSimulating] = useState(false);

  const lastSession = sessions[0] || null;
  const pendingCount = sessions.filter((s) => s.sync?.state === "pending").length;

  async function handleSimulate() {
    setIsSimulating(true);
    try {
      // The real on-device pipeline on synthetic test audio. The session is stored on this
      // phone at once; the upload to Firestore runs in the background.
      const session = await runSimulatedSession(getPipeline);
      await addNewSession(session);
    } catch (e) {
      Alert.alert("Session not saved", `The session could not be stored on this phone: ${e?.message ?? e}`);
      console.error(e);
    } finally {
      setIsSimulating(false);
    }
  }

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

      {/* Device status banner */}
      <View style={[styles.deviceBanner, { borderColor: deviceStatus === "Connected" ? COLORS.success : COLORS.border }]}>
        <Ionicons
          name={deviceStatus === "Connected" ? "bluetooth" : "bluetooth-outline"}
          size={16}
          color={deviceStatus === "Connected" ? COLORS.success : COLORS.textMuted}
        />
        <Text style={[styles.deviceBannerText, { color: deviceStatus === "Connected" ? COLORS.success : COLORS.textMuted }]}>
          {deviceStatus === "Connected" ? "Device Connected" : "No Device Connected"}
        </Text>
      </View>

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
          <LastSessionContent session={lastSession} />
        ) : (
          <Text style={styles.emptyText}>No sessions yet. Run a simulated session below.</Text>
        )}
      </View>

      {/* Simulated session button */}
      <TouchableOpacity
        style={[styles.simulateBtn, isSimulating && styles.btnDisabled]}
        onPress={handleSimulate}
        disabled={isSimulating}
        activeOpacity={0.8}
      >
        {isSimulating ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            <Ionicons name="play-circle-outline" size={20} color="#fff" />
            <Text style={styles.simulateBtnText}>Run Simulated Session</Text>
          </>
        )}
      </TouchableOpacity>

      <Text style={styles.hint}>
        Runs the on-device analysis on synthetic test audio (not a recording of an inhalation).
        The session is saved on this phone and uploaded to the cloud when a connection is available.
      </Text>
    </ScrollView>
  );
}

function LastSessionContent({ session }) {
  const view = describeSession(session);

  return (
    <View style={styles.lastSessionContent}>
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
    </View>
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
  deviceBannerText: { fontSize: 13, fontWeight: "500" },

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

  emptyText: { color: COLORS.textMuted, fontSize: 14, textAlign: "center", paddingVertical: SPACING.md },

  simulateBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  btnDisabled: { opacity: 0.6 },
  simulateBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },

  hint: { textAlign: "center", color: COLORS.textMuted, fontSize: 12 },
});
