"use client";

import * as React from "react";
import { api, ApiError } from "../../models/api-client.ts";
import type { BalanceTransaction } from "../../models/types.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card.tsx";
import { Button } from "../ui/button.tsx";
import { ErrorText, Spinner, EmptyState } from "../ui/feedback.tsx";
import { Table, THead, TBody, TR, TH, TD } from "../ui/table.tsx";
import { Badge } from "../ui/badge.tsx";

interface TransactionHistoryProps {
  accountId: string;
  accountName: string;
  onClose?: () => void;
}

export function TransactionHistory({ accountId, accountName, onClose }: TransactionHistoryProps) {
  const [transactions, setTransactions] = React.useState<BalanceTransaction[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [nextToken, setNextToken] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);

  const loadTransactions = React.useCallback(
    async (append: boolean, token?: string) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);

      try {
        const result = await api.getTransactions(accountId, { limit: 20, nextToken: token });
        setTransactions((prev) =>
          append ? [...prev, ...result.transactions] : result.transactions
        );
        setNextToken(result.nextToken);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Failed to load transactions");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [accountId]
  );

  React.useEffect(() => {
    void loadTransactions(false);
  }, [loadTransactions]);

  function formatDate(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatAmount(amount: number, type: "credit" | "debit"): string {
    const sign = type === "credit" ? "+" : "-";
    return `${sign}${Math.abs(amount).toLocaleString()}`;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Transaction History</CardTitle>
            <CardDescription>Balance transactions for {accountName}</CardDescription>
          </div>
          {onClose && (
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="mb-4">
            <ErrorText>{error}</ErrorText>
          </div>
        )}

        {loading ? (
          <Spinner />
        ) : transactions.length === 0 ? (
          <EmptyState title="No transactions yet" hint="Transaction history will appear here once balance operations occur." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Date & Time</TH>
                    <TH>Type</TH>
                    <TH className="text-right">Amount</TH>
                    <TH className="text-right">Balance After</TH>
                    <TH>Reason</TH>
                    <TH>Reference</TH>
                  </TR>
                </THead>
                <TBody>
                  {transactions.map((tx) => (
                    <TR key={tx.transactionId}>
                      <TD className="text-sm whitespace-nowrap">{formatDate(tx.createdAt)}</TD>
                      <TD>
                        <Badge tone={tx.type === "credit" ? "success" : "warning"}>
                          {tx.type}
                        </Badge>
                      </TD>
                      <TD
                        className={`text-right font-mono font-semibold ${
                          tx.type === "credit" ? "text-green-600" : "text-red-600"
                        }`}
                      >
                        {formatAmount(tx.amount, tx.type)}
                      </TD>
                      <TD className="text-right font-mono">{tx.balanceAfter.toLocaleString()}</TD>
                      <TD className="text-sm text-gray-600 max-w-xs truncate" title={tx.reason}>
                        {tx.reason}
                      </TD>
                      <TD className="font-mono text-xs text-gray-500 max-w-[120px] truncate" title={tx.relatedEntity || "-"}>
                        {tx.relatedEntity || "-"}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>

            {nextToken && (
              <div className="mt-4 flex justify-center">
                <Button variant="outline" onClick={() => loadTransactions(true, nextToken)} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}

            <div className="mt-4 text-sm text-gray-500 text-center">
              Showing {transactions.length} transaction{transactions.length !== 1 ? "s" : ""}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface TransactionHistoryModalProps {
  isOpen: boolean;
  accountId: string;
  accountName: string;
  onClose: () => void;
}

export function TransactionHistoryModal({
  isOpen,
  accountId,
  accountName,
  onClose,
}: TransactionHistoryModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-w-5xl w-full max-h-[90vh] overflow-y-auto">
        <TransactionHistory accountId={accountId} accountName={accountName} onClose={onClose} />
      </div>
    </div>
  );
}
