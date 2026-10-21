"use client";

import * as React from "react";
import { api, ApiError } from "../../../models/api-client.ts";
import type { ResellerAccount, IssuedApiKey, BalanceTransaction } from "../../../models/types.ts";
import { PageHeader, ErrorText, Spinner, EmptyState } from "../../../components/ui/feedback.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Table, THead, TBody, TR, TH, TD } from "../../../components/ui/table.tsx";
import { BalanceCreditModal } from "../../../components/dashboard/balance-credit-form.tsx";
import { TransactionHistoryModal } from "../../../components/dashboard/transaction-history.tsx";
import { ChevronDown, ChevronUp, Wallet, Key, History, TrendingUp } from "lucide-react";

type AccountType = "all" | "distributor" | "reseller" | "dealer";

export default function AccountsPage() {
  const [accounts, setAccounts] = React.useState<ResellerAccount[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<AccountType>("all");
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  React.useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listResellers();
      // listResellers returns ResellerListResult: { items: [...], nextToken: ... }
      setAccounts(result.items || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }

  const filteredAccounts = React.useMemo(() => {
    if (filter === "all") return accounts;
    return accounts.filter((acc) => acc.accountType === filter);
  }, [accounts, filter]);

  const stats = React.useMemo(() => {
    const total = accounts.length;
    const distributors = accounts.filter((a) => a.accountType === "distributor").length;
    const resellers = accounts.filter((a) => a.accountType === "reseller").length;
    const dealers = accounts.filter((a) => a.accountType === "dealer").length;
    const totalBalance = accounts.reduce((sum, a) => sum + (a.balance || 0), 0);
    const activeAccounts = accounts.filter((a) => a.state === "active").length;

    return { total, distributors, resellers, dealers, totalBalance, activeAccounts };
  }, [accounts]);

  function toggleExpand(accountId: string) {
    setExpandedId((current) => (current === accountId ? null : accountId));
  }

  return (
    <>
      <PageHeader
        title="Account Management"
        description="Manage all accounts across different roles with detailed insights"
      />

      {/* Stats Overview */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{stats.total}</div>
            <p className="text-xs text-gray-500 mt-1">Total Accounts</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-blue-600">{stats.distributors}</div>
            <p className="text-xs text-gray-500 mt-1">Distributors</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-green-600">{stats.resellers}</div>
            <p className="text-xs text-gray-500 mt-1">Resellers</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-orange-600">{stats.dealers}</div>
            <p className="text-xs text-gray-500 mt-1">Dealers</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-purple-600">{stats.totalBalance.toLocaleString()}</div>
            <p className="text-xs text-gray-500 mt-1">Total Balance</p>
          </CardContent>
        </Card>
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2 mb-6">
        <Button
          variant={filter === "all" ? "default" : "outline"}
          size="sm"
          onClick={() => setFilter("all")}
        >
          All ({stats.total})
        </Button>
        <Button
          variant={filter === "distributor" ? "default" : "outline"}
          size="sm"
          onClick={() => setFilter("distributor")}
        >
          Distributors ({stats.distributors})
        </Button>
        <Button
          variant={filter === "reseller" ? "default" : "outline"}
          size="sm"
          onClick={() => setFilter("reseller")}
        >
          Resellers ({stats.resellers})
        </Button>
        <Button
          variant={filter === "dealer" ? "default" : "outline"}
          size="sm"
          onClick={() => setFilter("dealer")}
        >
          Dealers ({stats.dealers})
        </Button>
      </div>

      {/* Accounts Table */}
      <Card>
        <CardHeader>
          <CardTitle>
            {filter === "all" ? "All Accounts" : `${filter.charAt(0).toUpperCase() + filter.slice(1)}s`}
          </CardTitle>
          <CardDescription>
            Click on any account to view detailed information
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && <ErrorText>{error}</ErrorText>}
          {loading ? (
            <Spinner />
          ) : filteredAccounts.length === 0 ? (
            <EmptyState
              title="No accounts found"
              hint={filter === "all" ? "Create your first account to get started" : `No ${filter}s found`}
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH className="w-10"></TH>
                    <TH>Organization</TH>
                    <TH>Contact Email</TH>
                    <TH>Type</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Balance</TH>
                    <TH className="text-right">Discount</TH>
                    <TH>Created</TH>
                  </TR>
                </THead>
                <TBody>
                  {filteredAccounts.map((account) => (
                    <React.Fragment key={account.resellerAccountId}>
                      <TR
                        className="cursor-pointer hover:bg-gray-50"
                        onClick={() => toggleExpand(account.resellerAccountId)}
                      >
                        <TD className="text-center">
                          {expandedId === account.resellerAccountId ? (
                            <ChevronUp size={16} className="text-gray-400" />
                          ) : (
                            <ChevronDown size={16} className="text-gray-400" />
                          )}
                        </TD>
                        <TD className="font-medium">{account.orgName}</TD>
                        <TD className="text-sm text-gray-600">{account.contactEmail}</TD>
                        <TD>
                          <Badge
                            tone={
                              account.accountType === "distributor"
                                ? "info"
                                : account.accountType === "dealer"
                                ? "warning"
                                : "default"
                            }
                          >
                            {account.accountType || "reseller"}
                          </Badge>
                        </TD>
                        <TD>
                          <Badge tone={account.state === "active" ? "success" : "danger"}>
                            {account.state}
                          </Badge>
                        </TD>
                        <TD className={`text-right font-mono ${(account.balance || 0) < 100 ? "text-orange-600" : ""}`}>
                          {(account.balance || 0).toLocaleString()}
                        </TD>
                        <TD className="text-right font-mono">{account.discountPercent || 0}%</TD>
                        <TD className="text-sm text-gray-500">
                          {account.createdAt
                            ? new Date(account.createdAt).toLocaleDateString()
                            : "—"}
                        </TD>
                      </TR>
                      {expandedId === account.resellerAccountId && (
                        <TR>
                          <TD colSpan={8} className="bg-gray-50 p-0">
                            <AccountDetails
                              account={account}
                              onBalanceUpdated={loadAccounts}
                            />
                          </TD>
                        </TR>
                      )}
                    </React.Fragment>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

interface AccountDetailsProps {
  account: ResellerAccount;
  onBalanceUpdated: () => void;
}

function AccountDetails({ account, onBalanceUpdated }: AccountDetailsProps) {
  const [showCreditModal, setShowCreditModal] = React.useState(false);
  const [showTransactionModal, setShowTransactionModal] = React.useState(false);
  const [apiKeys, setApiKeys] = React.useState<IssuedApiKey[]>([]);
  const [transactions, setTransactions] = React.useState<BalanceTransaction[]>([]);
  const [loadingKeys, setLoadingKeys] = React.useState(true);
  const [loadingTransactions, setLoadingTransactions] = React.useState(true);

  React.useEffect(() => {
    loadApiKeys();
    loadTransactions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.resellerAccountId]);

  async function loadApiKeys() {
    setLoadingKeys(true);
    try {
      const keys = await api.listApiKeys(account.resellerAccountId);
      setApiKeys(keys);
    } catch {
      setApiKeys([]);
    } finally {
      setLoadingKeys(false);
    }
  }

  async function loadTransactions() {
    setLoadingTransactions(true);
    try {
      const result = await api.getTransactions(account.resellerAccountId, { limit: 5 });
      setTransactions(result.transactions);
    } catch {
      setTransactions([]);
    } finally {
      setLoadingTransactions(false);
    }
  }

  const activeKeys = Array.isArray(apiKeys) ? apiKeys.filter((k) => k.state === "active").length : 0;
  const totalSpent = Array.isArray(transactions)
    ? transactions.filter((t) => t.type === "debit").reduce((sum, t) => sum + t.amount, 0)
    : 0;

  return (
    <div className="p-6 space-y-6">
      {/* Account Info Header */}
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">{account.orgName}</h3>
          <p className="text-sm text-gray-500">ID: {account.resellerAccountId}</p>
          {account.parentAccountId && (
            <p className="text-sm text-gray-500">Parent: {account.parentAccountId}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setShowCreditModal(true)}>
            <Wallet size={16} className="mr-1" />
            Deposit Balance
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowTransactionModal(true)}>
            <History size={16} className="mr-1" />
            Full History
          </Button>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Wallet className="text-blue-500" size={20} />
              <div>
                <div className="text-xl font-bold">{(account.balance || 0).toLocaleString()}</div>
                <p className="text-xs text-gray-500">Current Balance</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Key className="text-green-500" size={20} />
              <div>
                <div className="text-xl font-bold">{activeKeys}</div>
                <p className="text-xs text-gray-500">Active API Keys</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="text-purple-500" size={20} />
              <div>
                <div className="text-xl font-bold">{totalSpent.toLocaleString()}</div>
                <p className="text-xs text-gray-500">Total Spent</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <div className="text-2xl">%</div>
              <div>
                <div className="text-xl font-bold">{account.discountPercent || 0}%</div>
                <p className="text-xs text-gray-500">Discount Rate</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* API Keys & Recent Transactions */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* API Keys */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">API Keys</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingKeys ? (
              <Spinner />
            ) : !Array.isArray(apiKeys) || apiKeys.length === 0 ? (
              <p className="text-sm text-gray-500">No API keys issued</p>
            ) : (
              <div className="space-y-2">
                {apiKeys.slice(0, 5).map((key) => (
                  <div
                    key={key.apiKeyId}
                    className="flex items-center justify-between p-2 bg-gray-50 rounded"
                  >
                    <div>
                      <p className="text-xs font-mono">{key.apiKeyId}</p>
                      <p className="text-xs text-gray-500">
                        {key.createdAt
                          ? new Date(key.createdAt).toLocaleDateString()
                          : "—"}
                      </p>
                    </div>
                    <Badge tone={key.state === "active" ? "success" : "danger"} size="sm">
                      {key.state}
                    </Badge>
                  </div>
                ))}
                {apiKeys.length > 5 && (
                  <p className="text-xs text-gray-500 text-center pt-2">
                    +{apiKeys.length - 5} more keys
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Transactions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Transactions</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingTransactions ? (
              <Spinner />
            ) : !Array.isArray(transactions) || transactions.length === 0 ? (
              <p className="text-sm text-gray-500">No transactions yet</p>
            ) : (
              <div className="space-y-2">
                {transactions.map((tx) => (
                  <div
                    key={tx.transactionId}
                    className="flex items-center justify-between p-2 bg-gray-50 rounded"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{tx.reason}</p>
                      <p className="text-xs text-gray-500">
                        {new Date(tx.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="text-right ml-2">
                      <p
                        className={`text-sm font-mono font-semibold ${
                          tx.type === "credit" ? "text-green-600" : "text-red-600"
                        }`}
                      >
                        {tx.type === "credit" ? "+" : "-"}
                        {tx.amount.toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Modals */}
      <BalanceCreditModal
        isOpen={showCreditModal}
        accountId={account.resellerAccountId}
        accountName={account.orgName}
        currentBalance={account.balance || 0}
        onSuccess={() => {
          onBalanceUpdated();
          loadTransactions();
        }}
        onClose={() => setShowCreditModal(false)}
      />

      <TransactionHistoryModal
        isOpen={showTransactionModal}
        accountId={account.resellerAccountId}
        accountName={account.orgName}
        onClose={() => setShowTransactionModal(false)}
      />
    </div>
  );
}
