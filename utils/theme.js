/**
 * theme.js — Central design tokens for the Smart Inhaler app.
 * Edit here to restyle the entire app.
 */

export const COLORS = {
  // Backgrounds
  background: "#0F1117",
  surface: "#1A1D27",
  surfaceAlt: "#222636",
  border: "#2A2E3E",

  // Brand
  primary: "#4F8EF7",        // blue
  primaryLight: "#7EB2FF",
  primaryDark: "#2B6BE0",

  // Semantic
  success: "#34D399",        // green — Correct
  danger: "#F87171",         // red — Incorrect
  warning: "#FBBF24",        // yellow — Interrupted / warnings
  info: "#60A5FA",

  // Text
  text: "#F1F5F9",
  textSecondary: "#94A3B8",
  textMuted: "#64748B",

  // Source tags
  tagSim: "#7C3AED",
  tagBle: "#0EA5E9",
};

export const FONT = {
  regular: "System",
  weight: {
    normal: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
  },
};

export const RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  full: 9999,
};

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

export const SHADOW = {
  card: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
};
