"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "../../../../models/api-client.ts";
import { PageHeader, ErrorText } from "../../../../components/ui/feedback.tsx";
import { Card, CardContent } from "../../../../components/ui/card.tsx";
import { Button } from "../../../../components/ui/button.tsx";
import { Input, Label } from "../../../../components/ui/input.tsx";

export default function NewLicensePage() {
  const router = useRouter();
  const [plan, setPlan] = React.useState("standard");
  const [maxActivations, setMaxActivations] = React.useState("1");
  const [owner, setOwner] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [features, setFeatures] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

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
      });
      router.push(`/dashboard/licenses/${encodeURIComponent(created.licenseKey)}`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.field ? err.field + ": " : ""}${err.message}`
          : "Failed to create license"
      );
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
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expires">Expires at (ISO 8601 UTC, optional)</Label>
              <Input
                id="expires"
                placeholder="2030-01-01T00:00:00Z"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="features">Features (comma-separated, optional)</Label>
              <Input id="features" value={features} onChange={(e) => setFeatures(e.target.value)} />
            </div>

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
