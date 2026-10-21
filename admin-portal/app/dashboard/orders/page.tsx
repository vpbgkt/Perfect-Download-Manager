"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError } from "../../../models/api-client.ts";
import type { OrderRecord } from "../../../models/types.ts";
import { PageHeader, Spinner, ErrorText, EmptyState } from "../../../components/ui/feedback.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Badge, statusTone } from "../../../components/ui/badge.tsx";
import { Table, THead, TBody, TR, TH, TD } from "../../../components/ui/table.tsx";

/** Map order source to a human-readable label with color. */
function sourceLabel(source: string): { text: string; tone: "success" | "warning" | "info" } {
  switch (source) {
    case "api":
      return { text: "API", tone: "info" };
    case "dashboard":
      return { text: "Dashboard", tone: "success" };
    default:
      return { text: source, tone: "warning" };
  }
}

/** Map order status to badge tone. */
function orderStatusTone(status: string): "success" | "warning" | "danger" {
  switch (status) {
    case "completed":
      return "success";
    case "refunded":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "warning";
  }
}

export default function OrdersPage() {
  const [items, setItems] = React.useState<OrderRecord[]>([]);
  const [nextToken, setNextToken] = React.useState<string | undefined>();
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listOrders({ limit: 25 });
      setItems(res.items);
      setNextToken(res.nextToken);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load orders");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!nextToken) return;
    setLoadingMore(true);
    try {
      const res = await api.listOrders({ limit: 25, nextToken });
      setItems((prev) => [...prev, ...res.items]);
      setNextToken(res.nextToken);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Order History"
        description="View all license purchases and orders. Both dashboard and API orders appear here."
      />

      {error && <ErrorText className="mb-3">{error}</ErrorText>}

      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No orders yet"
          hint="Orders will appear here when you purchase licenses from the dashboard or via the API."
        />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Order ID</TH>
                <TH>License Key</TH>
                <TH>Plan</TH>
                <TH>Price</TH>
                <TH>Balance Deducted</TH>
                <TH>Status</TH>
                <TH>Source</TH>
                <TH>Date</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((order) => {
                const src = sourceLabel(order.source);
                return (
                  <TR key={order.orderId}>
                    <TD>
                      <span className="font-mono text-xs text-[var(--color-muted)]">
                        {order.orderId.slice(0, 12)}…
                      </span>
                    </TD>
                    <TD>
                      <Link
                        href={`/dashboard/licenses/${encodeURIComponent(order.licenseKey)}`}
                        className="font-mono text-[var(--color-primary)] hover:underline text-sm"
                      >
                        {order.licenseKey}
                      </Link>
                    </TD>
                    <TD>{order.plan}</TD>
                    <TD>
                      <div className="text-sm">
                        <span className="font-semibold">{order.finalPrice}</span>
                        <span className="text-[var(--color-muted)]"> credits</span>
                        {order.discountPercent > 0 && (
                          <span className="ml-1 text-xs text-[var(--color-success)]">
                            (−{order.discountPercent}%)
                          </span>
                        )}
                      </div>
                    </TD>
                    <TD>
                      <div className="text-xs text-[var(--color-muted)]">
                        {order.balanceBefore} → {order.balanceAfter}
                      </div>
                    </TD>
                    <TD>
                      <Badge tone={orderStatusTone(order.status)}>{order.status}</Badge>
                    </TD>
                    <TD>
                      <Badge tone={src.tone}>{src.text}</Badge>
                    </TD>
                    <TD>
                      <span className="text-sm text-[var(--color-muted)]">
                        {new Date(order.createdAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          {nextToken && (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
