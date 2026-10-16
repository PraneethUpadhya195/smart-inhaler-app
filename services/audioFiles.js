/**
 * services/audioFiles.js — raw audio of PRISM device recordings, kept on this phone only.
 *
 * Each verified recording is written as a 16-bit mono 8 kHz WAV to <documents>/recordings/<name>.wav
 * before it is analysed. The session record names the file (capture.audio.file) but contains no
 * audio, and nothing here uploads anything: raw audio never leaves the phone by default.
 */

import { Directory, File, Paths } from "expo-file-system";
import { encodeWav } from "../pipeline/wav";

const DIR_NAME = "recordings";

function directory() {
  const dir = new Directory(Paths.document, DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

const safeName = (name) => String(name).replace(/[^A-Za-z0-9_.-]/g, "_");

/**
 * @param {{ pcm: Int16Array, sampleRate: number, recordingId: string|null }} recording
 * @returns {Promise<string>} the file name
 */
export async function saveRecordingAudio(recording) {
  const name = safeName(`prism_${recording.recordingId ?? Date.now().toString(16)}_${Date.now()}.wav`);
  const file = new File(directory(), name);
  file.create({ overwrite: false });
  file.write(encodeWav(recording.pcm, recording.sampleRate));
  return name;
}

/**
 * @param {string} name - capture.audio.file of a session
 * @returns {Promise<Uint8Array|null>} the WAV bytes, or null when the file is not on this phone
 */
export async function loadRecordingAudio(name) {
  if (!name) return null;
  const file = new File(new Directory(Paths.document, DIR_NAME), safeName(name));
  if (!file.exists) return null;
  return new Uint8Array(await file.arrayBuffer());
}

/** @returns {{ count: number, bytes: number }} recordings kept on this phone */
export function localAudioSummary() {
  const dir = new Directory(Paths.document, DIR_NAME);
  if (!dir.exists) return { count: 0, bytes: 0 };
  const files = dir.list().filter((f) => f instanceof File && f.name.endsWith(".wav"));
  return { count: files.length, bytes: files.reduce((sum, f) => sum + (f.size ?? 0), 0) };
}
