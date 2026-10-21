"use client";

import * as React from "react";
import { api, ApiError } from "../../models/api-client.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card.tsx";
import { Button } from "../ui/button.tsx";
import { ErrorText, Spinner } from "../ui/feedback.tsx";
import { useSession } from "./session-provider.tsx";

interface BalanceWidgetProps {
  accountId: string;
}

export function BalanceWidget({ accountId }: BalanceWidgetProps) {
  const [balance, setBalance] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const loadBalance = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getBalance(accountId);
      setBalance(result.balance);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load balance");
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  React.useEffect(() => {
    void loadBalance();
  }, [loadBalance]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Balance</CardTitle>
        </CardHeader>
        <CardContent>
          <Spinner />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Balance</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorText>{error}</ErrorText>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Account Balance</CardTitle>
        <CardDescription>Current available credits</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline justify-between">
          <div>
            <span className="text-4xl font-bold">{balance?.toLocaleString() ?? "0"}</span>
            <span className="ml-2 text-lg text-gray-600">credits</span>
          </div>
          <Button variant="outline" size="sm" onClick={() => void loadBalance()}>
            Refresh
          </Button>
        </div>
        <div className="mt-4 flex gap-2">
          <Button size="sm" onClick={() => window.location.href = `/dashboard/resellers/${accountId}/balance`}>
            Add Balance
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.location.href = `/dashboard/resellers/${accountId}/transactions`}>
            View History
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Balance widget for admin dashboard that shows all resellers' balances summary.
 */
export function BalanceOverviewWidget() {
  const { session } = useSession();
  const [stats, setStats] = React.useState<{
    totalAccounts: number;
    totalBalance: number;
    lowBalanceCount: number;
  } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    async function loadStats() {
      try {
        // Fetch all resellers to calculate stats
        const result = await api.listResellers({ limit: 100 });
        
        let totalBalance = 0;
        let lowBalanceCount = 0;
        const lowBalanceThreshold = 100;

        result.items.forEach((account) => {
          const balance = account.balance ?? 0;
          totalBalance += balance;
          if (balance < lowBalanceThreshold) {
            lowBalanceCount++;
          }
        });

        setStats({
          totalAccounts: result.items.length,
          totalBalance,
          lowBalanceCount,
        });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Failed to load stats");
      } finally {
        setLoading(false);
      }
    }

    if (session?.role === "super_admin" || session?.role === "admin") {
      void loadStats();
    } else {
      setLoading(false);
    }
  }, [session]);

  // Don't show for resellers - they have their own balance widget
  if (session?.role !== "super_admin" && session?.role !== "admin") {
    return null;
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Balance Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <Spinner />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Balance Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorText>{error}</ErrorText>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Balance Overview</CardTitle>
        <CardDescription>System-wide balance statistics</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4">
          <div>
            <div className="text-sm text-gray-600">Total Accounts</div>
            <div className="text-2xl font-bold">{stats?.totalAccounts ?? 0}</div>
          </div>
          <div>
            <div className="text-sm text-gray-600">Total Balance</div>
            <div className="text-2xl font-bold">
              {stats?.totalBalance.toLocaleString() ?? "0"} <span className="text-base text-gray-600">credits</span>
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-600">Low Balance Accounts</div>
            <div className="text-2xl font-bold text-orange-600">{stats?.lowBalanceCount ?? 0}</div>
            <div className="text-xs text-gray-500">(&lt; 100 credits)</div>
          </div>
        </div>
        <div className="mt-4">
          <Button variant="outline" size="sm" onClick={() => window.location.href = "/dashboard/resellers"}>
            Manage Accounts
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
