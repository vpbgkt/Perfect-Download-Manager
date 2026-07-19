import { Suspense } from "react";
import type { Metadata } from "next";
import { AuthShell } from "../../components/auth/auth-shell.tsx";
import { OtpForm } from "../../components/auth/otp-form.tsx";

export const metadata: Metadata = {
  title: "Verify code",
  robots: { index: false, follow: false },
};

export default function VerifyOtpPage() {
  return (
    <AuthShell title="Two-factor verification" description="Enter the code we emailed you.">
      <Suspense fallback={null}>
        <OtpForm />
      </Suspense>
    </AuthShell>
  );
}
