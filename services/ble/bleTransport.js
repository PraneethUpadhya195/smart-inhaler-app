/**
 * services/ble/bleTransport.js — the app's BLE link to the PRISM recorder (react-native-ble-plx),
 * implementing the transport interface of services/ble/PrismRecorder.js.
 *
 * Android 12+ needs BLUETOOTH_SCAN (declared neverForLocation) and BLUETOOTH_CONNECT at run time;
 * Android 11 and older need location for BLE scanning. Permissions are requested only when the user
 * connects, never at start-up. A turned-off adapter is reported, not switched on by the app.
 */

import { PermissionsAndroid, Platform } from "react-native";
import { BleManager, ConnectionPriority, State } from "react-native-ble-plx";
import { PRISM_BLE, toBase64, fromBase64 } from "./protocol";
import { RecorderError, RECORDER_ERROR } from "./PrismRecorder";

let manager = null;
function getManager() {
  if (!manager) manager = new BleManager();
  return manager;
}

const ANDROID_12 = 31;
const scanPermissions = () => (Platform.Version >= ANDROID_12
  ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
  : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]);

/** True when the Bluetooth permissions are already granted (no prompt). */
export async function hasBlePermissions() {
  if (Platform.OS !== "android") return true;
  const results = await Promise.all(scanPermissions().map((p) => PermissionsAndroid.check(p)));
  return results.every(Boolean);
}

/** Ask for the Bluetooth permissions (prompts the user). */
export async function ensureBlePermissions() {
  if (Platform.OS !== "android") return;
  const result = await PermissionsAndroid.requestMultiple(scanPermissions());
  const denied = Object.entries(result).filter(([, v]) => v !== PermissionsAndroid.RESULTS.GRANTED).map(([k]) => k.split(".").pop());
  if (denied.length > 0) {
    throw new RecorderError(RECORDER_ERROR.PERMISSION_DENIED,
      `Bluetooth permission was not granted (${denied.join(", ")}). Allow "Nearby devices" for PRISM in the phone's settings to connect.`);
  }
}

/** Resolve when the adapter is on; otherwise throw BLUETOOTH_UNAVAILABLE. */
export async function ensureBluetoothOn(timeoutMs = 3000) {
  const ble = getManager();
  let state = await ble.state();
  if (state === State.Unknown || state === State.Resetting) {
    state = await new Promise((resolve) => {
      const timer = setTimeout(() => { sub.remove(); resolve(state); }, timeoutMs);
      const sub = ble.onStateChange((s) => {
        if (s !== State.Unknown && s !== State.Resetting) {
          clearTimeout(timer);
          sub.remove();
          resolve(s);
        }
      }, true);
    });
  }
  if (state === State.PoweredOn) return;
  const message = state === State.PoweredOff
    ? "Bluetooth is turned off. Turn it on in the phone's settings and try again."
    : state === State.Unauthorized
      ? "PRISM is not allowed to use Bluetooth. Allow \"Nearby devices\" in the phone's settings."
      : `Bluetooth is not available on this phone (${state}).`;
  throw new RecorderError(state === State.Unauthorized ? RECORDER_ERROR.PERMISSION_DENIED : RECORDER_ERROR.BLUETOOTH_UNAVAILABLE, message);
}

/**
 * Scan for PRISM recorders (devices advertising the PRISM service).
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=8000]
 * @param {boolean} [options.stopOnFirst=false]
 * @param {(found: { id: string, name: string|null, rssi: number|null }[]) => void} [options.onUpdate]
 * @returns {Promise<{ id: string, name: string|null, rssi: number|null }[]>}
 */
export async function scanForRecorders({ timeoutMs = 8000, stopOnFirst = false, onUpdate } = {}) {
  await ensureBlePermissions();
  await ensureBluetoothOn();
  const ble = getManager();
  const found = new Map();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ble.stopDeviceScan().catch?.(() => {});
      if (error) reject(error);
      else resolve([...found.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)));
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    ble.startDeviceScan([PRISM_BLE.SERVICE_UUID], { allowDuplicates: false }, (error, device) => {
      if (error) {
        finish(new RecorderError(RECORDER_ERROR.BLUETOOTH_UNAVAILABLE, `Scanning failed: ${error.message}`));
        return;
      }
      if (!device) return;
      found.set(device.id, { id: device.id, name: device.name ?? device.localName ?? null, rssi: device.rssi ?? null });
      onUpdate?.([...found.values()]);
      if (stopOnFirst) finish(null);
    });
  });
}

/** The transport for createPrismRecorder (one connection at a time). */
export function createBleTransport() {
  let device = null;
  const requireDevice = () => {
    if (!device) throw new RecorderError(RECORDER_ERROR.NOT_CONNECTED, "No device is connected.");
    return device;
  };
  return {
    async connect({ deviceId = null } = {}) {
      await ensureBlePermissions();
      await ensureBluetoothOn();
      let id = deviceId;
      if (!id) {
        const found = await scanForRecorders({ timeoutMs: 8000, stopOnFirst: true });
        if (found.length === 0) {
          throw new RecorderError(RECORDER_ERROR.DEVICE_NOT_FOUND,
            "No PRISM device found nearby. Check that it is powered and close to the phone.");
        }
        id = found[0].id;
      }
      const ble = getManager();
      try {
        const connected = await ble.connectToDevice(id, { requestMTU: PRISM_BLE.REQUESTED_MTU, timeout: 10000 });
        device = await connected.discoverAllServicesAndCharacteristics();
      } catch (e) {
        device = null;
        throw new RecorderError(RECORDER_ERROR.CONNECT_FAILED, `Could not connect to the device: ${e?.message ?? e}`);
      }
      try {
        await ble.requestConnectionPriorityForDevice(device.id, ConnectionPriority.High);
      } catch (e) {
        console.warn("[bleTransport] connection priority not raised:", e?.message ?? e);
      }
      return { id: device.id, name: device.name ?? device.localName ?? null, mtu: device.mtu };
    },
    async disconnect() {
      const d = device;
      device = null;
      if (d) await getManager().cancelDeviceConnection(d.id).catch(() => {});
    },
    async read(uuid) {
      const d = requireDevice();
      const c = await getManager().readCharacteristicForDevice(d.id, PRISM_BLE.SERVICE_UUID, uuid);
      return fromBase64(c.value ?? "");
    },
    async write(uuid, bytes) {
      const d = requireDevice();
      await getManager().writeCharacteristicWithResponseForDevice(d.id, PRISM_BLE.SERVICE_UUID, uuid, toBase64(bytes));
    },
    monitor(uuid, onValue, onError) {
      const d = requireDevice();
      const sub = getManager().monitorCharacteristicForDevice(d.id, PRISM_BLE.SERVICE_UUID, uuid, (error, c) => {
        if (error) {
          onError?.(error);
          return;
        }
        if (c?.value) onValue(fromBase64(c.value));
      });
      return () => sub.remove();
    },
    onDisconnect(callback) {
      const d = requireDevice();
      const sub = getManager().onDeviceDisconnected(d.id, () => {
        device = null;
        callback();
      });
      return () => sub.remove();
    },
  };
}
