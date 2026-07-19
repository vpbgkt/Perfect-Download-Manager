"use client";

import Link from "next/link";
import { Card, CardDescription, CardHeader, CardTitle } from "../../components/ui/card.tsx";
import { PageHeader } from "../../components/ui/feedback.tsx";
import { useSession } from "../../components/dashboard/session-provider.tsx";
import { hasPermission, type Permission } from "../../lib/rbac.ts";

interface Tile {
  href: string;
  title: string;
  description: string;
  permission?: Permission;
}

const TILES: Tile[] = [
  { href: "/dashboard/licenses", title: "Licenses", description: "Create, search, and manage license keys.", permission: "license:read" },
  { href: "/dashboard/releases", title: "Releases", description: "Publish builds and sign the update manifest.", permission: "release:read" },
  { href: "/dashboard/seo", title: "SEO", description: "Edit marketing-site titles, descriptions, and OG tags.", permission: "seo:read" },
  { href: "/dashboard/resellers", title: "Resellers", description: "Onboard and manage reseller accounts.", permission: "reseller:manage" },
  { href: "/dashboard/api-keys", title: "API Keys", description: "Issue and manage reseller API keys.", permission: "apikey:create" },
  { href: "/dashboard/admins", title: "Admins", description: "Create admin users.", permission: "admin:manage" },
  { href: "/dashboard/audit", title: "Audit Log", description: "Investigate who changed what.", permission: "audit:read" },
];

export default function DashboardPage() {
  const { session } = useSession();
  const role = session?.role;
  const tiles = TILES.filter((t) => !t.permission || (role && hasPermission(role, t.permission)));

  return (
    <>
      <PageHeader
        title="Overview"
        description="Welcome to the PDM Seller & Admin Portal."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((t) => (
          <Link key={t.href} href={t.href} className="block">
            <Card className="h-full transition-shadow hover:shadow-md">
              <CardHeader>
                <CardTitle>{t.title}</CardTitle>
                <CardDescription>{t.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
