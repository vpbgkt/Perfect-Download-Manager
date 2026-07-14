"use client";

import * as React from "react";
import { api, ApiError } from "../../models/api-client.ts";
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
 * Loads the principal summary once for the dashboard. On a 401 (expired/invalid
 * session) it sends the user back to /login, preserving the intended path.
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
        const session = await api.session();
        if (!cancelled) setState({ session, loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          const next = encodeURIComponent(window.location.pathname);
          window.location.assign(`/login?next=${next}`);
          return;
        }
        setState({
          session: null,
          loading: false,
          error: err instanceof Error ? err.message : "Failed to load session",
        });
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
