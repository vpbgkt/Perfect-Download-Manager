"use client";

import * as React from "react";
import { Button, type ButtonProps } from "../ui/button.tsx";

/**
 * Ends the session: clears the JWT token from sessionStorage,
 * calls the logout API, and navigates to /login.
 */
export function LogoutButton(props: ButtonProps) {
  const [loading, setLoading] = React.useState(false);

  async function onClick() {
    setLoading(true);
    try {
      const storedAccount = sessionStorage.getItem("pdm_account");
      let token: string | undefined;
      if (storedAccount) {
        try {
          const account: unknown = JSON.parse(storedAccount);
          if (
            typeof account === "object" &&
            account !== null &&
            "token" in account &&
            typeof account.token === "string"
          ) {
            token = account.token;
          }
        } catch (error) {
          console.error("Could not read the current session token for logout:", error);
        }
      }

      const headers = new Headers({ "Content-Type": "application/json" });
      if (token) headers.set("Authorization", `Bearer ${token}`);

      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers,
        body: "{}",
      });
      if (!response.ok) {
        console.error("The server could not revoke the current session:", response.status);
      }
    } catch (error) {
      console.error("The server could not revoke the current session:", error);
    } finally {
      sessionStorage.removeItem("pdm_account");
      // Redirect to login page
      window.location.assign("/login");
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={loading} {...props}>
      {loading ? "Signing out…" : "Sign out"}
    </Button>
  );
}
