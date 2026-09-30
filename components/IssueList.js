import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { COLORS, RADIUS, SPACING } from "../utils/theme";
import { deriveIssues } from "../utils/formatters";

/**
 * IssueList — renders technique issues derived from event_classification
 * and technique_flags. Shows a "No issues" message when everything is clean.
 *
 * @param {{ event_classification: Object, technique_flags: Object }} props
 */
export default function IssueList({ event_classification, technique_flags }) {
  const issues = deriveIssues(event_classification, technique_flags);

  if (issues.length === 0) {
    return (
      <View style={styles.emptyRow}>
        <Text style={styles.noIssues}>✓ No issues detected</Text>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      {issues.map((issue) => (
        <View key={issue} style={styles.tag}>
          <Text style={styles.tagText}>{issue}</Text>
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
  noIssues: {
    color: COLORS.success,
    fontSize: 13,
    fontWeight: "500",
  },
});
