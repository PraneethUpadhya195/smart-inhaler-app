import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { COLORS, RADIUS, SPACING } from "../utils/theme";
import { formatTime } from "../utils/formatters";

/**
 * Waveform — a recording's peak envelope as bars, with the detected inhalation events shaded at
 * their start and end times (utils/sessionView event times).
 *
 * @param {{ peaks: number[], durationS: number, events: { key: string, startTime: number|null, endTime: number|null }[] }} props
 */
export default function Waveform({ peaks, durationS, events }) {
  const percent = (seconds) => `${Math.min(100, Math.max(0, (seconds / durationS) * 100))}%`;
  const shaded = events.filter((ev) => ev.startTime !== null && ev.endTime !== null && ev.endTime > ev.startTime);

  return (
    <View style={styles.container}>
      <View style={styles.plot}>
        {shaded.map((ev) => (
          <View
            key={ev.key}
            style={[styles.event, { left: percent(ev.startTime), width: percent(ev.endTime - ev.startTime) }]}
          />
        ))}
        <View style={styles.bars}>
          {peaks.map((p, i) => (
            <View key={i} style={[styles.bar, { height: `${Math.max(2, p * 100)}%` }]} />
          ))}
        </View>
      </View>
      <View style={styles.axis}>
        <Text style={styles.axisText}>0 s</Text>
        <Text style={styles.axisText}>{formatTime(durationS)}</Text>
      </View>
      <View style={styles.legend}>
        <View style={styles.legendSwatch} />
        <Text style={styles.legendText}>
          {shaded.length > 0 ? "Detected inhalation" : "No inhalation detected in this recording"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: SPACING.xs },
  plot: {
    height: 96,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surfaceAlt,
    overflow: "hidden",
  },
  event: {
    position: "absolute",
    top: 0,
    bottom: 0,
    backgroundColor: COLORS.primary + "33",
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: COLORS.primary,
  },
  bars: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 1,
  },
  bar: {
    flex: 1,
    marginHorizontal: 0.5,
    borderRadius: 1,
    backgroundColor: COLORS.textSecondary,
  },
  axis: { flexDirection: "row", justifyContent: "space-between" },
  axisText: { fontSize: 11, color: COLORS.textMuted },
  legend: { flexDirection: "row", alignItems: "center", gap: SPACING.xs },
  legendSwatch: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: COLORS.primary + "33",
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  legendText: { fontSize: 12, color: COLORS.textSecondary },
});
