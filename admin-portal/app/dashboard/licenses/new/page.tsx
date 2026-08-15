"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "../../../../models/api-client.ts";
import { PageHeader, ErrorText } from "../../../../components/ui/feedback.tsx";
import { Card, CardContent } from "../../../../components/ui/card.tsx";
import { Button } from "../../../../components/ui/button.tsx";
import { Input, Label } from "../../../../components/ui/input.tsx";
import { ExpiryField } from "../../../../components/ui/expiry-field.tsx";
import { useSession } from "../../../../components/dashboard/session-provider.tsx";

export default function NewLicensePage() {
  const router = useRouter();
  const { session } = useSession();
  const [plan, setPlan] = React.useState("standard");
  const [maxActivations, setMaxActivations] = React.useState("1");
  const [owner, setOwner] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [features, setFeatures] = React.useState("");

  // Customer fields
  const [customerName, setCustomerName] = React.useState("");
  const [customerEmail, setCustomerEmail] = React.useState("");
  const [customerPhone, setCustomerPhone] = React.useState("");
  const [customerCountry, setCustomerCountry] = React.useState("");
  const [customerCompany, setCustomerCompany] = React.useState("");
  const [customerNotes, setCustomerNotes] = React.useState("");

  // Custom key prefix (admin/super_admin only)
  const [keyPrefix, setKeyPrefix] = React.useState("");

  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const isAdmin = session?.role === "admin" || session?.role === "super_admin";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const created = await api.createLicense({
        plan: plan.trim() || undefined,
        maxActivations: Number(maxActivations),
        owner: owner.trim() || undefined,
        expiresAt: expiresAt.trim() || undefined,
        features: features.trim()
          ? features.split(",").map((f) => f.trim()).filter(Boolean)
          : undefined,
        keyPrefix: keyPrefix.trim() || undefined,
        customerName: customerName.trim() || undefined,
        customerEmail: customerEmail.trim() || undefined,
        customerPhone: customerPhone.trim() || undefined,
        customerCountry: customerCountry.trim() || undefined,
        customerCompany: customerCompany.trim() || undefined,
        customerNotes: customerNotes.trim() || undefined,
      });
      router.push(`/dashboard/licenses/${encodeURIComponent(created.licenseKey)}`);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields && err.fields.length > 0) {
          setError(err.fields.map((f) => `${f.field}: ${f.reason}`).join("; "));
        } else {
          setError(`${err.field ? err.field + ": " : ""}${err.message}`);
        }
      } else {
        setError("Failed to create license");
      }
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader title="New license" description="Mint a new license key." />
      <Card className="max-w-xl">
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan">Plan</Label>
              <Input id="plan" value={plan} onChange={(e) => setPlan(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="max">Max activations</Label>
              <Input
                id="max"
                type="number"
                min={1}
                required
                value={maxActivations}
                onChange={(e) => setMaxActivations(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="owner">Owner (optional)</Label>
              <Input id="owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
            </div>
            <ExpiryField id="expires" label="Expires at (optional)" value={expiresAt} onChange={setExpiresAt} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="features">Features (comma-separated, optional)</Label>
              <Input id="features" value={features} onChange={(e) => setFeatures(e.target.value)} />
            </div>

            {/* Customer information block */}
            <div className="flex flex-col gap-3 border-t pt-4 mt-2">
              <div>
                <h3 className="text-sm font-medium text-[var(--color-fg)]">Customer information</h3>
                <p className="text-xs text-[var(--color-muted)] mt-0.5">Optional, but recommended</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="customerName">Name</Label>
                <Input id="customerName" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="customerEmail">Email</Label>
                <Input id="customerEmail" type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="customerPhone">Phone</Label>
                <Input id="customerPhone" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="customerCountry">Country code</Label>
                <Input id="customerCountry" maxLength={2} placeholder="e.g. US" value={customerCountry} onChange={(e) => setCustomerCountry(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="customerCompany">Company</Label>
                <Input id="customerCompany" value={customerCompany} onChange={(e) => setCustomerCompany(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="customerNotes">Notes</Label>
                <Input id="customerNotes" value={customerNotes} onChange={(e) => setCustomerNotes(e.target.value)} />
              </div>
            </div>

            {/* Custom key prefix — admin/super_admin only */}
            {isAdmin && (
              <div className="flex flex-col gap-1.5 border-t pt-4 mt-2">
                <Label htmlFor="keyPrefix">Custom key prefix (optional)</Label>
                <Input
                  id="keyPrefix"
                  maxLength={32}
                  placeholder="e.g. NEW-YEAR"
                  value={keyPrefix}
                  onChange={(e) => setKeyPrefix(e.target.value)}
                />
              </div>
            )}

            {error && <ErrorText>{error}</ErrorText>}

            <div className="flex gap-2">
              <Button type="submit" disabled={saving}>
                {saving ? "Creating…" : "Create license"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
