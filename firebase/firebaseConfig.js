import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { firebaseConfig } from "./config";

// Guard against re-initialization on hot reload
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

export const db = getFirestore(app);

// Firebase v12 removed getReactNativePersistence from firebase/auth.
// getAuth() is the correct approach — Metro resolves firebase/auth to its
// React Native bundle which handles persistence automatically via the
// @firebase/auth react-native export condition.
// The anonymous UID persists across restarts via the Firebase SDK's
// built-in AsyncStorage integration in the RN bundle.
export const auth = getAuth(app);
