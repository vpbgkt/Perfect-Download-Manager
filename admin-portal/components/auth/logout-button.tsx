"use client";

import * as React from "react";
import { Button, type ButtonProps } from "../ui/button.tsx";
import { getFirebaseAuth, isFirebaseConfigured } from "../../lib/firebase-client.ts";

/**
 * Ends the session: revokes the Firebase refresh token + clears the portal
 * session cookie via POST /api/auth/logout, signs out of the Firebase SDK, then
 * navigates to /login.
 */
export function LogoutButton(props: ButtonProps) {
  const [loading, setLoading] = React.useState(false);

  async function onClick() {
    setLoading(true);
    try {
      let idToken: string | undefined;
      if (isFirebaseConfigured()) {
        const auth = getFirebaseAuth();
        idToken = await auth.currentUser?.getIdToken();
        const { signOut } = await import("firebase/auth");
        await signOut(auth).catch(() => {});
      }
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body: "{}",
      }).catch(() => {});
    } finally {
      window.location.assign("/login");
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={loading} {...props}>
      {loading ? "Signing out…" : "Sign out"}
    </Button>
  );
}
