"use client";

import * as React from "react";
import { api, ApiError } from "../../../models/api-client.ts";
import type { ResellerAccount } from "../../../models/types.ts";
import { PageHeader, ErrorText, SuccessText } from "../../../components/ui/feedback.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Input, Label } from "../../../components/ui/input.tsx";
import { Badge } from "../../../components/ui/badge.tsx";

export default function ResellersPage() {
  return (
    <>
      <PageHeader title="Resellers" description="Onboard reseller accounts and control their access." />
      <div className="grid gap-6 lg:grid-cols-2">
        <CreateReseller />
        <ResellerState />
      </div>
    </>
  );
}

function CreateReseller() {
  const [orgName, setOrgName] = React.useState("");
  const [contactEmail, setContactEmail] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<ResellerAccount | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setCreated(null);
    try {
      const acct = await api.createReseller({ orgName: orgName.trim(), contactEmail: contactEmail.trim() });
      setCreated(acct);
      setOrgName("");
      setContactEmail("");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.field ? err.field + ": " : ""}${err.message}` : "Create failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create reseller</CardTitle>
        <CardDescription>Both fields are required.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org">Organization name</Label>
            <Input id="org" required value={orgName} onChange={(e) => setOrgName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Contact email</Label>
            <Input id="email" type="email" required value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
          </div>
          {error && <ErrorText>{error}</ErrorText>}
          {created && (
            <div className="rounded-md bg-green-50 p-3 text-sm">
              <SuccessText>Created reseller account.</SuccessText>
              <p className="mt-1 font-mono text-xs break-all">ID: {created.resellerAccountId}</p>
            </div>
          )}
          <div><Button type="submit" disabled={saving}>{saving ? "Creating…" : "Create reseller"}</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function ResellerState() {
  const [id, setId] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ResellerAccount | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function change(state: "active" | "suspended") {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.setResellerState(id.trim(), state));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Suspend / reactivate</CardTitle>
        <CardDescription>Enter a reseller account ID.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rid">Reseller account ID</Label>
            <Input id="rid" value={id} onChange={(e) => setId(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button variant="danger" size="sm" disabled={busy || !id.trim()} onClick={() => change("suspended")}>Suspend</Button>
            <Button variant="outline" size="sm" disabled={busy || !id.trim()} onClick={() => change("active")}>Reactivate</Button>
          </div>
          {error && <ErrorText>{error}</ErrorText>}
          {result && (
            <p className="text-sm">
              State is now <Badge tone={result.state === "active" ? "success" : "warning"}>{result.state}</Badge>
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
