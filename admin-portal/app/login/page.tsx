import { Suspense } from "react";
import type { Metadata } from "next";
import { AuthShell } from "../../components/auth/auth-shell.tsx";
import { LoginForm } from "../../components/auth/login-form.tsx";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <AuthShell title="Sign in" description="Sign in to your PDM Portal account.">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
