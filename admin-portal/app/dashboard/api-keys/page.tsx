"use client";

import * as React from "react";
import { api, ApiError } from "../../../models/api-client.ts";
import type { IssuedApiKey, UsagePlan } from "../../../models/types.ts";
import { PageHeader, ErrorText, SuccessText } from "../../../components/ui/feedback.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Input, Label } from "../../../components/ui/input.tsx";

/** Parse the optional plan fields; empty → undefined (portal default applies). */
function planFrom(rate: string, burst: string, quota: string): Partial<UsagePlan> {
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
  return { rateLimitPerSec: num(rate), burst: num(burst), monthlyQuota: num(quota) };
}

export default function ApiKeysPage() {
  return (
    <>
      <PageHeader title="API keys" description="Issue, revoke, and re-plan reseller API keys." />
      <div className="grid gap-6 lg:grid-cols-2">
        <IssueKey />
        <div className="flex flex-col gap-6">
          <RevokeKey />
          <ChangePlan />
        </div>
      </div>
    </>
  );
}

function PlanFields({
  rate, burst, quota, setRate, setBurst, setQuota,
}: {
  rate: string; burst: string; quota: string;
  setRate: (v: string) => void; setBurst: (v: string) => void; setQuota: (v: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="rate">Rate/sec</Label>
        <Input id="rate" type="number" min={0} placeholder="default" value={rate} onChange={(e) => setRate(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="burst">Burst</Label>
        <Input id="burst" type="number" min={0} placeholder="default" value={burst} onChange={(e) => setBurst(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="quota">Monthly quota</Label>
        <Input id="quota" type="number" min={0} placeholder="default" value={quota} onChange={(e) => setQuota(e.target.value)} />
      </div>
    </div>
  );
}

function IssueKey() {
  const [resellerId, setResellerId] = React.useState("");
  const [rate, setRate] = React.useState("");
  const [burst, setBurst] = React.useState("");
  const [quota, setQuota] = React.useState("");
  const [issued, setIssued] = React.useState<IssuedApiKey | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setIssued(null);
    try {
      setIssued(await api.issueApiKey(resellerId.trim(), planFrom(rate, burst, quota)));
    } catch (err) {
      setError(err instanceof ApiError ? `${err.field ? err.field + ": " : ""}${err.message}` : "Issue failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Issue API key</CardTitle>
        <CardDescription>The secret is shown once — copy it now.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rid">Reseller account ID</Label>
            <Input id="rid" required value={resellerId} onChange={(e) => setResellerId(e.target.value)} />
          </div>
          <PlanFields rate={rate} burst={burst} quota={quota} setRate={setRate} setBurst={setBurst} setQuota={setQuota} />
          {error && <ErrorText>{error}</ErrorText>}
          {issued && (
            <div className="rounded-md bg-green-50 p-3 text-sm">
              <SuccessText>API key issued.</SuccessText>
              <p className="mt-1 text-xs">Key ID: <span className="font-mono">{issued.apiKeyId}</span></p>
              <p className="mt-1 text-xs">Secret (copy now):</p>
              <code className="mt-1 block break-all rounded bg-white p-2 font-mono text-xs">{issued.secret}</code>
            </div>
          )}
          <div><Button type="submit" disabled={busy}>{busy ? "Issuing…" : "Issue key"}</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function RevokeKey() {
  const [id, setId] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function onRevoke() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.revokeApiKey(id.trim());
      setNotice(`Key ${res.apiKeyId} is now ${res.state}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Revoke failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Revoke key</CardTitle></CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="revid">API key ID</Label>
            <Input id="revid" value={id} onChange={(e) => setId(e.target.value)} />
          </div>
          {error && <ErrorText>{error}</ErrorText>}
          {notice && <SuccessText>{notice}</SuccessText>}
          <div><Button variant="danger" size="sm" disabled={busy || !id.trim()} onClick={onRevoke}>Revoke</Button></div>
        </div>
      </CardContent>
    </Card>
  );
}

function ChangePlan() {
  const [id, setId] = React.useState("");
  const [rate, setRate] = React.useState("");
  const [burst, setBurst] = React.useState("");
  const [quota, setQuota] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.changeApiKeyPlan(id.trim(), planFrom(rate, burst, quota));
      setNotice(`Updated plan for ${res.apiKeyId}: ${res.usagePlan.rateLimitPerSec}/s, burst ${res.usagePlan.burst}, quota ${res.usagePlan.monthlyQuota}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Change usage plan</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="planid">API key ID</Label>
            <Input id="planid" required value={id} onChange={(e) => setId(e.target.value)} />
          </div>
          <PlanFields rate={rate} burst={burst} quota={quota} setRate={setRate} setBurst={setBurst} setQuota={setQuota} />
          {error && <ErrorText>{error}</ErrorText>}
          {notice && <SuccessText>{notice}</SuccessText>}
          <div><Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : "Update plan"}</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}
