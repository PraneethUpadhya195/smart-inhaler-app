import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  TouchableOpacity,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppContext } from "../context/AppContext";
import { COLORS, SPACING, RADIUS, SHADOW } from "../utils/theme";

export default function SettingsScreen() {
  const { userId } = useAppContext();

  const [remindersEnabled, setRemindersEnabled] = useState(false);
  const [morningReminder, setMorningReminder] = useState(true);
  const [eveningReminder, setEveningReminder] = useState(true);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* Reminders Section */}
      <SectionHeader title="Reminders" icon="notifications-outline" />
      <View style={[styles.card, SHADOW.card]}>
        <SettingRow
          label="Enable Reminders"
          description="Get notified when it's time for your dose"
          value={remindersEnabled}
          onValueChange={setRemindersEnabled}
        />
        <View style={styles.divider} />
        <SettingRow
          label="Morning Dose"
          description="Reminder at 8:00 AM"
          value={morningReminder}
          onValueChange={setMorningReminder}
          disabled={!remindersEnabled}
        />
        <View style={styles.divider} />
        <SettingRow
          label="Evening Dose"
          description="Reminder at 8:00 PM"
          value={eveningReminder}
          onValueChange={setEveningReminder}
          disabled={!remindersEnabled}
        />
      </View>

      {/* Feedback Section */}
      <SectionHeader title="Device Feedback" icon="hardware-chip-outline" />
      <View style={[styles.card, SHADOW.card]}>
        <SettingRow
          label="Vibration"
          description="Vibrate on session complete"
          value={vibrationEnabled}
          onValueChange={setVibrationEnabled}
        />
      </View>

      {/* Personalization — placeholder */}
      <SectionHeader title="Personalization" icon="person-outline" />
      <View style={[styles.card, SHADOW.card]}>
        <PlaceholderRow label="Daily Dose Target" value="4 doses" />
        <View style={styles.divider} />
        <PlaceholderRow label="Inhalation Duration Goal" value="5 seconds" />
        <View style={styles.divider} />
        <PlaceholderRow label="Minimum Quality Score" value="70%" />
      </View>

      {/* Account */}
      <SectionHeader title="Account" icon="shield-checkmark-outline" />
      <View style={[styles.card, SHADOW.card]}>
        <View style={styles.accountRow}>
          <View>
            <Text style={styles.accountLabel}>Anonymous User ID</Text>
            <Text style={styles.accountId} numberOfLines={1} ellipsizeMode="middle">
              {userId || "Loading…"}
            </Text>
          </View>
          <View style={styles.anonBadge}>
            <Text style={styles.anonBadgeText}>ANON</Text>
          </View>
        </View>
        <Text style={styles.accountNote}>
          Your data is stored privately using Firebase Anonymous Authentication. 
          Account linking will be available in a future update.
        </Text>
      </View>

      {/* About */}
      <SectionHeader title="About" icon="information-circle-outline" />
      <View style={[styles.card, SHADOW.card]}>
        <PlaceholderRow label="App Version" value="1.0.0-beta" />
        <View style={styles.divider} />
        <PlaceholderRow label="BLE Protocol" value="Simulated (v0)" />
        <View style={styles.divider} />
        <PlaceholderRow label="Target Device" value="ESP32 BLE Inhaler" />
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

  footer: { textAlign: "center", color: COLORS.textMuted, fontSize: 12, marginTop: SPACING.md },
});
