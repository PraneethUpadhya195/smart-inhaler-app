import React from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
} from "react-native";
import { useAppContext } from "../context/AppContext";
import SessionCard from "../components/SessionCard";
import { COLORS, SPACING } from "../utils/theme";

export default function HistoryScreen({ navigation }) {
  const { sessions, isLoadingSessions } = useAppContext();

  if (isLoadingSessions) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Loading sessions…</Text>
      </View>
    );
  }

  if (sessions.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyIcon}>💨</Text>
        <Text style={styles.emptyTitle}>No sessions yet</Text>
        <Text style={styles.emptySubtitle}>Go to Dashboard and tap "Simulate Inhalation"</Text>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={sessions}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <SessionCard
          session={item}
          onPress={() => navigation.navigate("SessionDetail", { session: item })}
        />
      )}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      ListHeaderComponent={
        <Text style={styles.count}>{sessions.length} sessions total</Text>
      }
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  listContent: { paddingVertical: SPACING.md },

  centered: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: "center",
    alignItems: "center",
    gap: SPACING.sm,
    padding: SPACING.xl,
  },
  loadingText: { color: COLORS.textMuted, marginTop: SPACING.sm },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: COLORS.text },
  emptySubtitle: { fontSize: 14, color: COLORS.textMuted, textAlign: "center" },

  count: {
    fontSize: 12,
    color: COLORS.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginHorizontal: SPACING.md,
    marginBottom: SPACING.sm,
  },
});
