import * as React from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card.tsx";

/** Centered card layout shared by the login and OTP screens. */
export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center px-6">
      <div className="mb-6 flex items-center gap-2">
        <span
          aria-hidden
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-primary)] font-bold text-white"
        >
          P
        </span>
        <span className="text-lg font-semibold">PDM Portal</span>
      </div>
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
      <p className="mt-6 text-center text-xs text-[var(--color-muted)]">
        Authorized personnel only. This portal is not publicly indexed.
      </p>
    </main>
  );
}
