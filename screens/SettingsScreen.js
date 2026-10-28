import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  TouchableOpacity,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppContext, RECORDING_SECONDS_CHOICES } from "../context/AppContext";
import { localAudioSummary } from "../services/audioFiles";
import { PRISM_BLE } from "../services/ble/protocol";
import { COLORS, SPACING, RADIUS, SHADOW } from "../utils/theme";

export default function SettingsScreen() {
  const { userId, settings, updateSettings, deviceStatus, deviceInfo } = useAppContext();
  const [audio, setAudio] = useState(null);
  useEffect(() => {
    try {
      setAudio(localAudioSummary());
    } catch (e) {
      console.warn("[Settings] local audio not listed:", e?.message ?? e);
    }
  }, []);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* Recording */}
      <SectionHeader title="Recording" icon="mic-outline" />
      <View style={[styles.card, SHADOW.card]}>
        <View style={styles.settingRow}>
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Recording length</Text>
            <Text style={styles.settingDescription}>How long the PRISM device records after you press the button</Text>
          </View>
        </View>
        <View style={styles.choiceRow}>
          {RECORDING_SECONDS_CHOICES.map((s) => (
            <TouchableOpacity
              key={s}
              style={[styles.choice, settings.recordingSeconds === s && styles.choiceSelected]}
              onPress={() => updateSettings({ recordingSeconds: s })}
              activeOpacity={0.8}
            >
              <Text style={[styles.choiceText, settings.recordingSeconds === s && styles.choiceTextSelected]}>{s} s</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={styles.divider} />
        <SettingRow
          label="Vibration"
          description="Vibrate when a recording has been analysed"
          value={settings.vibrateOnResult}
          onValueChange={(v) => updateSettings({ vibrateOnResult: v })}
        />
        <View style={styles.divider} />
        <PlaceholderRow
          label="Raw audio on this phone"
          value={audio ? `${audio.count} recording${audio.count === 1 ? "" : "s"}, ${(audio.bytes / 1024 / 1024).toFixed(1)} MB` : "—"}
        />
        <Text style={styles.accountNote}>
          Recordings from the PRISM device are kept as audio files on this phone only. The cloud receives the analysis
          results, never the audio.
        </Text>
      </View>

      {/* Reminders: not part of this version */}
      <SectionHeader title="Reminders" icon="notifications-outline" />
      <View style={[styles.card, SHADOW.card]}>
        <Text style={[styles.accountNote, styles.noteOnly]}>Reminders are not available in this version of the app.</Text>
      </View>

      {/* Account */}
      <SectionHeader title="Account" icon="shield-checkmark-outline" />
      <View style={[styles.card, SHADOW.card]}>
        <View style={styles.accountRow}>
          <View>
            <Text style={styles.accountLabel}>Anonymous User ID</Text>
            <Text style={styles.accountId} numberOfLines={1} ellipsizeMode="middle">
              {userId || "Not signed in (offline or Firebase not configured)"}
            </Text>
          </View>
          <View style={styles.anonBadge}>
            <Text style={styles.anonBadgeText}>ANON</Text>
          </View>
        </View>
        <Text style={styles.accountNote}>
          Sessions are stored on this phone and work offline. When Firebase is reachable they
          are copied to your anonymous Firebase account. Account linking will be available in a
          future update.
        </Text>
      </View>

      {/* About */}
      <SectionHeader title="About" icon="information-circle-outline" />
      <View style={[styles.card, SHADOW.card]}>
        <PlaceholderRow label="App Version" value="1.0.0-beta" />
        <View style={styles.divider} />
        <PlaceholderRow label="BLE Protocol" value={`prism-ble-audio v${PRISM_BLE.PROTOCOL_VERSION}`} />
        <View style={styles.divider} />
        <PlaceholderRow label="Target Device" value="ESP32 + INMP441 (PRISM recorder)" />
        <View style={styles.divider} />
        <PlaceholderRow
          label="Connected device"
          value={deviceStatus === "Connected" && deviceInfo ? `${deviceInfo.name ?? deviceInfo.deviceId} · ${deviceInfo.firmware ?? "?"}` : "None"}
        />
        <View style={styles.divider} />
        <PlaceholderRow label="Analysis" value="PRISM V2 contract + Stage 9 reference" />
        <Text style={styles.accountNote}>
          The detector and the reference were developed on a research dataset recorded with a different microphone;
          they are not validated for the PRISM device. Results describe recordings, not health.
        </Text>
      </View>

      <Text style={styles.footer}>Smart Inhaler • Built with Expo + Firebase</Text>
    </ScrollView>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title, icon }) {
  return (
    <View style={styles.sectionHeader}>
      <Ionicons name={icon} size={15} color={COLORS.primary} />
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

function SettingRow({ label, description, value, onValueChange, disabled = false }) {
  return (
    <View style={[styles.settingRow, disabled && styles.disabledRow]}>
      <View style={styles.settingText}>
        <Text style={[styles.settingLabel, disabled && { color: COLORS.textMuted }]}>{label}</Text>
        {description && <Text style={styles.settingDescription}>{description}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: COLORS.border, true: COLORS.primary + "88" }}
        thumbColor={value ? COLORS.primary : COLORS.textMuted}
      />
    </View>
  );
}

function PlaceholderRow({ label, value }) {
  return (
    <View style={styles.placeholderRow}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Text style={styles.placeholderValue}>{value}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.md, paddingBottom: SPACING.xl, gap: SPACING.sm },

  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.xs,
    marginTop: SPACING.md,
    marginBottom: SPACING.xs,
    paddingHorizontal: SPACING.xs,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
  },

  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: "hidden",
  },

  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: SPACING.md,
  },
  disabledRow: { opacity: 0.45 },
  settingText: { flex: 1, marginRight: SPACING.md },
  settingLabel: { fontSize: 15, color: COLORS.text, fontWeight: "500" },
  settingDescription: { fontSize: 12, color: COLORS.textMuted, marginTop: 2 },

  divider: { height: 1, backgroundColor: COLORS.border, marginHorizontal: SPACING.md },

  choiceRow: { flexDirection: "row", gap: SPACING.sm, paddingHorizontal: SPACING.md, paddingBottom: SPACING.md },
  choice: {
    flex: 1,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: SPACING.sm,
    alignItems: "center",
  },
  choiceSelected: { borderColor: COLORS.primary, backgroundColor: COLORS.primary + "22" },
  choiceText: { color: COLORS.textSecondary, fontSize: 14, fontWeight: "600" },
  choiceTextSelected: { color: COLORS.primary },

  placeholderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: SPACING.md,
  },
  placeholderValue: { fontSize: 14, color: COLORS.textSecondary },

  accountRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: SPACING.md,
  },
  accountLabel: { fontSize: 14, color: COLORS.textSecondary, marginBottom: 4 },
  accountId: { fontSize: 12, color: COLORS.textMuted, fontFamily: "monospace", maxWidth: 220 },
  anonBadge: {
    backgroundColor: COLORS.primary + "22",
    borderRadius: RADIUS.full,
    borderWidth: 1,
    borderColor: COLORS.primary + "50",
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
  },
  anonBadgeText: { fontSize: 10, fontWeight: "700", color: COLORS.primary },
  accountNote: {
    fontSize: 12,
    color: COLORS.textMuted,
    lineHeight: 18,
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.md,
  },

  noteOnly: { paddingTop: SPACING.md },

  footer: { textAlign: "center", color: COLORS.textMuted, fontSize: 12, marginTop: SPACING.md },
});
