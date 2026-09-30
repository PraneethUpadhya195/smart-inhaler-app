/**
 * bleService.js
 *
 * Simulated BLE abstraction layer.
 *
 * FUTURE: Replace the internals of this module with react-native-ble-plx
 * calls without changing any UI code. The exported function signatures
 * must remain identical.
 *
 * Exported interface:
 *   connectToDevice(deviceId?)     → Promise<{ deviceId, deviceName, batteryLevel }>
 *   disconnectDevice()             → Promise<void>
 *   getConnectionStatus()          → "Connected" | "Disconnected"
 *   getBatteryLevel()              → number | null
 *   triggerBeep()                  → Promise<void>
 *   subscribeToInhalationEvents(callback) → unsubscribe fn
 *     callback receives: { duration, event_classification, quality_assessment, technique_flags }
 */

import { generateMockSession } from "./simulationService";

// ─── Internal State ────────────────────────────────────────────────────────────

let _connectionStatus = "Disconnected";
let _batteryLevel = null;
let _activeDeviceId = null;
let _pendingEventTimer = null; // handle for the simulated BLE event timer

// ─── Utilities ─────────────────────────────────────────────────────────────────

function generateDeviceId() {
  return "BLE-" + Math.random().toString(36).substr(2, 8).toUpperCase();
}

function generateDeviceName() {
  const models = ["SmartInhaler Pro", "BreathEase v2", "PulmoCare BLE", "InhaleX One"];
  return models[Math.floor(Math.random() * models.length)];
}

// ─── Exported API ──────────────────────────────────────────────────────────────

/**
 * Simulates connecting to a BLE inhaler device.
 * If deviceId is provided (auto-reconnect), uses it; otherwise generates a new one.
 *
 * @param {string|null} deviceId — pass existing deviceId for reconnect
 * @returns {Promise<{ deviceId: string, deviceName: string, batteryLevel: number }>}
 */
export async function connectToDevice(deviceId = null) {
  // Simulate connection delay (BLE scan + connect)
  await new Promise((resolve) => setTimeout(resolve, 1500));

  _activeDeviceId = deviceId || generateDeviceId();
  _connectionStatus = "Connected";
  _batteryLevel = Math.floor(Math.random() * 31) + 70; // 70–100%

  const deviceName = generateDeviceName();

  console.log(`[BLE] Connected to ${deviceName} (${_activeDeviceId}) — Battery: ${_batteryLevel}%`);

  return {
    deviceId: _activeDeviceId,
    deviceName,
    batteryLevel: _batteryLevel,
  };
}

/**
 * Simulates disconnecting from the BLE device.
 * Clears any pending inhalation event timer.
 */
export async function disconnectDevice() {
  if (_pendingEventTimer) {
    clearTimeout(_pendingEventTimer);
    _pendingEventTimer = null;
    console.log("[BLE] Pending inhalation event cancelled due to disconnect.");
  }

  _connectionStatus = "Disconnected";
  _batteryLevel = null;
  _activeDeviceId = null;

  console.log("[BLE] Device disconnected.");
}

/**
 * Returns the current BLE connection status.
 * @returns {"Connected" | "Disconnected"}
 */
export function getConnectionStatus() {
  return _connectionStatus;
}

/**
 * Returns the current battery level, or null if disconnected.
 * @returns {number | null}
 */
export function getBatteryLevel() {
  return _batteryLevel;
}

/**
 * Simulates triggering the device's beep/buzzer (for "Find Inhaler").
 * FUTURE: Send a BLE write command to the beep characteristic.
 */
export async function triggerBeep() {
  if (_connectionStatus !== "Connected") {
    console.warn("[BLE] triggerBeep called but device is not connected.");
    return;
  }
  console.log("[BLE] 🔔 Beep triggered on device", _activeDeviceId);
  // Simulate slight delay for the BLE write round-trip
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/**
 * Subscribes to simulated BLE inhalation events.
 * Fires the callback after a 3-second delay (simulating a user inhaling).
 *
 * If disconnectDevice() is called before the event fires, the timer is cleared
 * and the callback is NOT invoked — the caller must handle the interrupted state.
 *
 * FUTURE: Subscribe to a BLE notification characteristic here instead.
 *
 * @param {Function} callback — called with { duration, event_classification, quality_assessment, technique_flags }
 * @returns {Function} unsubscribe — call to cancel the pending event
 */
export function subscribeToInhalationEvents(callback) {
  if (_connectionStatus !== "Connected") {
    console.warn("[BLE] subscribeToInhalationEvents called but device is not connected.");
    return () => {};
  }

  let cancelled = false;

  _pendingEventTimer = setTimeout(() => {
    _pendingEventTimer = null;
    if (!cancelled) {
      const session = generateMockSession();
      console.log("[BLE] 📡 Inhalation event received:", session);
      callback({
        duration: session.duration,
        event_classification: session.event_classification,
        quality_assessment: session.quality_assessment,
        technique_flags: session.technique_flags,
        model_version: session.model_version,
        app_version: session.app_version,
      });
    }
  }, 3000); // 3s simulates a BLE inhalation event

  return function unsubscribe() {
    cancelled = true;
    if (_pendingEventTimer) {
      clearTimeout(_pendingEventTimer);
      _pendingEventTimer = null;
    }
  };
}
