import type { Metadata } from "next";
import { SessionProvider } from "../../components/dashboard/session-provider.tsx";
import { DashboardShell } from "../../components/dashboard/shell.tsx";

export const metadata: Metadata = {
  title: "Dashboard",
  robots: { index: false, follow: false },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <DashboardShell>{children}</DashboardShell>
    </SessionProvider>
  );
}
