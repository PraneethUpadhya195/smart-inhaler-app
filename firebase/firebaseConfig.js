import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { initializeAuth, getAuth, getReactNativePersistence } from "firebase/auth";
import ReactNativeAsyncStorage from "@react-native-async-storage/async-storage";
import { firebaseConfig } from "./config";

// Guard against re-initialization on hot reload
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

export const db = getFirestore(app);

// Firebase v12 requires explicit AsyncStorage wiring for RN persistence.
// initializeAuth() must only be called once; on hot-reload we fall back to
// getAuth() which returns the already-initialized instance.
let auth;
try {
  auth = initializeAuth(app, {
    persistence: getReactNativePersistence(ReactNativeAsyncStorage),
  });
} catch (e) {
  // "already initialized" — just grab the existing instance
  auth = getAuth(app);
}

export { auth };
