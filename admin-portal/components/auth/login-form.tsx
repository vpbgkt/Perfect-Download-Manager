"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "../ui/button.tsx";
import { Input, Label } from "../ui/input.tsx";
import { getSafeRedirectPath } from "../../lib/auth-redirect.ts";

/**
 * Unified login form using password authentication for all users:
 * - Admins (super_admin, admin, readonly_admin)
 * - Distributors
 * - Resellers
 * - Dealers
 * 
 * All accounts authenticate via email + password and receive a JWT token.
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next");

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await fetch("/api/auth/login-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (result.ok) {
        const data = await result.json();
        if (data.success && data.account && data.token) {
          // Password auth successful - store JWT token
          const accountData = {
            accountId: data.account.accountId,
            resellerAccountId: data.account.resellerAccountId,
            role: data.account.role || "reseller",
            authMethod: data.account.authMethod || "password",
            token: data.token,
          };
          sessionStorage.setItem("pdm_account", JSON.stringify(accountData));
          
          // Redirect to dashboard
          window.location.href = getSafeRedirectPath(next, window.location.origin);
          return;
        }
      }
      
      // Handle errors
      if (result.status === 401) {
        const errorData = await result.json().catch(() => ({}));
        setError(errorData.message || "Invalid email or password");
      } else if (result.status === 423) {
        setError("This account is temporarily locked. Try again later.");
      } else {
        setError("Sign-in failed. Check your credentials and try again.");
      }
    } catch (err) {
      console.error("Login error:", err);
      setError("Sign-in failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
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

      <p className="text-xs text-center text-gray-500">
        Admin, distributor, reseller, and dealer accounts
      </p>
    </form>
  );
}
