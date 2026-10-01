"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "../../../models/api-client.ts";
import type { ProductPlan } from "../../../models/types.ts";
import { PageHeader, Spinner, ErrorText, EmptyState } from "../../../components/ui/feedback.tsx";
import { Card, CardContent } from "../../../components/ui/card.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Input, Label } from "../../../components/ui/input.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Table, THead, TBody, TR, TH, TD } from "../../../components/ui/table.tsx";
import { useSession } from "../../../components/dashboard/session-provider.tsx";

/**
 * Admin-only Plans management page.
 * Allows creating, editing, and deactivating product plans.
 */
export default function PlansPage() {
  const router = useRouter();
  const { session } = useSession();
  const isAdmin = session?.role === "admin" || session?.role === "super_admin";

  // Redirect non-admin
  React.useEffect(() => {
    if (session && !isAdmin) {
      router.replace("/dashboard");
    }
  }, [session, isAdmin, router]);

  const [plans, setPlans] = React.useState<ProductPlan[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Form state
  const [showForm, setShowForm] = React.useState(false);
  const [editingPlan, setEditingPlan] = React.useState<ProductPlan | null>(null);
  const [formName, setFormName] = React.useState("");
  const [formDuration, setFormDuration] = React.useState("3");
  const [formPrice, setFormPrice] = React.useState("100");
  const [formMaxActivations, setFormMaxActivations] = React.useState("1");
  const [formFeatures, setFormFeatures] = React.useState("");
  const [formDescription, setFormDescription] = React.useState("");
  const [formSortOrder, setFormSortOrder] = React.useState("0");
  const [formSaving, setFormSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  async function loadPlans() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listPlans({ all: true });
      setPlans(res.plans);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load plans");
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    if (isAdmin) void loadPlans();
  }, [isAdmin]);

  function resetForm() {
    setEditingPlan(null);
    setFormName("");
    setFormDuration("3");
    setFormPrice("100");
    setFormMaxActivations("1");
    setFormFeatures("");
    setFormDescription("");
    setFormSortOrder("0");
    setFormError(null);
  }

  function openCreateForm() {
    resetForm();
    setShowForm(true);
  }

  function openEditForm(plan: ProductPlan) {
    setEditingPlan(plan);
    setFormName(plan.name);
    setFormDuration(String(plan.durationMonths));
    setFormPrice(String(plan.price));
    setFormMaxActivations(String(plan.maxActivations));
    setFormFeatures(plan.features.join(", "));
    setFormDescription(plan.description ?? "");
    setFormSortOrder(String(plan.sortOrder));
    setFormError(null);
    setShowForm(true);
  }

  async function onSubmitForm(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormSaving(true);
    try {
      if (editingPlan) {
        // Update
        await api.updatePlan(editingPlan.planId, {
          name: formName.trim(),
          durationMonths: Number(formDuration),
          price: Number(formPrice),
          maxActivations: Number(formMaxActivations),
          features: formFeatures.trim()
            ? formFeatures.split(",").map((f) => f.trim()).filter(Boolean)
            : [],
          description: formDescription.trim() || undefined,
          sortOrder: Number(formSortOrder),
        });
      } else {
        // Create
        await api.createPlan({
          name: formName.trim(),
          durationMonths: Number(formDuration),
          price: Number(formPrice),
          maxActivations: Number(formMaxActivations),
          features: formFeatures.trim()
            ? formFeatures.split(",").map((f) => f.trim()).filter(Boolean)
            : [],
          description: formDescription.trim() || undefined,
          sortOrder: Number(formSortOrder),
        });
      }
      setShowForm(false);
      resetForm();
      await loadPlans();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Failed to save plan");
    } finally {
      setFormSaving(false);
    }
  }

  async function togglePlanStatus(plan: ProductPlan) {
    try {
      const newStatus = plan.status === "active" ? "inactive" : "active";
      await api.updatePlan(plan.planId, { status: newStatus });
      await loadPlans();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update plan status");
    }
  }

  if (!isAdmin) return null;

  function durationLabel(months: number): string {
    if (months === 1) return "1 Month";
    if (months < 12) return `${months} Months`;
    if (months === 12) return "1 Year";
    if (months % 12 === 0) return `${months / 12} Years`;
    return `${months} Months`;
  }

  return (
    <>
      <PageHeader
        title="Product Plans"
        description="Manage the license plans available for purchase by distributors, resellers, and dealers."
        actions={
          <Button onClick={openCreateForm}>New Plan</Button>
        }
      />

      {/* Create / Edit Form */}
      {showForm && (
        <Card className="mb-6">
          <CardContent>
            <h3 className="text-sm font-semibold text-[var(--color-fg)] mb-4">
              {editingPlan ? `Edit: ${editingPlan.name}` : "Create New Plan"}
            </h3>
            <form onSubmit={onSubmitForm} className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="planName">Plan name *</Label>
                  <Input
                    id="planName"
                    required
                    placeholder="e.g. 3 Months License"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="planDuration">Duration (months) *</Label>
                  <Input
                    id="planDuration"
                    type="number"
                    min={1}
                    required
                    value={formDuration}
                    onChange={(e) => setFormDuration(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="planPrice">Price (credits) *</Label>
                  <Input
                    id="planPrice"
                    type="number"
                    min={0}
                    required
                    value={formPrice}
                    onChange={(e) => setFormPrice(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="planMaxAct">Max activations</Label>
                  <Input
                    id="planMaxAct"
                    type="number"
                    min={1}
                    value={formMaxActivations}
                    onChange={(e) => setFormMaxActivations(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="planFeatures">Features (comma-separated)</Label>
                  <Input
                    id="planFeatures"
                    placeholder="e.g. premium, support"
                    value={formFeatures}
                    onChange={(e) => setFormFeatures(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="planSort">
                    Sort order
                    <span className="ml-1 text-xs text-gray-500 font-normal">(display order on purchase page)</span>
                  </Label>
                  <Input
                    id="planSort"
                    type="number"
                    value={formSortOrder}
                    onChange={(e) => setFormSortOrder(e.target.value)}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Lower numbers appear first. Example: 1, 2, 3
                  </p>
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label htmlFor="planDesc">Description (optional)</Label>
                  <Input
                    id="planDesc"
                    placeholder="Short description for the plan card"
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                  />
                </div>
              </div>

              {formError && <ErrorText>{formError}</ErrorText>}

              <div className="flex gap-2">
                <Button type="submit" disabled={formSaving}>
                  {formSaving ? "Saving…" : editingPlan ? "Update Plan" : "Create Plan"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => { setShowForm(false); resetForm(); }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {error && <ErrorText className="mb-3">{error}</ErrorText>}

      {loading ? (
        <Spinner />
      ) : plans.length === 0 ? (
        <EmptyState
          title="No plans configured"
          hint="Create your first product plan so distributors and resellers can purchase licenses."
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Duration</TH>
              <TH>Price</TH>
              <TH>Max Activations</TH>
              <TH>Status</TH>
              <TH>Sort</TH>
              <TH>Actions</TH>
            </TR>
          </THead>
          <TBody>
            {plans.map((plan) => (
              <TR key={plan.planId}>
                <TD>
                  <div>
                    <span className="font-medium">{plan.name}</span>
                    {plan.description && (
                      <p className="text-xs text-[var(--color-muted)] mt-0.5">{plan.description}</p>
                    )}
                  </div>
                </TD>
                <TD>{durationLabel(plan.durationMonths)}</TD>
                <TD className="font-mono">{plan.price} credits</TD>
                <TD>{plan.maxActivations}</TD>
                <TD>
                  <Badge tone={plan.status === "active" ? "success" : "warning"}>
                    {plan.status}
                  </Badge>
                </TD>
                <TD>{plan.sortOrder}</TD>
                <TD>
                  <div className="flex gap-1">
                    <Button
                      variant="outline"
                      onClick={() => openEditForm(plan)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => togglePlanStatus(plan)}
                    >
                      {plan.status === "active" ? "Deactivate" : "Activate"}
                    </Button>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </>
  );
}
