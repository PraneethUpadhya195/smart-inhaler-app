import React, { useEffect, useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { recordingAudioUri } from "../services/audioFiles";
import { COLORS, SPACING, RADIUS } from "../utils/theme";
import { formatTime } from "../utils/formatters";

/**
 * RecordingPlayback — plays the recording the PRISM device made in a session: the WAV kept on this
 * phone (session.capture.audio.file, services/audioFiles.js). It plays nothing else: when that file
 * is not on this phone (recorded on another phone, or removed), it says so.
 *
 * @param {{ file: string }} props - capture.audio.file
 */
export default function RecordingPlayback({ file }) {
  const uri = useMemo(() => {
    try {
      return recordingAudioUri(file);
    } catch (e) {
      console.warn("[RecordingPlayback] recording not found:", e?.message ?? e);
      return null;
    }
  }, [file]);
  if (!uri) return <Text style={styles.small}>Playback is not available: the device recording is not on this phone.</Text>;
  return <Player uri={uri} />;
}

function Player({ uri }) {
  const player = useAudioPlayer({ uri });
  const status = useAudioPlayerStatus(player);

  // Back to the start when the end is reached, so that the next press plays it again.
  useEffect(() => {
    if (status.didJustFinish) {
      player.pause();
      player.seekTo(0);
    }
  }, [status.didJustFinish, player]);

  function toggle() {
    if (status.playing) {
      player.pause();
      return;
    }
    if (status.duration > 0 && status.currentTime >= status.duration - 0.05) player.seekTo(0);
    player.play();
  }

  return (
    <View style={styles.row}>
      <TouchableOpacity
        style={[styles.button, !status.isLoaded && styles.disabled]}
        onPress={toggle}
        disabled={!status.isLoaded}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? "Pause device recording" : "Play device recording"}
      >
        {status.isLoaded ? (
          <Ionicons name={status.playing ? "pause" : "play"} size={18} color="#fff" />
        ) : (
          <ActivityIndicator color="#fff" size="small" />
        )}
        <Text style={styles.buttonText}>Device recording</Text>
      </TouchableOpacity>
      <Text style={styles.time}>
        {formatTime(status.currentTime ?? 0)} / {status.duration > 0 ? formatTime(status.duration) : "—"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: SPACING.md, marginTop: SPACING.xs },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.xs,
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  disabled: { opacity: 0.6 },
  buttonText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  time: { fontSize: 12, color: COLORS.textMuted },
  small: { color: COLORS.textMuted, fontSize: 12 },
});
