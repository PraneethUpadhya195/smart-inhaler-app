/**
 * formatters.js — Shared date/number formatting helpers.
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
 * Formats an error key into a readable label.
 * e.g. "too_fast" → "Too Fast"
 */
export function formatError(errorKey) {
  return errorKey
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Returns count of today's complete sessions from a sessions array.
 */
export function getTodayCompletedCount(sessions) {
  const today = new Date();
  return sessions.filter((s) => {
    if (s.status !== "complete") return false;
    const ts = s.timestamp instanceof Date ? s.timestamp : new Date(s.timestamp);
    return (
      ts.getDate() === today.getDate() &&
      ts.getMonth() === today.getMonth() &&
      ts.getFullYear() === today.getFullYear()
    );
  }).length;
}
