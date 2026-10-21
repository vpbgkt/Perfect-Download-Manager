"use client";

import * as React from "react";
import { api, ApiError } from "../../../models/api-client.ts";
import type { ResellerAccount } from "../../../models/types.ts";
import { PageHeader, ErrorText, SuccessText, Spinner, EmptyState } from "../../../components/ui/feedback.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Input, Label } from "../../../components/ui/input.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Table, THead, TBody, TR, TH, TD } from "../../../components/ui/table.tsx";

export default function ResellersPage() {
  const [items, setItems] = React.useState<ResellerAccount[]>([]);
  const [nextToken, setNextToken] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");

  const load = React.useCallback(async (append: boolean, token?: string) => {
    append ? setBusyId("__more__") : setLoading(true);
    setError(null);
    try {
      const res = await api.listResellers({ limit: 50, nextToken: token });
      setItems((prev) => (append ? [...prev, ...res.items] : res.items));
      setNextToken(res.nextToken);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load resellers");
    } finally {
      setLoading(false);
      setBusyId(null);
    }
  }, []);

  React.useEffect(() => {
    void load(false);
  }, [load]);

  async function toggleState(r: ResellerAccount) {
    const target = r.state === "active" ? "suspended" : "active";
    setBusyId(r.resellerAccountId);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.setResellerState(r.resellerAccountId, target);
      setItems((prev) => prev.map((x) => (x.resellerAccountId === r.resellerAccountId ? { ...x, state: updated.state } : x)));
      setNotice(`${r.orgName} is now ${updated.state}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  }

  const filtered = search.trim()
    ? items.filter((r) => {
        const q = search.trim().toLowerCase();
        return (
          r.orgName.toLowerCase().includes(q) ||
          r.contactEmail.toLowerCase().includes(q) ||
          r.resellerAccountId.toLowerCase().includes(q)
        );
      })
    : items;

  return (
    <>
      <PageHeader title="Resellers" description="All reseller accounts and their access state." />

      <CreateReseller onCreated={() => load(false)} />

      {notice && <div className="mt-4"><SuccessText>{notice}</SuccessText></div>}
      {error && <div className="mt-4"><ErrorText>{error}</ErrorText></div>}

      <div className="mt-6 mb-3 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Accounts ({items.length})</h2>
        <Input
          className="max-w-xs"
          placeholder="Filter by name, email, or ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Filter resellers"
        />
      </div>

      {loading ? (
        <Spinner />
      ) : filtered.length === 0 ? (
        <EmptyState title="No resellers found" hint="Create one above to get started." />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Organization</TH>
                <TH>Contact</TH>
                <TH>Type</TH>
                <TH>Balance</TH>
                <TH>Discount</TH>
                <TH>Account ID</TH>
                <TH>State</TH>
                <TH className="text-right">Action</TH>
              </TR>
            </THead>
            <TBody>
              {filtered.map((r) => (
                <TR key={r.resellerAccountId}>
                  <TD className="font-medium">{r.orgName}</TD>
                  <TD>{r.contactEmail}</TD>
                  <TD>
                    <Badge tone={
                      r.accountType === "distributor" ? "info" : 
                      r.accountType === "dealer" ? "warning" : 
                      "default"
                    }>
                      {r.accountType || "reseller"}
                    </Badge>
                  </TD>
                  <TD>
                    <span className={`font-mono ${(r.balance ?? 0) < 100 ? "text-orange-600 font-bold" : ""}`}>
                      {(r.balance ?? 0).toLocaleString()}
                    </span>
                  </TD>
                  <TD className="text-gray-600">{r.discountPercent ?? 0}%</TD>
                  <TD className="font-mono text-xs break-all">{r.resellerAccountId}</TD>
                  <TD>
                    <Badge tone={r.state === "active" ? "success" : "warning"}>{r.state}</Badge>
                  </TD>
                  <TD className="text-right">
                    <Button
                      variant={r.state === "active" ? "danger" : "outline"}
                      size="sm"
                      disabled={busyId === r.resellerAccountId}
                      onClick={() => toggleState(r)}
                    >
                      {busyId === r.resellerAccountId
                        ? "…"
                        : r.state === "active"
                          ? "Suspend"
                          : "Reactivate"}
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {nextToken && (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" onClick={() => load(true, nextToken ?? undefined)} disabled={busyId === "__more__"}>
                {busyId === "__more__" ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function CreateReseller({ onCreated }: { onCreated: () => void }) {
  const [orgName, setOrgName] = React.useState("");
  const [contactEmail, setContactEmail] = React.useState("");
  const [accountType, setAccountType] = React.useState<"distributor" | "reseller" | "dealer">("reseller");
  const [password, setPassword] = React.useState("");
  const [initialBalance, setInitialBalance] = React.useState("0");
  const [discountPercent, setDiscountPercent] = React.useState("0");
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<ResellerAccount | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setCreated(null);
    try {
      const acct = await api.createReseller({
        orgName: orgName.trim(),
        contactEmail: contactEmail.trim(),
        accountType,
        password: password.trim(),
        initialBalance: parseFloat(initialBalance) || 0,
        discountPercent: parseFloat(discountPercent) || 0,
      });
      setCreated(acct);
      setOrgName("");
      setContactEmail("");
      setPassword("");
      setAccountType("reseller");
      setInitialBalance("0");
      setDiscountPercent("0");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.field ? err.field + ": " : ""}${err.message}` : "Create failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create account</CardTitle>
        <CardDescription>Create a new distributor, reseller, or dealer account with initial balance and discount.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          {/* Row 1: Account Type */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="accountType">Account Type</Label>
            <select
              id="accountType"
              value={accountType}
              onChange={(e) => setAccountType(e.target.value as "distributor" | "reseller" | "dealer")}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              required
            >
              <option value="distributor">Distributor (Top tier - can create resellers)</option>
              <option value="reseller">Reseller (Mid tier - can create dealers)</option>
              <option value="dealer">Dealer (Bottom tier - end customer)</option>
            </select>
          </div>

          {/* Row 2: Org Name & Email */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="org">Organization name</Label>
              <Input id="org" required value={orgName} onChange={(e) => setOrgName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Contact email</Label>
              <Input id="email" type="email" required value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
            </div>
          </div>

          {/* Row 3: Password */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Minimum 8 characters"
              minLength={8}
            />
            <span className="text-xs text-gray-500">User can change this after first login</span>
          </div>

          {/* Row 4: Balance & Discount */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="balance">Initial Balance (credits)</Label>
              <Input
                id="balance"
                type="number"
                min="0"
                step="1"
                value={initialBalance}
                onChange={(e) => setInitialBalance(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="discount">Discount Percent (%)</Label>
              <Input
                id="discount"
                type="number"
                min="0"
                max="100"
                step="1"
                value={discountPercent}
                onChange={(e) => setDiscountPercent(e.target.value)}
              />
            </div>
          </div>

          <Button type="submit" disabled={saving}>{saving ? "Creating…" : "Create Account"}</Button>
        </form>
        {error && <div className="mt-3"><ErrorText>{error}</ErrorText></div>}
        {created && (
          <div className="mt-3">
            <SuccessText>Account created successfully!</SuccessText>
            <div className="mt-2 text-sm">
              <div className="font-mono text-xs break-all">ID: {created.resellerAccountId}</div>
              <div className="text-xs text-gray-600 mt-1">Type: {created.accountType}</div>
              <div className="text-xs text-gray-600">Balance: {created.balance} credits</div>
              <div className="text-xs text-gray-600">Discount: {created.discountPercent}%</div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
