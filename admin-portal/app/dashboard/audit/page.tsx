"use client";

import * as React from "react";
import { api, ApiError } from "../../../models/api-client.ts";
import type { AuditEntry } from "../../../models/types.ts";
import { PageHeader, Spinner, ErrorText, EmptyState } from "../../../components/ui/feedback.tsx";
import { Card, CardContent } from "../../../components/ui/card.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Input, Label, Select } from "../../../components/ui/input.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Table, THead, TBody, TR, TH, TD } from "../../../components/ui/table.tsx";

type Dimension = "" | "actor" | "target" | "action";

export default function AuditPage() {
  const [dimension, setDimension] = React.useState<Dimension>("");
  const [value, setValue] = React.useState("");
  const [start, setStart] = React.useState("");
  const [end, setEnd] = React.useState("");
  const [entries, setEntries] = React.useState<AuditEntry[]>([]);
  const [nextToken, setNextToken] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [searched, setSearched] = React.useState(false);

  function buildOpts(token?: string) {
    const opts: Record<string, string | number | undefined> = {
      start: start.trim() || undefined,
      end: end.trim() || undefined,
      pageSize: 50,
      token,
    };
    if (dimension && value.trim()) opts[dimension] = value.trim();
    return opts;
  }

  async function search(reset: boolean) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.queryAudit(buildOpts(reset ? undefined : nextToken ?? undefined));
      setEntries((prev) => (reset ? res.entries : [...prev, ...res.entries]));
      setNextToken(res.nextToken);
      setSearched(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Query failed");
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void search(true);
  }

  return (
    <>
      <PageHeader title="Audit log" description="Query the append-only audit trail." />

      <Card className="mb-6">
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dim">Filter by</Label>
              <Select id="dim" value={dimension} onChange={(e) => setDimension(e.target.value as Dimension)}>
                <option value="">Time range only</option>
                <option value="actor">Actor</option>
                <option value="target">Target</option>
                <option value="action">Action</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="val">Value</Label>
              <Input id="val" disabled={!dimension} value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="start">Start (ISO UTC)</Label>
              <Input id="start" placeholder="2025-01-01T00:00:00Z" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="end">End (ISO UTC)</Label>
              <Input id="end" placeholder="2025-12-31T23:59:59Z" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
            <div className="sm:col-span-2 lg:col-span-4">
              <Button type="submit" disabled={loading}>{loading ? "Searching…" : "Search"}</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {error && <ErrorText className="mb-3">{error}</ErrorText>}

      {loading && entries.length === 0 ? (
        <Spinner />
      ) : searched && entries.length === 0 ? (
        <EmptyState title="No matching entries" />
      ) : entries.length > 0 ? (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Time</TH>
                <TH>Actor</TH>
                <TH>Role</TH>
                <TH>Action</TH>
                <TH>Target</TH>
                <TH>Source IP</TH>
              </TR>
            </THead>
            <TBody>
              {entries.map((e) => (
                <TR key={e.auditId}>
                  <TD className="whitespace-nowrap text-xs">{e.timestamp}</TD>
                  <TD className="font-mono text-xs">{e.actor}</TD>
                  <TD><Badge tone="info">{e.actorRole}</Badge></TD>
                  <TD className="font-mono text-xs">{e.action}</TD>
                  <TD className="font-mono text-xs break-all">{e.target}</TD>
                  <TD className="text-xs">{e.sourceIp}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {nextToken && (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" onClick={() => search(false)} disabled={loading}>
                {loading ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      ) : (
        <EmptyState title="Run a search" hint="Filter by actor, target, action, or time range." />
      )}
    </>
  );
}
