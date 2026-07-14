"use client";

import * as React from "react";
import { api, ApiError } from "../../../models/api-client.ts";
import type { SeoSettings } from "../../../models/types.ts";
import { PageHeader, Spinner, ErrorText, SuccessText, EmptyState } from "../../../components/ui/feedback.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Input, Label } from "../../../components/ui/input.tsx";
import { Table, THead, TBody, TR, TH, TD } from "../../../components/ui/table.tsx";

const EMPTY = { pageId: "", title: "", metaDescription: "", ogTitle: "", ogDescription: "", ogImage: "" };

export default function SeoPage() {
  const [pages, setPages] = React.useState<SeoSettings[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState({ ...EMPTY });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listSeo();
      setPages(res.pages);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load SEO settings");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  function edit(p: SeoSettings) {
    setForm({
      pageId: p.pageId,
      title: p.title,
      metaDescription: p.metaDescription,
      ogTitle: p.ogTitle ?? "",
      ogDescription: p.ogDescription ?? "",
      ogImage: p.ogImage ?? "",
    });
    setNotice(null);
    setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.updateSeo(form.pageId.trim(), {
        title: form.title,
        metaDescription: form.metaDescription,
        ogTitle: form.ogTitle.trim() || undefined,
        ogDescription: form.ogDescription.trim() || undefined,
        ogImage: form.ogImage.trim() || undefined,
      });
      setNotice(`Saved SEO for "${form.pageId.trim()}".`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.field ? err.field + ": " : ""}${err.message}` : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader title="SEO settings" description="Edit marketing-site page titles, meta descriptions, and Open Graph tags." />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Managed pages</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Spinner />
            ) : pages.length === 0 ? (
              <EmptyState title="No pages yet" hint="Add one using the editor." />
            ) : (
              <Table>
                <THead>
                  <TR><TH>Page</TH><TH>Title</TH><TH className="text-right">Edit</TH></TR>
                </THead>
                <TBody>
                  {pages.map((p) => (
                    <TR key={p.pageId}>
                      <TD className="font-mono">{p.pageId}</TD>
                      <TD className="max-w-[16rem] truncate">{p.title}</TD>
                      <TD className="text-right">
                        <Button variant="outline" size="sm" onClick={() => edit(p)}>Edit</Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{form.pageId ? `Editing: ${form.pageId}` : "Editor"}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pageId">Page ID</Label>
                <Input id="pageId" required placeholder="home" value={form.pageId} onChange={set("pageId")} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="title">Title (1–70 chars)</Label>
                <Input id="title" required value={form.title} onChange={set("title")} />
                <span className="text-xs text-[var(--color-muted)]">{form.title.trim().length}/70</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="meta">Meta description (50–160 chars)</Label>
                <Input id="meta" required value={form.metaDescription} onChange={set("metaDescription")} />
                <span className="text-xs text-[var(--color-muted)]">{form.metaDescription.trim().length}/160</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ogTitle">og:title (optional)</Label>
                <Input id="ogTitle" value={form.ogTitle} onChange={set("ogTitle")} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ogDesc">og:description (optional)</Label>
                <Input id="ogDesc" value={form.ogDescription} onChange={set("ogDescription")} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ogImage">og:image URL (optional)</Label>
                <Input id="ogImage" value={form.ogImage} onChange={set("ogImage")} />
              </div>

              {error && <ErrorText>{error}</ErrorText>}
              {notice && <SuccessText>{notice}</SuccessText>}

              <div className="flex gap-2">
                <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save page"}</Button>
                <Button type="button" variant="ghost" onClick={() => setForm({ ...EMPTY })}>Clear</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
