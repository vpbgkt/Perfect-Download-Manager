"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "../ui/button.tsx";
import { Input, Label } from "../ui/input.tsx";
import { getFirebaseAuth } from "../../lib/firebase-client.ts";

/**
 * Step 2 of sign-in: the email OTP second factor. We re-read the current
 * Firebase ID token (restored from local persistence) and submit the 6-digit
 * code to POST /api/auth/otp/verify, which opens the session cookie. A full
 * navigation to `next` then lets middleware see the new cookie.
 */
export function OtpForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/dashboard";

  const [otp, setOtp] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const auth = getFirebaseAuth();
        await auth.authStateReady();
        if (cancelled) return;
        if (!auth.currentUser) {
          // No signed-in Firebase user (e.g. page opened directly) → back to login.
          window.location.assign(`/login?next=${encodeURIComponent(next)}`);
          return;
        }
        setReady(true);
      } catch {
        window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [next]);

  async function currentIdToken(): Promise<string> {
    const auth = getFirebaseAuth();
    if (!auth.currentUser) throw new Error("no current user");
    return auth.currentUser.getIdToken();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const idToken = await currentIdToken();
      const res = await fetch("/api/auth/otp/verify", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ otp: otp.trim() }),
      });
      if (res.status === 200) {
        // Full navigation so the freshly-set session cookie reaches middleware.
        window.location.assign(next);
        return;
      }
      if (res.status === 423) {
        setError("Too many attempts. This account is temporarily locked.");
      } else if (res.status === 400) {
        setError("Enter the 6-digit code from your email.");
      } else {
        setError("That code didn't match. Please try again.");
      }
    } catch {
      setError("Verification failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    setError(null);
    setInfo(null);
    try {
      const idToken = await currentIdToken();
      const res = await fetch("/api/auth/otp/request", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: "{}",
      });
      setInfo(res.status === 200 ? "A new code has been sent." : "Please wait before requesting another code.");
    } catch {
      setError("Couldn't resend the code. Try again.");
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="otp">Verification code</Label>
        <Input
          id="otp"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          placeholder="123456"
          required
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
          disabled={loading || !ready}
        />
        <p className="text-xs text-[var(--color-muted)]">
          We emailed a 6-digit code. It expires in 10 minutes.
        </p>
      </div>

      {error && (
        <p className="text-sm text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      )}
      {info && (
        <p className="text-sm text-[var(--color-success)]" role="status">
          {info}
        </p>
      )}

      <Button type="submit" className="w-full" disabled={loading || !ready || otp.length !== 6}>
        {loading ? "Verifying…" : "Verify & sign in"}
      </Button>
      <Button type="button" variant="ghost" onClick={resend} disabled={!ready}>
        Resend code
      </Button>
    </form>
  );
}
