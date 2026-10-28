import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { COLORS, SPACING, RADIUS, SHADOW } from "../utils/theme";

/**
 * TrendsCard — Start Event sessions with the PRISM device and the inhalations detected in their
 * analysis, per day over the last two weeks (utils/trendsView.js), from the stored sessions only.
 * Counts, not scores.
 *
 * @param {{ trends: Object }} props - describeTrends() result
 */
export default function TrendsCard({ trends }) {
  const { days, totals, maxCount } = trends;
  return (
    <View style={[styles.card, SHADOW.card]}>
      <Text style={styles.sectionTitle}>Last 14 days</Text>
      <View style={styles.chart}>
        {days.map((d) => (
          <View key={d.key} style={styles.column}>
            <View style={styles.bars}>
              <View style={[styles.bar, styles.barDevice, { height: `${(d.device / maxCount) * 100}%` }]} />
              <View style={[styles.bar, styles.barEvents, { height: `${(d.inhalations / maxCount) * 100}%` }]} />
            </View>
          </View>
        ))}
      </View>
      <View style={styles.axis}>
        <Text style={styles.axisText}>{days[0]?.label}</Text>
        <Text style={styles.axisText}>{days[days.length - 1]?.label}</Text>
      </View>
      <View style={styles.legend}>
        <Swatch color={COLORS.primary} label={`Device recordings (${totals.device})`} />
        <Swatch color={COLORS.success} label={`Inhalations detected (${totals.inhalations})`} />
      </View>
      <Text style={styles.small}>
        All time: {totals.device} device recording{totals.device === 1 ? "" : "s"}, {totals.inhalations} inhalation
        {totals.inhalations === 1 ? "" : "s"} detected, {totals.scoreable} measurable. Not counted:{" "}
        {totals.excluded ? `${totals.excluded} other device recording${totals.excluded === 1 ? "" : "s"}, ` : ""}{totals.demo} demo,{" "}
        {totals.simulated} simulated{totals.legacy ? `, ${totals.legacy} legacy` : ""}.
      </Text>
    </View>
  );
}

function Swatch({ color, label }) {
  return (
    <View style={styles.swatchRow}>
      <View style={[styles.swatch, { backgroundColor: color }]} />
      <Text style={styles.small}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    marginHorizontal: SPACING.md,
    marginBottom: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: SPACING.xs,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: SPACING.xs,
  },
  chart: { flexDirection: "row", height: 72, alignItems: "flex-end", gap: 3 },
  column: { flex: 1, height: "100%" },
  bars: { flex: 1, flexDirection: "row", alignItems: "flex-end", gap: 1 },
  bar: { flex: 1, borderTopLeftRadius: 2, borderTopRightRadius: 2, minHeight: 0 },
  barDevice: { backgroundColor: COLORS.primary },
  barEvents: { backgroundColor: COLORS.success },
  axis: { flexDirection: "row", justifyContent: "space-between" },
  axisText: { fontSize: 11, color: COLORS.textMuted },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.md, marginTop: SPACING.xs },
  swatchRow: { flexDirection: "row", alignItems: "center", gap: SPACING.xs },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  small: { fontSize: 12, color: COLORS.textMuted, lineHeight: 18 },
});
