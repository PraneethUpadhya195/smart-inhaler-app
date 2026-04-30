import AsyncStorage from "@react-native-async-storage/async-storage";

const LAST_DEVICE_KEY = "@SmartInhaler:lastDevice";

/**
 * Persists the last connected device info to AsyncStorage.
 * @param {{ deviceId: string, deviceName: string }} deviceInfo
 */
export async function saveLastDevice(deviceInfo) {
  await AsyncStorage.setItem(LAST_DEVICE_KEY, JSON.stringify(deviceInfo));
}

/**
 * Retrieves the last connected device info from AsyncStorage.
 * @returns {Promise<{ deviceId: string, deviceName: string } | null>}
 */
export async function getLastDevice() {
  const raw = await AsyncStorage.getItem(LAST_DEVICE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Clears the stored last device (called when device not found in Firestore
 * or when user manually disconnects and clears history).
 */
export async function clearLastDevice() {
  await AsyncStorage.removeItem(LAST_DEVICE_KEY);
}
