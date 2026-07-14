"use client";

import * as React from "react";
import { api, ApiError } from "../../../../models/api-client.ts";
import type { LicenseView } from "../../../../models/types.ts";
import { PageHeader, Spinner, ErrorText, SuccessText, EmptyState } from "../../../../components/ui/feedback.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card.tsx";
import { Button } from "../../../../components/ui/button.tsx";
import { LinkButton } from "../../../../components/ui/link-button.tsx";
import { Input, Label } from "../../../../components/ui/input.tsx";
import { Badge, statusTone } from "../../../../components/ui/badge.tsx";
import { Table, THead, TBody, TR, TH, TD } from "../../../../components/ui/table.tsx";

const STATUSES = ["active", "revoked", "suspended"] as const;

export default function LicenseDetailPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = React.use(params);
  const licenseKey = decodeURIComponent(key);

  const [license, setLicense] = React.useState<LicenseView | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // edit form fields
  const [plan, setPlan] = React.useState("");
  const [maxActivations, setMaxActivations] = React.useState("");
  const [owner, setOwner] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [features, setFeatures] = React.useState("");

  const hydrate = React.useCallback((v: LicenseView) => {
    setLicense(v);
    setPlan(v.plan ?? "");
    setMaxActivations(v.maxActivations != null ? String(v.maxActivations) : "");
    setOwner(v.owner ?? "");
    setExpiresAt(v.expiresAt ?? "");
    setFeatures((v.features ?? []).join(", "));
  }, []);

  const reload = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      hydrate(await api.getLicense(licenseKey));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load license");
    } finally {
      setLoading(false);
    }
  }, [licenseKey, hydrate]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  async function run(fn: () => Promise<unknown>, successMsg: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      hydrate(await api.getLicense(licenseKey));
      setNotice(successMsg);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.field ? err.field + ": " : ""}${err.message}` : "Operation failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveAttributes(e: React.FormEvent) {
    e.preventDefault();
    await run(
      () =>
        api.updateLicense(licenseKey, {
          plan: plan.trim() || undefined,
          maxActivations: maxActivations.trim() ? Number(maxActivations) : undefined,
          // empty string clears expiry (perpetual)
          expiresAt: expiresAt.trim() === "" ? null : expiresAt.trim(),
          owner: owner.trim() || undefined,
          features: features.trim() ? features.split(",").map((f) => f.trim()).filter(Boolean) : [],
        }),
      "Attributes updated."
    );
  }

  if (loading) return <Spinner />;
  if (!license) return <ErrorText>{error ?? "License not found."}</ErrorText>;

  return (
    <>
      <PageHeader
        title={licenseKey}
        description="License detail"
        actions={<LinkButton href="/dashboard/licenses" variant="ghost">Back to list</LinkButton>}
      />

      {error && <ErrorText className="mb-3">{error}</ErrorText>}
      {notice && <div className="mb-3"><SuccessText>{notice}</SuccessText></div>}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Status */}
        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--color-muted)]">Current:</span>
              <Badge tone={statusTone(license.status)}>{license.status}</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              {STATUSES.map((s) => (
                <Button
                  key={s}
                  variant={s === license.status ? "secondary" : "outline"}
                  size="sm"
                  disabled={busy || s === license.status}
                  onClick={() => run(() => api.setLicenseStatus(licenseKey, s), `Status set to ${s}.`)}
                >
                  Set {s}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Attributes */}
        <Card>
          <CardHeader>
            <CardTitle>Attributes</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveAttributes} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plan">Plan</Label>
                <Input id="plan" value={plan} onChange={(e) => setPlan(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="max">Max activations</Label>
                <Input id="max" type="number" min={1} value={maxActivations} onChange={(e) => setMaxActivations(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="owner">Owner</Label>
                <Input id="owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="expires">Expires at (empty = perpetual)</Label>
                <Input id="expires" placeholder="2030-01-01T00:00:00Z" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="features">Features (comma-separated)</Label>
                <Input id="features" value={features} onChange={(e) => setFeatures(e.target.value)} />
              </div>
              <div>
                <Button type="submit" disabled={busy}>Save attributes</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>

      {/* Activations */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>
            Activations ({license.activationCount}
            {license.maxActivations ? ` / ${license.maxActivations}` : ""})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {license.activations.length === 0 ? (
            <EmptyState title="No activations" hint="This license has no active machines." />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Fingerprint</TH>
                  <TH>Activated</TH>
                  <TH>Last seen</TH>
                  <TH className="text-right">Action</TH>
                </TR>
              </THead>
              <TBody>
                {license.activations.map((a) => (
                  <TR key={a.fingerprint}>
                    <TD className="font-mono text-xs">{a.fingerprint}</TD>
                    <TD>{a.activatedAt ?? "—"}</TD>
                    <TD>{a.lastSeenAt ?? "—"}</TD>
                    <TD className="text-right">
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={busy}
                        onClick={() => run(() => api.removeActivation(licenseKey, a.fingerprint), "Activation removed.")}
                      >
                        Remove
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
