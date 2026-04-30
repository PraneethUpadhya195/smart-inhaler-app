import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { COLORS, RADIUS, SPACING } from "../utils/theme";
import { formatError } from "../utils/formatters";

/**
 * ErrorList — renders an array of error keys as styled pill tags.
 * Shows a "No errors" message when the array is empty.
 * @param {{ errors: string[] }} props
 */
export default function ErrorList({ errors }) {
  if (!errors || errors.length === 0) {
    return (
      <View style={styles.emptyRow}>
        <Text style={styles.noErrors}>✓ No errors detected</Text>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      {errors.map((err) => (
        <View key={err} style={styles.tag}>
          <Text style={styles.tagText}>{formatError(err)}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: SPACING.sm,
  },
  emptyRow: {
    flexDirection: "row",
  },
  tag: {
    backgroundColor: COLORS.danger + "20",
    borderRadius: RADIUS.full,
    borderWidth: 1,
    borderColor: COLORS.danger + "50",
    paddingHorizontal: SPACING.sm + 4,
    paddingVertical: SPACING.xs,
  },
  tagText: {
    color: COLORS.danger,
    fontSize: 12,
    fontWeight: "600",
  },
  noErrors: {
    color: COLORS.success,
    fontSize: 13,
    fontWeight: "500",
  },
});
