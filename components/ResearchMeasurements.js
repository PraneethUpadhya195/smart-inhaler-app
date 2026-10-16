import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, SPACING, RADIUS, SHADOW } from "../utils/theme";

/**
 * ResearchMeasurements — the research measurements of a session (utils/researchView.js), in a
 * section that is collapsed by default and separate from the session's status and events.
 * The device caveat and the interpretation are shown before any number.
 *
 * @param {{ research: Object }} props - describeResearch() result
 */
export default function ResearchMeasurements({ research }) {
  const [open, setOpen] = useState(false);
  const measured = research.events.filter((e) => e.measured);

  return (
    <View style={[styles.card, SHADOW.card]}>
      <TouchableOpacity style={styles.header} onPress={() => setOpen(!open)} activeOpacity={0.8}>
        <Ionicons name="flask-outline" size={16} color={COLORS.textSecondary} />
        <Text style={styles.sectionTitle}>Research measurements</Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={COLORS.textMuted} style={styles.chevron} />
      </TouchableOpacity>
      {!open && (
        <Text style={styles.small}>
          Acoustic comparison with a research reference dataset ({measured.length} measured event{measured.length === 1 ? "" : "s"}).
          Not a medical result.
        </Text>
      )}
      {open && (
        <View style={styles.body}>
          {research.caveat && (
            <View style={styles.caveat}>
              <Ionicons name="warning-outline" size={16} color={COLORS.warning} />
              <Text style={styles.caveatText}>{research.caveat}</Text>
            </View>
          )}
          <Text style={styles.text}>{research.interpretation}</Text>
          {research.available && research.events.length === 0 && (
            <Text style={styles.text}>No inhalation was detected, so nothing was measured.</Text>
          )}
          {!research.available && <Text style={styles.text}>No research measurements exist for this session.</Text>}
          {research.events.map((ev) => (
            <View key={ev.key} style={styles.event}>
              <Text style={styles.eventTitle}>Event {ev.number}</Text>
              {ev.measured ? (
                <>
                  <Text style={styles.text}>Acoustic deviation: {ev.deviation}{research.referenceLimit ? ` (reference upper limit ${research.referenceLimit})` : ""}</Text>
                  <Text style={styles.text}>{ev.rangeText}{ev.reliabilityText ? `; ${ev.reliabilityText}` : ""}.</Text>
                  {ev.tailText && <Text style={styles.small}>{ev.tailText}.</Text>}
                  {ev.largestContribution && <Text style={styles.small}>Largest contribution: {ev.largestContribution}.</Text>}
                </>
              ) : (
                <Text style={styles.small}>{ev.rangeText}.</Text>
              )}
            </View>
          ))}
          {research.personal && (
            <View style={styles.event}>
              <Text style={styles.eventTitle}>Personal baseline: {research.personal.status}</Text>
              {research.personal.detail && <Text style={styles.small}>{research.personal.detail}</Text>}
              {research.personal.reasons.map((r) => (
                <Text key={r} style={styles.small}>• {r}</Text>
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: SPACING.sm,
  },
  header: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  chevron: { marginLeft: "auto" },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  body: { gap: SPACING.sm },
  caveat: {
    flexDirection: "row",
    gap: SPACING.sm,
    backgroundColor: COLORS.warning + "14",
    borderColor: COLORS.warning + "50",
    borderWidth: 1,
    borderRadius: RADIUS.md,
    padding: SPACING.sm,
  },
  caveatText: { flex: 1, color: COLORS.warning, fontSize: 12, lineHeight: 18 },
  text: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 19 },
  small: { color: COLORS.textMuted, fontSize: 12, lineHeight: 18 },
  event: { borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: SPACING.sm, gap: 2 },
  eventTitle: { color: COLORS.text, fontWeight: "700", fontSize: 13 },
});
