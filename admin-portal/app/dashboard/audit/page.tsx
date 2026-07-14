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

/** Known audit actions, grouped for the action picker. */
const ACTIONS: { group: string; actions: string[] }[] = [
  { group: "Licenses", actions: ["license.create", "license.status.update", "license.attributes.update", "license.activation.remove"] },
  { group: "Releases & SEO", actions: ["release.update", "seo.update"] },
  { group: "Resellers", actions: ["reseller.create", "reseller.suspend", "reseller.reactivate"] },
  { group: "Admins & keys", actions: ["admin.create", "apikey.create", "apikey.revoke", "apikey.plan.update"] },
];

function formatTs(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function preview(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

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
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  // Reset the value when switching dimension so an action code doesn't linger
  // in a free-text actor/target search.
  React.useEffect(() => {
    setValue("");
  }, [dimension]);

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
      if (reset) setExpanded(new Set());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Query failed");
    } finally {
      setLoading(false);
    }
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void search(true);
  }

  function reset() {
    setDimension("");
    setValue("");
    setStart("");
    setEnd("");
  }

  return (
    <>
      <PageHeader title="Audit log" description="Query the append-only audit trail by actor, target, action, or time range." />

      <Card className="mb-6">
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dim">Filter by</Label>
              <Select id="dim" value={dimension} onChange={(e) => setDimension(e.target.value as Dimension)}>
                <option value="">Time range only</option>
                <option value="action">Action</option>
                <option value="actor">Actor</option>
                <option value="target">Target</option>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="val">Value</Label>
              {dimension === "action" ? (
                <Select id="val" value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">Select an action…</option>
                  {ACTIONS.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.actions.map((a) => (
                        <option key={a} value={a}>{a}</option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              ) : (
                <Input
                  id="val"
                  disabled={!dimension}
                  placeholder={dimension === "target" ? "e.g. PDM-XXXX-…" : dimension === "actor" ? "Firebase UID / key id" : "Pick a filter first"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="start">Start (ISO UTC)</Label>
              <Input id="start" placeholder="2025-01-01T00:00:00Z" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="end">End (ISO UTC)</Label>
              <Input id="end" placeholder="2025-12-31T23:59:59Z" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>

            <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-4">
              <Button type="submit" disabled={loading}>{loading ? "Searching…" : "Search"}</Button>
              <Button type="button" variant="ghost" onClick={reset}>Clear filters</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {error && <ErrorText className="mb-3">{error}</ErrorText>}

      {loading && entries.length === 0 ? (
        <Spinner />
      ) : searched && entries.length === 0 ? (
        <EmptyState title="No matching entries" hint="Widen the time range or change the filter." />
      ) : entries.length > 0 ? (
        <>
          <p className="mb-2 text-sm text-[var(--color-muted)]">{entries.length} entr{entries.length === 1 ? "y" : "ies"} · click a row for change details</p>
          <Table>
            <THead>
              <TR>
                <TH>Time</TH>
                <TH>Action</TH>
                <TH>Target</TH>
                <TH>Actor</TH>
                <TH>Role</TH>
                <TH>Source IP</TH>
              </TR>
            </THead>
            <TBody>
              {entries.map((e) => {
                const changeKeys = Object.keys(e.changes ?? {});
                const isOpen = expanded.has(e.auditId);
                return (
                  <React.Fragment key={e.auditId}>
                    <TR
                      className="cursor-pointer hover:bg-gray-50"
                      onClick={() => changeKeys.length > 0 && toggle(e.auditId)}
                    >
                      <TD className="whitespace-nowrap text-xs" title={e.timestamp}>{formatTs(e.timestamp)}</TD>
                      <TD className="font-mono text-xs">{e.action}</TD>
                      <TD className="font-mono text-xs break-all">{e.target}</TD>
                      <TD className="font-mono text-xs break-all">{e.actor}</TD>
                      <TD><Badge tone="info">{e.actorRole}</Badge></TD>
                      <TD className="text-xs">{e.sourceIp}</TD>
                    </TR>
                    {isOpen && changeKeys.length > 0 && (
                      <TR>
                        <TD className="bg-gray-50 text-xs" colSpan={6}>
                          <div className="flex flex-col gap-1 py-1">
                            {changeKeys.map((k) => (
                              <div key={k} className="grid grid-cols-[10rem_1fr] gap-2">
                                <span className="font-medium">{k}</span>
                                <span className="font-mono break-all">
                                  <span className="text-[var(--color-danger)]">{preview(e.changes[k]?.before)}</span>
                                  {" → "}
                                  <span className="text-[var(--color-success)]">{preview(e.changes[k]?.after)}</span>
                                </span>
                              </div>
                            ))}
                          </div>
                        </TD>
                      </TR>
                    )}
                  </React.Fragment>
                );
              })}
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
        <EmptyState title="Run a search" hint="Filter by action, actor, target, or a time range." />
      )}
    </>
  );
}
