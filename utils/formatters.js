/**
 * formatters.js — Shared date/number formatting helpers.
 *
 * Updated to support PRISM session schema (ARCHITECTURE.md §10).
 */

/**
 * Formats a Date into a readable timestamp string.
 * e.g. "Apr 26, 2025 · 08:42 PM"
 */
export function formatTimestamp(date) {
  if (!date) return "—";
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Formats duration in seconds to a readable string.
 * e.g. 4.2 → "4.2s"
 */
export function formatDuration(seconds) {
  if (seconds == null) return "—";
  return `${Number(seconds).toFixed(1)}s`;
}

/**
 * Formats milliseconds to a readable duration string.
 * e.g. 2340 → "2.3s", 280 → "0.28s"
 */
export function formatMs(ms) {
  if (ms == null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/**
 * Formats a composite_label into a user-friendly display string.
 * e.g. "GOOD_BUT_INCONSISTENT" → "Inconsistent"
 */
const LABEL_DISPLAY = {
  GOOD: "Good",
  POOR: "Poor",
  GOOD_BUT_INCONSISTENT: "Inconsistent",
  ABNORMAL: "Abnormal",
  MISSED_DOSE: "Missed Dose",
};

export function formatCompositeLabel(label) {
  if (!label) return "—";
  return LABEL_DISPLAY[label] || label;
}

/**
 * Formats a deviation_flag into a user-friendly display string.
 * e.g. "within_baseline" → "Within Baseline"
 */
const DEVIATION_DISPLAY = {
  within_baseline: "Within Baseline",
  mild_deviation: "Mild Deviation",
  significant_deviation: "Significant Deviation",
};

export function formatDeviationFlag(flag) {
  if (!flag) return "—";
  return DEVIATION_DISPLAY[flag] || flag;
}

/**
 * Derives a list of human-readable technique issue descriptions
 * from event_classification and technique_flags.
 * Returns an empty array when the session has no issues.
 */
export function deriveIssues(event_classification, technique_flags) {
  const issues = [];
  if (!event_classification) return issues;

  if (technique_flags?.missed_dose || !event_classification.drug_detected) {
    issues.push("No drug actuation detected");
  }
  if (technique_flags?.insufficient_inhale) {
    issues.push("Inhalation too short (< 1.0s)");
  }
  if (technique_flags?.late_actuation) {
    issues.push("Late actuation (> 0.5s delay)");
  }
  if (event_classification.drug_detected && !event_classification.pre_exhale_detected) {
    issues.push("No pre-inhalation exhale");
  }

  return issues;
}

/**
 * Returns count of today's complete sessions from a sessions array.
 */
export function getTodayCompletedCount(sessions) {
  const today = new Date();
  return sessions.filter((s) => {
    // Valid session if it was processed by pipeline
    if (!["SCORED", "HAS_ERRORS", "EVENTS_DETECTED_NOT_SCOREABLE", "NO_INHALATIONS", "complete"].includes(s.status)) {
        return false;
    }
    const ts = s.timestamp instanceof Date ? s.timestamp : new Date(s.timestamp);
    return (
      ts.getDate() === today.getDate() &&
      ts.getMonth() === today.getMonth() &&
      ts.getFullYear() === today.getFullYear()
    );
  }).length;
}
