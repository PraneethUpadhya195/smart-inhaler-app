/**
 * formatters.js — Shared date/number formatting helpers.
 *
 * What a screen may show about a session is decided in utils/sessionView.js; these helpers only
 * format the values it provides.
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
 * Formats a time within a recording (seconds from its start) with the 0.01 s resolution
 * that event boundaries need. e.g. 1.234 → "1.23 s"
 */
export function formatTime(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return "—";
  return `${Number(seconds).toFixed(2)} s`;
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
