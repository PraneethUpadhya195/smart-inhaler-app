/**
 * utils/captureView.js — what the UI shows about how a PRISM device recording was captured and
 * received: the device, the transfer checks and the capture checks reported by the firmware.
 * It describes the measurement, not the inhalation. Pure: tested in utils/test_recording_view.js.
 */

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const int = (v) => (Number.isInteger(v) ? v : null);

/**
 * @param {Object} session - history item
 * @returns {Object|null} null for sessions not recorded with the PRISM device
 */
export function describeCapture(session) {
  const capture = session?.source === "ble" ? session.capture : null;
  if (!capture || typeof capture !== "object") return null;
  const t = capture.integrity ?? {};
  const d = capture.device_checks ?? {};
  const recovered = (int(t.live_gap_requests) ?? 0) > 0 || (int(t.resend_rounds) ?? 0) > 0;
  const checks = [];
  checks.push({
    ok: t.verified === true,
    text: t.verified === true
      ? `Received complete: ${int(t.received_samples) ?? "?"} samples in ${int(t.packets) ?? "?"} packets, checksum ${t.crc32_phone ?? "?"} matches the device`
      : "The transfer was not verified",
  });
  if (recovered) {
    checks.push({ ok: true, text: `Lost packets were sent again by the device (${int(t.live_gap_requests) ?? 0} request(s) during the recording, ${int(t.resend_rounds) ?? 0} round(s) after it)` });
  }
  if (int(d.dma_overflows) !== null) {
    checks.push({ ok: d.dma_overflows === 0, text: d.dma_overflows === 0 ? "No audio dropped by the microphone interface" : `${d.dma_overflows} microphone buffer overflow(s): audio may be missing` });
  }
  if (int(d.ring_overruns) !== null && d.ring_overruns > 0) {
    checks.push({ ok: false, text: `${d.ring_overruns} samples were overwritten before they could be sent` });
  }
  if (int(d.clipped) !== null) {
    checks.push({ ok: d.clipped === 0, text: d.clipped === 0 ? "No samples at full scale (no clipping)" : `${d.clipped} sample(s) at full scale: the sound was too loud for the microphone` });
  }
  if (typeof d.raw_or === "string" && int(d.low_byte_nonzero) !== null) {
    const aligned = d.raw_or.toLowerCase().endsWith("00") && d.low_byte_nonzero === 0;
    checks.push({ ok: aligned, text: aligned ? "Microphone data alignment check passed (24-bit data in the expected bits)" : `Unexpected bits in the microphone data (${d.raw_or})` });
  }
  return {
    deviceName: capture.device?.name ?? null,
    deviceId: capture.device?.device_id ?? session.device_id ?? null,
    firmware: capture.device?.firmware ?? null,
    microphone: capture.device?.microphone ?? null,
    recordedAt: capture.recorded_at ?? null,
    durationS: isNum(capture.duration_s) ? capture.duration_s : null,
    sampleRate: int(capture.sample_rate),
    measuredRate: isNum(d.rate_hz) ? d.rate_hz : null,
    checks,
    audioFile: capture.audio?.stored === "local_only" ? capture.audio.file : null,
    audioNote: capture.audio?.stored === "local_only"
      ? "The raw audio is kept on the phone that recorded it and is not uploaded."
      : "The raw audio was not kept.",
  };
}
