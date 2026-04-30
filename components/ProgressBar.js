import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { COLORS, RADIUS, SPACING } from "../utils/theme";

const DAILY_DOSE_TARGET = 4;

/**
 * ProgressBar — shows dose progress as filled/empty circles.
 * e.g. ●●○○ for 2/4 doses.
 * @param {{ completed: number, total?: number }} props
 */
export default function ProgressBar({ completed, total = DAILY_DOSE_TARGET }) {
  const clamped = Math.min(completed, total);

  return (
    <View style={styles.container}>
      <View style={styles.dotsRow}>
        {Array.from({ length: total }).map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              i < clamped ? styles.dotFilled : styles.dotEmpty,
            ]}
          />
        ))}
      </View>
      <Text style={styles.label}>
        {clamped} / {total} doses today
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    gap: SPACING.sm,
  },
  dotsRow: {
    flexDirection: "row",
    gap: SPACING.sm,
  },
  dot: {
    width: 18,
    height: 18,
    borderRadius: RADIUS.full,
  },
  dotFilled: {
    backgroundColor: COLORS.primary,
  },
  dotEmpty: {
    backgroundColor: COLORS.border,
    borderWidth: 2,
    borderColor: COLORS.textMuted,
  },
  label: {
    fontSize: 13,
    color: COLORS.textSecondary,
    fontWeight: "500",
  },
});
