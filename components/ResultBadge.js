import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { COLORS, RADIUS, SPACING } from "../utils/theme";

/**
 * ResultBadge — color-coded pill for Correct / Incorrect.
 * @param {{ label: "Correct" | "Incorrect", size?: "sm" | "md" }} props
 */
export default function ResultBadge({ label, size = "md" }) {
  const isCorrect = label === "Correct";
  const isSmall = size === "sm";

  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: isCorrect ? COLORS.success + "22" : COLORS.danger + "22" },
        isSmall && styles.badgeSmall,
      ]}
    >
      <View style={[styles.dot, { backgroundColor: isCorrect ? COLORS.success : COLORS.danger }]} />
      <Text
        style={[
          styles.text,
          { color: isCorrect ? COLORS.success : COLORS.danger },
          isSmall && styles.textSmall,
        ]}
      >
        {label || "—"}
      </Text>
    </View>
  );
}

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
