/**
 * bleService.js — the app's connection to the PRISM recorder (ESP32 + INMP441) over BLE.
 *
 * One recorder per app process: services/ble/PrismRecorder.js over react-native-ble-plx
 * (services/ble/bleTransport.js). Protocol: firmware/PROTOCOL.md. Nothing here is simulated: if no
 * device is reachable, connecting fails with the reason, and no battery level is reported because
 * the hardware does not measure one.
 *
 * Exported interface (screens and AppContext):
 *   getRecorder()                    → the recorder (record(), subscribe(), ...)
 *   connectToDevice(bleId?)          → Promise<device info>  (bleId null: first PRISM device found)
 *   disconnectDevice()               → Promise<void>
 *   scanForDevices({ onUpdate })     → Promise<{ id, name, rssi }[]>
 *   identifyDevice()                 → Promise<void>  blinks the device's LED for 3 s
 *   reconnectIfPermitted(bleId)      → Promise<device|null>  quiet start-up reconnect, never prompts
 */

import { createPrismRecorder, RecorderError } from "./ble/PrismRecorder";
import { createBleTransport, scanForRecorders, hasBlePermissions } from "./ble/bleTransport";

let recorder = null;

export function getRecorder() {
  if (!recorder) recorder = createPrismRecorder({ transport: createBleTransport() });
  return recorder;
}

export async function connectToDevice(bleId = null) {
  return getRecorder().connect({ deviceId: bleId });
}

export async function disconnectDevice() {
  if (recorder?.isConnected()) await recorder.disconnect();
}

export function scanForDevices(options) {
  return scanForRecorders(options);
}

export async function identifyDevice() {
  await getRecorder().identify();
}

/**
 * Reconnect to the last device at start-up, only when the Bluetooth permissions were already
 * granted (no prompt) and the device answers within the connect timeout.
 * @returns {Promise<Object|null>}
 */
export async function reconnectIfPermitted(bleId) {
  if (!bleId || !(await hasBlePermissions())) return null;
  try {
    return await connectToDevice(bleId);
  } catch (e) {
    console.log("[bleService] last device not reconnected:", e instanceof RecorderError ? e.code : e?.message ?? e);
    return null;
  }
}
