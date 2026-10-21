"use client";

import * as React from "react";
import type { SessionSummary } from "../../models/types.ts";
import { Spinner } from "../ui/feedback.tsx";

interface SessionState {
  session: SessionSummary | null;
  loading: boolean;
  error: string | null;
}

const SessionContext = React.createContext<SessionState>({
  session: null,
  loading: true,
  error: null,
});

/** Access the current authenticated session summary. */
export function useSession(): SessionState {
  return React.useContext(SessionContext);
}

/**
 * Loads the principal summary from JWT token stored in sessionStorage.
 * All users (admins, distributors, resellers, dealers) authenticate via
 * password and receive a JWT token.
 * 
 * On missing/invalid token, redirects to /login.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<SessionState>({
    session: null,
    loading: true,
    error: null,
  });

  React.useEffect(() => {
    let cancelled = false;
    
    (async () => {
      try {
        // Check for JWT token in sessionStorage
        const storedAccount = sessionStorage.getItem("pdm_account");
        
        if (!storedAccount) {
          // No token found - redirect to login
          if (!cancelled) {
            const next = encodeURIComponent(window.location.pathname);
            window.location.assign(`/login?next=${next}`);
          }
          return;
        }

        try {
          const account = JSON.parse(storedAccount);
          
          // Validate token exists
          if (!account.token || !account.accountId || !account.role) {
            throw new Error("Invalid session data");
          }

          // Create session from stored account info
          const session: SessionSummary = {
            identity: account.accountId,
            role: account.role,
            resellerAccountId: account.resellerAccountId || null,
            mfaEnrolled: false, // Not used with password auth
          };
          
          if (!cancelled) {
            setState({ session, loading: false, error: null });
          }
        } catch (parseErr) {
          // Invalid stored data - clear it and redirect to login
          sessionStorage.removeItem("pdm_account");
          if (!cancelled) {
            const next = encodeURIComponent(window.location.pathname);
            window.location.assign(`/login?next=${next}`);
          }
        }
      } catch (err) {
        if (cancelled) return;
        
        // Clear any stale session data
        sessionStorage.removeItem("pdm_account");
        
        // Redirect to login
        const next = encodeURIComponent(window.location.pathname);
        window.location.assign(`/login?next=${next}`);
      }
    })();
    
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Loading portal…" />
      </div>
    );
  }

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}
