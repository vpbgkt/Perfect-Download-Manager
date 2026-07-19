"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError } from "../../../models/api-client.ts";
import type { LicenseSummary } from "../../../models/types.ts";
import { PageHeader, Spinner, ErrorText, EmptyState } from "../../../components/ui/feedback.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { LinkButton } from "../../../components/ui/link-button.tsx";
import { Input } from "../../../components/ui/input.tsx";
import { Badge, statusTone } from "../../../components/ui/badge.tsx";
import { Table, THead, TBody, TR, TH, TD } from "../../../components/ui/table.tsx";

export default function LicensesPage() {
  const [items, setItems] = React.useState<LicenseSummary[]>([]);
  const [search, setSearch] = React.useState("");
  const [nextToken, setNextToken] = React.useState<string | undefined>();
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async (term: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listLicenses({ search: term || undefined, limit: 25 });
      setItems(res.items);
      setNextToken(res.nextToken);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load licenses");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load("");
  }, [load]);

  async function loadMore() {
    if (!nextToken) return;
    setLoadingMore(true);
    try {
      const res = await api.listLicenses({ search: search || undefined, limit: 25, nextToken });
      setItems((prev) => [...prev, ...res.items]);
      setNextToken(res.nextToken);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    void load(search);
  }

  return (
    <>
      <PageHeader
        title="Licenses"
        description="Search by license key or owner."
        actions={<LinkButton href="/dashboard/licenses/new">New license</LinkButton>}
      />

      <form onSubmit={onSearch} className="mb-4 flex gap-2">
        <Input
          placeholder="Search key or owner…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search licenses"
        />
        <Button type="submit" variant="outline">Search</Button>
      </form>

      {error && <ErrorText className="mb-3">{error}</ErrorText>}

      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title="No licenses found" hint="Try a different search, or create a new license." />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>License Key</TH>
                <TH>Status</TH>
                <TH>Plan</TH>
                <TH>Owner</TH>
                <TH>Activations</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((l) => (
                <TR key={l.licenseKey}>
                  <TD>
                    <Link
                      href={`/dashboard/licenses/${encodeURIComponent(l.licenseKey)}`}
                      className="font-mono text-[var(--color-primary)] hover:underline"
                    >
                      {l.licenseKey}
                    </Link>
                  </TD>
                  <TD><Badge tone={statusTone(l.status)}>{l.status}</Badge></TD>
                  <TD>{l.plan ?? "—"}</TD>
                  <TD>{l.owner ?? "—"}</TD>
                  <TD>{l.activationCount}{l.maxActivations ? ` / ${l.maxActivations}` : ""}</TD>
                </TR>
              ))}
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
