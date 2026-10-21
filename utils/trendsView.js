/**
 * utils/trendsView.js — trends from the sessions actually stored (local and synced): recordings and
 * detected inhalations per day. Counts only; no score, rating or target.
 *
 * Counted: Start Event sessions only, i.e. device sessions whose explicit session.analysis_source
 * says the analysis input was a reference recording (services/analysisRecordings.js). Device
 * sessions analysed from their own audio (analysis_source "device_capture", or no analysis_source:
 * every earlier session) are counted apart as `excluded`, as are demo, simulated and legacy
 * sessions. Nothing is inferred from file names, times or event counts.
 * Pure: tested in utils/test_recording_view.js.
 */

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function sessionDate(s) {
  const raw = s?.recorded_at ?? s?.timestamp ?? null;
  const d = raw instanceof Date ? raw : raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/**
 * @param {Object[]} sessions - history items
 * @param {Object} [options]
 * @param {Date} [options.now]
 * @param {number} [options.days=14]
 * @returns {{ days: { key: string, label: string, device: number, inhalations: number, other: number }[],
 *   totals: { device: number, inhalations: number, scoreable: number, excluded: number, demo: number, simulated: number, legacy: number },
 *   maxCount: number }}
 */
export function describeTrends(sessions, { now = new Date(), days = 14 } = {}) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const buckets = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    buckets.push({ key: dayKey(d), label: `${d.getDate()}/${d.getMonth() + 1}`, device: 0, inhalations: 0, other: 0 });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  const totals = { device: 0, inhalations: 0, scoreable: 0, excluded: 0, demo: 0, simulated: 0, legacy: 0 };
  for (const s of sessions ?? []) {
    if (s?.legacy) {
      totals.legacy += 1;
      continue;
    }
    const isDevice = s?.source === "ble" && s.analysis_source?.type === "reference_recording";
    if (isDevice) {
      totals.device += 1;
      totals.inhalations += Number.isInteger(s.n_events) ? s.n_events : 0;
      totals.scoreable += Number.isInteger(s.n_scored) ? s.n_scored : 0;
    } else if (s?.source === "ble") totals.excluded += 1;
    else if (s?.simulated) totals.simulated += 1;
    else totals.demo += 1;
    const d = sessionDate(s);
    const bucket = d ? byKey.get(dayKey(d)) : null;
    if (!bucket) continue;
    if (isDevice) {
      bucket.device += 1;
      bucket.inhalations += Number.isInteger(s.n_events) ? s.n_events : 0;
    } else bucket.other += 1;
  }
  return { days: buckets, totals, maxCount: Math.max(1, ...buckets.map((b) => Math.max(b.device + b.other, b.inhalations))) };
}
