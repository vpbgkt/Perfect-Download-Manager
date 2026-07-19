/**
 * Client-side Firebase Authentication bootstrap.
 *
 * Runs only in the browser (imported by client components). Reads the public
 * Firebase Web App config from `NEXT_PUBLIC_FIREBASE_*` environment variables.
 * These values are public by design (they identify the Firebase project, not a
 * secret) — server-side ID-token verification via the Admin SDK is the real
 * trust boundary.
 *
 * @module lib/firebase-client
 */

import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  browserLocalPersistence,
  setPersistence,
  type Auth,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

/** True when the public Firebase config is present (so login can work). */
export function isFirebaseConfigured(): boolean {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.authDomain &&
      firebaseConfig.projectId &&
      firebaseConfig.appId
  );
}

let authInstance: Auth | undefined;

/**
 * Lazily initialize the Firebase app + Auth in the browser and return the Auth
 * instance. Throws a clear error when the config is absent so the login UI can
 * surface a helpful message instead of failing cryptically.
 */
export function getFirebaseAuth(): Auth {
  if (!isFirebaseConfigured()) {
    throw new Error(
      "Firebase is not configured. Set NEXT_PUBLIC_FIREBASE_API_KEY, " +
        "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, NEXT_PUBLIC_FIREBASE_PROJECT_ID, and " +
        "NEXT_PUBLIC_FIREBASE_APP_ID in .env.local."
    );
  }
  if (authInstance) return authInstance;

  const app: FirebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
  authInstance = getAuth(app);
  // Persist the session locally so the ID token survives the navigation from
  // /login to /verify-otp.
  void setPersistence(authInstance, browserLocalPersistence);
  return authInstance;
}
