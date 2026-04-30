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
import { generateMockSession } from "../services/simulationService";
import ResultBadge from "../components/ResultBadge";
import ProgressBar from "../components/ProgressBar";
import StatusTag from "../components/StatusTag";
import { COLORS, SPACING, RADIUS, SHADOW } from "../utils/theme";
import { formatDuration, getTodayCompletedCount } from "../utils/formatters";

export default function DashboardScreen() {
  const { sessions, addNewSession, deviceStatus } = useAppContext();
  const [isSimulating, setIsSimulating] = useState(false);

  const lastSession = sessions[0] || null;
  const todayCount = getTodayCompletedCount(sessions);

  async function handleSimulate() {
    setIsSimulating(true);
    try {
      const session = generateMockSession();
      await addNewSession(session);
    } catch (e) {
      Alert.alert("Error", "Failed to save session. Check your Firebase config.");
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

      {/* Dose Progress Card */}
      <View style={[styles.card, SHADOW.card]}>
        <Text style={styles.cardTitle}>Today's Doses</Text>
        <ProgressBar completed={todayCount} />
      </View>

      {/* Last Session Card */}
      <View style={[styles.card, SHADOW.card]}>
        <Text style={styles.cardTitle}>Last Inhalation</Text>
        {lastSession ? (
          <View style={styles.lastSessionContent}>
            <ResultBadge label={lastSession.label} />
            {lastSession.status === "interrupted" && (
              <StatusTag type="status" value="interrupted" />
            )}
            <View style={styles.statsRow}>
              <MiniStat
                icon="time-outline"
                value={formatDuration(lastSession.duration)}
                label="Duration"
              />
              <MiniStat
                icon="pulse-outline"
                value={lastSession.quality != null ? `${lastSession.quality}%` : "—"}
                label="Quality"
              />
              <MiniStat
                icon="warning-outline"
                value={lastSession.errors?.length ?? 0}
                label="Errors"
              />
            </View>
          </View>
        ) : (
          <Text style={styles.emptyText}>No sessions yet. Simulate one below!</Text>
        )}
      </View>

      {/* Simulate Inhalation Button */}
      <TouchableOpacity
        style={[styles.simulateBtn, isSimulating && styles.simulateBtnDisabled]}
        onPress={handleSimulate}
        disabled={isSimulating}
        activeOpacity={0.8}
      >
        {isSimulating ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            <Ionicons name="play-circle-outline" size={20} color="#fff" />
            <Text style={styles.simulateBtnText}>Simulate Inhalation</Text>
          </>
        )}
      </TouchableOpacity>

      <Text style={styles.hint}>
        Tap to generate a mock inhalation session and save it to Firestore
      </Text>
    </ScrollView>
  );
}

function MiniStat({ icon, value, label }) {
  return (
    <View style={styles.miniStat}>
      <Ionicons name={icon} size={18} color={COLORS.primary} />
      <Text style={styles.miniStatValue}>{value}</Text>
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
  simulateBtnDisabled: { opacity: 0.6 },
  simulateBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },

  hint: { textAlign: "center", color: COLORS.textMuted, fontSize: 12 },
});
