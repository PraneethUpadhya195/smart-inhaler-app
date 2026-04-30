import { signInAnonymously as firebaseSignIn } from "firebase/auth";
import { doc, setDoc } from "firebase/firestore";
import { auth, db } from "../firebase/firebaseConfig";

/**
 * Signs in anonymously using Firebase Auth.
 * Firebase SDK persists the UID via AsyncStorage — calling this on restart
 * returns the same user as long as the app is not reinstalled.
 *
 * @returns {Promise<string>} userId — the anonymous Firebase UID
 */
export async function signInAnonymously() {
  const userCredential = await firebaseSignIn(auth);
  const userId = userCredential.user.uid;

  // Ensure user document exists in Firestore
  const userRef = doc(db, "users", userId);
  await setDoc(userRef, { createdAt: new Date() }, { merge: true });

  return userId;
}
