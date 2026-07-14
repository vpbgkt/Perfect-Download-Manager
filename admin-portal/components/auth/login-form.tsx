"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "../ui/button.tsx";
import { Input, Label } from "../ui/input.tsx";
import { getFirebaseAuth, isFirebaseConfigured } from "../../lib/firebase-client.ts";

/**
 * Step 1 of sign-in: Firebase email/password. On success we exchange the
 * Firebase ID token at POST /api/auth/login, which emails the OTP, then move to
 * the /verify-otp screen. Credential errors are shown generically so we never
 * disclose which field was wrong (mirrors the backend's uniform failure).
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/dashboard";

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const configured = isFirebaseConfigured();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { signInWithEmailAndPassword } = await import("firebase/auth");
      const auth = getFirebaseAuth();
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      const idToken = await cred.user.getIdToken();

      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: "{}",
      });

      if (res.status === 200) {
        const data = await res.json().catch(() => ({}));
        if (data.status === "authenticated") {
          // OTP disabled: session already opened — go straight to the app.
          window.location.assign(next);
        } else {
          router.push(`/verify-otp?next=${encodeURIComponent(next)}`);
        }
        return;
      }
      if (res.status === 423) {
        setError("This account is temporarily locked. Try again later.");
      } else {
        setError("Sign-in failed. Check your credentials and try again.");
      }
    } catch (err) {
      // Firebase credential errors and config errors both land here.
      setError(
        !configured
          ? "Firebase is not configured on this environment."
          : "Sign-in failed. Check your credentials and try again."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {!configured && (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800" role="status">
          Firebase sign-in isn&apos;t configured yet. Add the{" "}
          <code>NEXT_PUBLIC_FIREBASE_*</code> values to <code>.env.local</code>.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
        />
      </div>

      {error && (
        <p className="text-sm text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      )}

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Signing in…" : "Continue"}
      </Button>
    </form>
  );
}
