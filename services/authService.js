import { signInAnonymously as firebaseSignIn } from "firebase/auth";
import { doc, setDoc } from "firebase/firestore";
import { auth, db, firebaseInitError } from "../firebase/firebaseConfig";

/**
 * Signs in anonymously using Firebase Auth.
 * Firebase SDK persists the UID via AsyncStorage — calling this on restart
 * returns the same user as long as the app is not reinstalled (also offline: the SDK keeps the
 * stored user when it cannot reach the server).
 *
 * The user profile document is written in the background: Firestore resolves a write only after
 * the server confirms it, which never happens offline, so the app must not wait for it.
 *
 * @returns {Promise<string>} userId — the anonymous Firebase UID
 * @throws when Firebase is not configured or sign-in fails (e.g. first launch without network)
 */
export async function signInAnonymously() {
  if (!auth || !db) throw firebaseInitError ?? new Error("Firebase is not configured");
  const userCredential = await firebaseSignIn(auth);
  const userId = userCredential.user.uid;

  // Ensure user document exists in Firestore (not awaited, see above)
  const userRef = doc(db, "users", userId);
  setDoc(userRef, { createdAt: new Date() }, { merge: true })
    .catch((e) => console.warn("[auth] user document not written:", e?.message ?? e));

  return userId;
}

let signInInFlight = null;

/**
 * Best-effort sign-in for the parts of the app that can run without it (start-up, sync).
 * Concurrent callers share one attempt.
 * @returns {Promise<string|null>} the UID, or null when offline / not configured / sign-in failed
 */
export function ensureSignedIn() {
  if (!signInInFlight) {
    signInInFlight = signInAnonymously()
      .catch((e) => {
        console.warn("[auth] not signed in; sessions stay on this phone:", e?.code ?? e?.message ?? e);
        return null;
      })
      .finally(() => {
        signInInFlight = null;
      });
  }
  return signInInFlight;
}

/** True when firebase/config.js holds usable credentials (cloud sync possible). */
export function isFirebaseConfigured() {
  return Boolean(auth && db);
}
