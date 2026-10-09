import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { COLORS, RADIUS, SPACING } from "../utils/theme";
import { SESSION_STATUS_TEXT, LEGACY_STATUS } from "../utils/sessionView";

/**
 * ResultBadge — pill showing a session's status: one of the session states derived from the
 * contract's recording and event states (pipeline/SessionAggregator), or "LEGACY".
 * It shows states only; there is no quality, technique or clinical label.
 *
 * @param {{ label: string, size?: "sm" | "md" }} props — label: session_status (or "LEGACY")
 */
export default function ResultBadge({ label, size = "md" }) {
  const config = LABEL_CONFIG[label] || LABEL_CONFIG.default;
  const isSmall = size === "sm";

  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: config.color + "22" },
        isSmall && styles.badgeSmall,
      ]}
    >
      <View style={[styles.dot, { backgroundColor: config.color }]} />
      <Text
        style={[
          styles.text,
          { color: config.color },
          isSmall && styles.textSmall,
        ]}
      >
        {config.display}
      </Text>
    </View>
  );
}

// Neutral colours for detection states; warning/danger only for technical errors.
const LABEL_CONFIG = {
  SCORE_ONLY: { display: SESSION_STATUS_TEXT.SCORE_ONLY.label, color: COLORS.primary },
  NOT_SCOREABLE: { display: SESSION_STATUS_TEXT.NOT_SCOREABLE.label, color: COLORS.info },
  NO_INHALATION_DETECTED: { display: SESSION_STATUS_TEXT.NO_INHALATION_DETECTED.label, color: COLORS.textSecondary },
  INPUT_ERROR: { display: SESSION_STATUS_TEXT.INPUT_ERROR.label, color: COLORS.warning },
  PROCESSING_ERROR: { display: SESSION_STATUS_TEXT.PROCESSING_ERROR.label, color: COLORS.danger },
  LEGACY: { display: LEGACY_STATUS.label, color: COLORS.textMuted },
  default: { display: "—", color: COLORS.textMuted },
};

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm + 4,
    paddingVertical: SPACING.xs,
    gap: 6,
  },
  badgeSmall: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: RADIUS.full,
  },
  text: {
    fontSize: 13,
    fontWeight: "600",
  },
  textSmall: {
    fontSize: 11,
  },
});
