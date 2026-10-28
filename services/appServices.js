/**
 * services/appServices.js — the app's instances of the local session store and the sync service.
 *
 * Sessions are stored with AsyncStorage (one key per session, services/localSessionStore.js) and
 * uploaded to Firestore under users/{uid}/sessions/{session_id} (services/sessionService.js) by
 * services/syncService.js. The Node tests build their own instances with in-memory fakes
 * (services/test_sessions.js), because this module imports React Native and Firebase.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { createLocalSessionStore } from "./localSessionStore";
import { createSyncService } from "./syncService";
import { addSession, sessionExistsRemotely } from "./sessionService";
import { ensureSignedIn } from "./authService";

export const localSessionStore = createLocalSessionStore(AsyncStorage);

export const sessionSync = createSyncService({
  store: localSessionStore,
  uploadSession: addSession,
  getUserId: ensureSignedIn,
  sessionExistsRemotely,
});
