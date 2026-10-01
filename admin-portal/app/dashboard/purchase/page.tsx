"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "../../../models/api-client.ts";
import type { ProductPlan } from "../../../models/types.ts";
import { PageHeader, ErrorText, Spinner } from "../../../components/ui/feedback.tsx";
import { Card, CardContent } from "../../../components/ui/card.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Input, Label } from "../../../components/ui/input.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { useSession } from "../../../components/dashboard/session-provider.tsx";

interface PricePreview {
  basePrice: number;
  discountPercent: number;
  discountAmount: number;
  finalPrice: number;
  balance: number;
  sufficient: boolean;
}

export default function PurchaseLicensePage() {
  const router = useRouter();
  const { session } = useSession();

  // Redirect admin users to /dashboard/licenses/new
  const isAdmin = session?.role === "admin" || session?.role === "super_admin";
  React.useEffect(() => {
    if (isAdmin) {
      router.replace("/dashboard/licenses/new");
    }
  }, [isAdmin, router]);

  const [plans, setPlans] = React.useState<ProductPlan[]>([]);
  const [loadingPlans, setLoadingPlans] = React.useState(true);
  const [selectedPlan, setSelectedPlan] = React.useState<ProductPlan | null>(null);

  // Customer fields
  const [customerName, setCustomerName] = React.useState("");
  const [customerEmail, setCustomerEmail] = React.useState("");
  const [customerPhone, setCustomerPhone] = React.useState("");
  const [customerCountry, setCustomerCountry] = React.useState("");
  const [customerCompany, setCustomerCompany] = React.useState("");
  const [customerNotes, setCustomerNotes] = React.useState("");

  const [pricePreview, setPricePreview] = React.useState<PricePreview | null>(null);
  const [loadingPrice, setLoadingPrice] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Load active plans
  React.useEffect(() => {
    api
      .listPlans()
      .then((res) => setPlans(res.plans))
      .catch(() => setError("Failed to load available plans"))
      .finally(() => setLoadingPlans(false));
  }, []);

  // Load price preview when a plan is selected
  React.useEffect(() => {
    if (!selectedPlan || !session?.resellerAccountId) return;
    setLoadingPrice(true);
    api
      .getLicensePrice(session.resellerAccountId, selectedPlan.planId)
      .then((data) => setPricePreview(data))
      .catch(() => setPricePreview(null))
      .finally(() => setLoadingPrice(false));
  }, [selectedPlan, session?.resellerAccountId]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPlan) {
      setError("Please select a plan");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const created = await api.createLicense({
        plan: selectedPlan.name,
        maxActivations: selectedPlan.maxActivations,
        // planId is sent as an extra field; the API route reads it from body
        ...({ planId: selectedPlan.planId } as Record<string, unknown>),
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
        if (err.status === 402) {
          setError("Insufficient balance. Please add credits to your account before purchasing.");
        } else if (err.fields && err.fields.length > 0) {
          setError(err.fields.map((f) => `${f.field}: ${f.reason}`).join("; "));
        } else {
          setError(`${err.field ? err.field + ": " : ""}${err.message}`);
        }
      } else {
        setError("Failed to place order");
      }
      setSaving(false);
    }
  }

  if (isAdmin) return null; // Will redirect

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
        title="Purchase License"
        description="Select a plan to purchase a new license key. The price will be deducted from your account balance."
      />

      {loadingPlans ? (
        <Spinner label="Loading available plans…" />
      ) : plans.length === 0 ? (
        <Card>
          <CardContent>
            <div className="py-8 text-center">
              <p className="text-[var(--color-muted)] text-sm">
                No plans are currently available. Please contact your administrator.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <form onSubmit={onSubmit}>
          {/* Plan selection grid */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
            {plans.map((plan) => {
              const isSelected = selectedPlan?.planId === plan.planId;
              return (
                <button
                  key={plan.planId}
                  type="button"
                  onClick={() => setSelectedPlan(plan)}
                  className={`
                    relative flex flex-col items-center gap-3 rounded-xl border-2 p-6
                    text-left transition-all duration-200 cursor-pointer
                    ${isSelected
                      ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5 shadow-md shadow-[var(--color-primary)]/10"
                      : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-primary)]/40 hover:shadow-sm"
                    }
                  `}
                >
                  {/* Selected indicator */}
                  {isSelected && (
                    <div className="absolute top-3 right-3 h-5 w-5 rounded-full bg-[var(--color-primary)] flex items-center justify-center">
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  )}

                  {/* Duration badge */}
                  <Badge tone="info">{durationLabel(plan.durationMonths)}</Badge>

                  {/* Plan name */}
                  <h3 className="text-base font-semibold text-[var(--color-fg)]">
                    {plan.name}
                  </h3>

                  {/* Description */}
                  {plan.description && (
                    <p className="text-xs text-[var(--color-muted)] text-center">
                      {plan.description}
                    </p>
                  )}

                  {/* Price */}
                  <div className="text-2xl font-bold text-[var(--color-primary)]">
                    {plan.price} <span className="text-sm font-normal text-[var(--color-muted)]">credits</span>
                  </div>

                  {/* Features */}
                  <div className="flex flex-col items-center gap-1 text-xs text-[var(--color-muted)]">
                    <span>Max {plan.maxActivations} activation{plan.maxActivations !== 1 ? "s" : ""}</span>
                    {plan.features.length > 0 && (
                      <span>{plan.features.join(", ")}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Price preview after selection */}
          {selectedPlan && (
            <Card className="mb-6">
              <CardContent>
                <h3 className="text-sm font-semibold text-[var(--color-fg)] mb-3">Order Summary</h3>
                {loadingPrice ? (
                  <Spinner label="Calculating price…" />
                ) : pricePreview ? (
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-[var(--color-muted)]">Plan</span>
                      <span className="font-medium">{selectedPlan.name} ({durationLabel(selectedPlan.durationMonths)})</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-[var(--color-muted)]">Base price</span>
                      <span className="font-medium">{pricePreview.basePrice} credits</span>
                    </div>
                    {pricePreview.discountPercent > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-[var(--color-muted)]">Discount ({pricePreview.discountPercent}%)</span>
                        <span className="font-medium text-[var(--color-success)]">−{pricePreview.discountAmount} credits</span>
                      </div>
                    )}
                    <div className="flex justify-between text-sm border-t pt-2 mt-2">
                      <span className="font-semibold">Total</span>
                      <span className="font-bold text-[var(--color-primary)]">{pricePreview.finalPrice} credits</span>
                    </div>
                    <div className="flex justify-between text-sm border-t pt-2 mt-2">
                      <span className="text-[var(--color-muted)]">Your balance</span>
                      <span className={`font-medium ${pricePreview.sufficient ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}`}>
                        {pricePreview.balance} credits
                      </span>
                    </div>
                    {!pricePreview.sufficient && (
                      <div className="mt-2 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-[var(--color-danger)]">
                        Insufficient balance. You need {pricePreview.finalPrice - pricePreview.balance} more credits.
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-[var(--color-muted)]">Unable to load pricing information.</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Customer details (optional) */}
          {selectedPlan && (
            <Card className="mb-6">
              <CardContent>
                <h3 className="text-sm font-semibold text-[var(--color-fg)] mb-3">Customer Details <span className="font-normal text-[var(--color-muted)]">(optional)</span></h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="customerName">Customer name</Label>
                    <Input id="customerName" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="customerEmail">Customer email</Label>
                    <Input id="customerEmail" type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="customerPhone">Phone</Label>
                    <Input id="customerPhone" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="customerCountry">Country</Label>
                    <Input id="customerCountry" value={customerCountry} onChange={(e) => setCustomerCountry(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="customerCompany">Company</Label>
                    <Input id="customerCompany" value={customerCompany} onChange={(e) => setCustomerCompany(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <Label htmlFor="customerNotes">Notes</Label>
                    <Input id="customerNotes" value={customerNotes} onChange={(e) => setCustomerNotes(e.target.value)} />
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {error && <ErrorText className="mb-4">{error}</ErrorText>}

          {/* Actions */}
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={saving || !selectedPlan || !!(pricePreview && !pricePreview.sufficient)}
            >
              {saving
                ? "Processing Order…"
                : selectedPlan && pricePreview
                  ? `Place Order — ${pricePreview.finalPrice} credits`
                  : "Select a Plan"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => router.back()}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
