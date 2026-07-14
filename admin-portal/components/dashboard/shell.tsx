"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  KeyRound,
  Download,
  Search,
  Building2,
  ShieldCheck,
  ScrollText,
  Users,
  type LucideIcon,
} from "lucide-react";
import { hasPermission, type Permission } from "../../lib/rbac.ts";
import { useSession } from "./session-provider.tsx";
import { LogoutButton } from "../auth/logout-button.tsx";
import { cn } from "../../lib/ui.ts";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Permission required to see this item; omitted = visible to all roles. */
  permission?: Permission;
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/licenses", label: "Licenses", icon: KeyRound, permission: "license:read" },
  { href: "/dashboard/releases", label: "Releases", icon: Download, permission: "release:read" },
  { href: "/dashboard/seo", label: "SEO", icon: Search, permission: "seo:read" },
  { href: "/dashboard/resellers", label: "Resellers", icon: Building2, permission: "reseller:manage" },
  { href: "/dashboard/api-keys", label: "API Keys", icon: ShieldCheck, permission: "apikey:create" },
  { href: "/dashboard/admins", label: "Admins", icon: Users, permission: "admin:manage" },
  { href: "/dashboard/audit", label: "Audit Log", icon: ScrollText, permission: "audit:read" },
];

/** Authenticated dashboard chrome: sidebar nav + top bar. */
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const { session } = useSession();
  const pathname = usePathname();
  const role = session?.role;

  const visible = NAV.filter((item) => !item.permission || (role && hasPermission(role, item.permission)));

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] md:flex">
        <div className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4">
          <span aria-hidden className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-primary)] text-sm font-bold text-white">
            P
          </span>
          <span className="font-semibold">PDM Portal</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="Primary">
          {visible.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-[var(--color-primary)] text-white"
                    : "text-[var(--color-fg)] hover:bg-gray-100"
                )}
              >
                <Icon size={18} aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4">
          <div className="text-sm text-[var(--color-muted)]">
            {role && <span className="capitalize">{role.replace("_", " ")}</span>}
            {session?.resellerAccountId && (
              <span className="ml-2">· {session.resellerAccountId}</span>
            )}
          </div>
          <LogoutButton />
        </header>
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
