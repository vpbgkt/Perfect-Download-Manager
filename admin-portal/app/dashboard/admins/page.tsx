"use client";

import * as React from "react";
import { api, ApiError } from "../../../models/api-client.ts";
import { PageHeader, ErrorText, SuccessText } from "../../../components/ui/feedback.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Input, Label, Select } from "../../../components/ui/input.tsx";

export default function AdminsPage() {
  const [firebaseUid, setFirebaseUid] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<"admin" | "super_admin">("admin");
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createAdmin({ firebaseUid: firebaseUid.trim(), email: email.trim(), role });
      setNotice(`Admin ${email.trim()} created with role ${role}.`);
      setFirebaseUid("");
      setEmail("");
      setRole("admin");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.field ? err.field + ": " : ""}${err.message}` : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Admins" description="Create portal admin users." />
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Create admin user</CardTitle>
          <CardDescription>
            The user must already exist in Firebase Authentication; enter their Firebase UID.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="uid">Firebase UID</Label>
              <Input id="uid" required value={firebaseUid} onChange={(e) => setFirebaseUid(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="role">Role</Label>
              <Select id="role" value={role} onChange={(e) => setRole(e.target.value as "admin" | "super_admin")}>
                <option value="admin">admin</option>
                <option value="super_admin">super_admin</option>
              </Select>
            </div>
            {error && <ErrorText>{error}</ErrorText>}
            {notice && <SuccessText>{notice}</SuccessText>}
            <div><Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create admin"}</Button></div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
