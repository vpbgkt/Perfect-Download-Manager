"use client";

import * as React from "react";
import { api, ApiError } from "../../../models/api-client.ts";
import type { ReleaseMetadata } from "../../../models/types.ts";
import { PageHeader, Spinner, ErrorText, SuccessText } from "../../../components/ui/feedback.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Input, Label } from "../../../components/ui/input.tsx";

export default function ReleasesPage() {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [current, setCurrent] = React.useState<ReleaseMetadata | null>(null);

  const [form, setForm] = React.useState({
    version: "",
    channel: "Stable",
    msiUrl: "",
    portableZipUrl: "",
    msiSha256: "",
    portableSha256: "",
    portableSizeBytes: "",
    releaseNotes: "",
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const hydrate = React.useCallback((r: ReleaseMetadata | null) => {
    setCurrent(r);
    if (r) {
      setForm({
        version: r.version,
        channel: r.channel ?? "Stable",
        msiUrl: r.msiUrl,
        portableZipUrl: r.portableZipUrl,
        msiSha256: r.msiSha256,
        portableSha256: r.portableSha256,
        portableSizeBytes: r.portableSizeBytes != null ? String(r.portableSizeBytes) : "",
        releaseNotes: r.releaseNotes ?? "",
      });
    }
  }, []);

  React.useEffect(() => {
    (async () => {
      try {
        const res = await api.getRelease();
        hydrate(res.release);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Failed to load release");
      } finally {
        setLoading(false);
      }
    })();
  }, [hydrate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.publishRelease({
        version: form.version.trim(),
        channel: form.channel.trim() || undefined,
        msiUrl: form.msiUrl.trim(),
        portableZipUrl: form.portableZipUrl.trim(),
        msiSha256: form.msiSha256.trim(),
        portableSha256: form.portableSha256.trim(),
        portableSizeBytes: form.portableSizeBytes.trim() ? Number(form.portableSizeBytes) : undefined,
        releaseNotes: form.releaseNotes.trim() || undefined,
      });
      hydrate(res.release);
      setNotice("Release published and manifest signed.");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.field ? err.field + ": " : ""}${err.message}` : "Publish failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner />;

  return (
    <>
      <PageHeader title="Releases" description="Edit the current release and publish the signed manifest." />

      {current && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Current: v{current.version}</CardTitle>
            <CardDescription>
              {current.channel ?? "Stable"} · updated {current.updatedAt}
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card className="max-w-2xl">
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Version" id="version"><Input id="version" required value={form.version} onChange={set("version")} /></Field>
              <Field label="Channel" id="channel"><Input id="channel" value={form.channel} onChange={set("channel")} /></Field>
            </div>
            <Field label="MSI URL (S3)" id="msiUrl"><Input id="msiUrl" required value={form.msiUrl} onChange={set("msiUrl")} /></Field>
            <Field label="Portable ZIP URL (S3)" id="zip"><Input id="zip" required value={form.portableZipUrl} onChange={set("portableZipUrl")} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="MSI SHA-256" id="msiSha"><Input id="msiSha" required value={form.msiSha256} onChange={set("msiSha256")} /></Field>
              <Field label="Portable SHA-256" id="zipSha"><Input id="zipSha" required value={form.portableSha256} onChange={set("portableSha256")} /></Field>
            </div>
            <Field label="Portable size (bytes, optional)" id="size"><Input id="size" type="number" min={0} value={form.portableSizeBytes} onChange={set("portableSizeBytes")} /></Field>
            <Field label="Release notes (optional)" id="notes"><Input id="notes" value={form.releaseNotes} onChange={set("releaseNotes")} /></Field>

            {error && <ErrorText>{error}</ErrorText>}
            {notice && <SuccessText>{notice}</SuccessText>}

            <div>
              <Button type="submit" disabled={saving}>{saving ? "Publishing…" : "Publish release"}</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
