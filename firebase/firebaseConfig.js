import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { initializeAuth, getAuth, getReactNativePersistence } from "firebase/auth";
import ReactNativeAsyncStorage from "@react-native-async-storage/async-storage";
import { firebaseConfig } from "./config";

// Firebase is optional at run time: sessions are stored on the phone and uploaded when Firebase
// is reachable (services/syncService.js). When config.js still holds the placeholder values of
// example_config.js, or Firebase rejects the configuration, `db` and `auth` stay null and
// `firebaseInitError` says why; cloud calls then fail and the app keeps working locally.
// A missing firebase/config.js file still fails the build: Metro must resolve the import above.

const isPlaceholder = (value) => typeof value !== "string" || value === "" || value.startsWith("YOUR_");

let db = null;
let auth = null;
let firebaseInitError = null;

if (isPlaceholder(firebaseConfig?.apiKey) || isPlaceholder(firebaseConfig?.projectId)) {
  firebaseInitError = new Error("Firebase is not configured (firebase/config.js has no project credentials)");
} else {
  try {
    // Guard against re-initialization on hot reload
    const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

    db = getFirestore(app);

    // Firebase v12 requires explicit AsyncStorage wiring for RN persistence.
    // initializeAuth() must only be called once; on hot-reload we fall back to
    // getAuth() which returns the already-initialized instance.
    try {
      auth = initializeAuth(app, {
        persistence: getReactNativePersistence(ReactNativeAsyncStorage),
      });
    } catch (e) {
      // "already initialized" — just grab the existing instance
      auth = getAuth(app);
    }
  } catch (e) {
    firebaseInitError = e;
    db = null;
    auth = null;
    console.warn("[firebase] initialization failed; the app runs without cloud sync:", e?.message ?? e);
  }
}

export { db, auth, firebaseInitError };
