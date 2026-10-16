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
import { runDemoSession } from "../services/demoRecordings";
import { getPipeline } from "../services/inferenceService";
import ResultBadge from "../components/ResultBadge";
import StatusTag from "../components/StatusTag";
import RecordingPanel from "../components/RecordingPanel";
import { COLORS, SPACING, RADIUS, SHADOW } from "../utils/theme";
import { formatTimestamp } from "../utils/formatters";
import { describeSession, describeSyncStatus } from "../utils/sessionView";
import { PERSONAL_BLOCKER_TEXT } from "../utils/researchView";

export default function DashboardScreen({ navigation }) {
  const {
    sessions, addNewSession, deviceStatus, deviceName, syncStatus, syncNow, localStoreError,
    recordingState, startOnBoardRecording, dismissRecording, settings,
  } = useAppContext();
  const [isSimulating, setIsSimulating] = useState(false);
  const [isAnalysingDemo, setIsAnalysingDemo] = useState(false);
  const recordingActive = !["IDLE", "COMPLETED", "ERROR"].includes(recordingState.phase);
  const busy = isSimulating || isAnalysingDemo || recordingActive;
  const latestDevicePersonal = sessions.find((s) => s.source === "ble" && s.personal)?.personal ?? null;

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

  async function handleDemo() {
    setIsAnalysingDemo(true);
    try {
      // The real on-device pipeline on a reference dataset recording bundled with the app. The
      // session is stored like any other; its detail screen opens with the recording's waveform.
      const session = await runDemoSession(getPipeline);
      const id = await addNewSession(session);
      navigation.navigate("History", {
        screen: "SessionDetail",
        params: { session: { ...session, id, timestamp: new Date(), sync: { state: "pending" } } },
        initial: false,
      });
    } catch (e) {
      Alert.alert("Demo not saved", `The demo recording could not be analysed or stored: ${e?.message ?? e}`);
      console.error(e);
    } finally {
      setIsAnalysingDemo(false);
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
        onStart={() => startOnBoardRecording()}
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

      {/* Personal baseline status (research V3: not available) */}
      <View style={[styles.card, SHADOW.card]}>
        <Text style={styles.cardTitle}>Personal baseline</Text>
        <Text style={styles.syncText}>Not available</Text>
        <Text style={styles.description}>
          {PERSONAL_BLOCKER_TEXT.SITTING_DEFINITION_INCOMPATIBLE} {PERSONAL_BLOCKER_TEXT.NOT_VALIDATED}
        </Text>
        {latestDevicePersonal && Number.isInteger(latestDevicePersonal.n_sittings) && (
          <Text style={styles.timestamp}>
            This device: {latestDevicePersonal.n_sittings} sitting(s) recorded, {latestDevicePersonal.n_qualifying_sittings} of {latestDevicePersonal.s_min} would qualify.
          </Text>
        )}
      </View>

      {/* Demo and test: separate from the device recording, labelled as such */}
      <Text style={styles.sectionLabel}>Demo and test (not device recordings)</Text>

      {/* Simulated session button */}
      <TouchableOpacity
        style={[styles.simulateBtn, styles.simulateSecondary, busy && styles.btnDisabled]}
        onPress={handleSimulate}
        disabled={busy}
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

      {/* Demo recording button */}
      <TouchableOpacity
        style={[styles.simulateBtn, styles.demoBtn, busy && styles.btnDisabled]}
        onPress={handleDemo}
        disabled={busy}
        activeOpacity={0.8}
      >
        {isAnalysingDemo ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            <Ionicons name="musical-notes-outline" size={20} color="#fff" />
            <Text style={styles.simulateBtnText}>Analyse Demo Recording</Text>
          </>
        )}
      </TouchableOpacity>

      <Text style={styles.hint}>
        Runs the on-device analysis on a recording from the PRISM reference dataset that is bundled
        with the app (not recorded with this phone). The session is saved and uploaded like any other.
      </Text>
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
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: SPACING.sm,
    marginBottom: SPACING.sm,
  },

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
  demoBtn: { backgroundColor: COLORS.tagBle, marginTop: SPACING.md },
  simulateSecondary: { backgroundColor: COLORS.tagSim },
  btnDisabled: { opacity: 0.6 },
  simulateBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },

  hint: { textAlign: "center", color: COLORS.textMuted, fontSize: 12 },
});
