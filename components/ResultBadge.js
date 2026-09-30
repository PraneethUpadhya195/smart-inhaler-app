import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { COLORS, RADIUS, SPACING } from "../utils/theme";

/**
 * ResultBadge — color-coded pill for PRISM composite quality labels.
 *
 * Labels: GOOD | POOR | GOOD_BUT_INCONSISTENT | ABNORMAL | MISSED_DOSE
 *
 * @param {{ label: string, size?: "sm" | "md" }} props
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

const LABEL_CONFIG = {
  GOOD: { display: "Good", color: COLORS.success },
  POOR: { display: "Poor", color: COLORS.danger },
  GOOD_BUT_INCONSISTENT: { display: "Inconsistent", color: COLORS.warning },
  ABNORMAL: { display: "Abnormal", color: COLORS.info },
  MISSED_DOSE: { display: "Missed Dose", color: COLORS.danger },
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
