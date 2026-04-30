import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { COLORS, RADIUS, SPACING } from "../utils/theme";

/**
 * StatusTag — small badge for session source ("SIM" / "BLE")
 * and session status ("Interrupted").
 *
 * @param {{ type: "source" | "status", value: string }} props
 */
export default function StatusTag({ type, value }) {
  const config = getConfig(type, value);
  if (!config) return null;

  return (
    <View style={[styles.tag, { backgroundColor: config.bg, borderColor: config.border }]}>
      <Text style={[styles.text, { color: config.color }]}>{config.label}</Text>
    </View>
  );
}

function getConfig(type, value) {
  if (type === "source") {
    if (value === "simulation") {
      return { label: "SIM", bg: COLORS.tagSim + "22", border: COLORS.tagSim + "60", color: COLORS.tagSim };
    }
    if (value === "ble") {
      return { label: "BLE", bg: COLORS.tagBle + "22", border: COLORS.tagBle + "60", color: COLORS.tagBle };
    }
  }
  if (type === "status") {
    if (value === "interrupted") {
      return { label: "Interrupted", bg: COLORS.warning + "22", border: COLORS.warning + "60", color: COLORS.warning };
    }
    if (value === "in_progress") {
      return { label: "In Progress", bg: COLORS.info + "22", border: COLORS.info + "60", color: COLORS.info };
    }
  }
  return null;
}

const styles = StyleSheet.create({
  tag: {
    borderRadius: RADIUS.full,
    borderWidth: 1,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
  },
  text: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
});
