"use client";

import * as React from "react";
import { api, ApiError } from "../../models/api-client.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card.tsx";
import { Button } from "../ui/button.tsx";
import { Input, Label } from "../ui/input.tsx";
import { ErrorText, SuccessText } from "../ui/feedback.tsx";

interface BalanceCreditFormProps {
  accountId: string;
  accountName: string;
  currentBalance: number;
  onSuccess?: (newBalance: number) => void;
  onCancel?: () => void;
}

export function BalanceCreditForm({
  accountId,
  accountName,
  currentBalance,
  onSuccess,
  onCancel,
}: BalanceCreditFormProps) {
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [newBalance, setNewBalance] = React.useState<number | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amountNum = parseFloat(amount);
    
    if (isNaN(amountNum) || amountNum <= 0) {
      setError("Amount must be a positive number");
      return;
    }

    if (!reason.trim()) {
      setError("Reason is required");
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const result = await api.creditBalance(accountId, {
        amount: amountNum,
        reason: reason.trim(),
      });
      
      setNewBalance(result.newBalance);
      setSuccess(true);
      setAmount("");
      setReason("");
      
      if (onSuccess) {
        onSuccess(result.newBalance);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to credit balance");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add Balance</CardTitle>
        <CardDescription>
          Credit balance to <span className="font-semibold">{accountName}</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-4 p-3 bg-gray-50 rounded-md">
          <div className="text-sm text-gray-600">Current Balance</div>
          <div className="text-2xl font-bold">{currentBalance.toLocaleString()} credits</div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="amount">Amount (credits)</Label>
            <Input
              id="amount"
              type="number"
              min="1"
              step="1"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Enter amount to credit"
              disabled={saving}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reason">Reason</Label>
            <Input
              id="reason"
              type="text"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g., Initial deposit, Refund, Bonus"
              disabled={saving}
              maxLength={200}
            />
            <span className="text-xs text-gray-500">This will be recorded in transaction history</span>
          </div>

          {amount && !isNaN(parseFloat(amount)) && parseFloat(amount) > 0 && (
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
              <div className="text-sm text-blue-800">
                New balance will be: <span className="font-bold">{(currentBalance + parseFloat(amount)).toLocaleString()} credits</span>
              </div>
            </div>
          )}

          {error && (
            <div className="mt-3">
              <ErrorText>{error}</ErrorText>
            </div>
          )}

          {success && newBalance !== null && (
            <div className="mt-3">
              <SuccessText>Balance credited successfully!</SuccessText>
              <div className="mt-2 text-sm text-gray-600">
                New balance: <span className="font-semibold">{newBalance.toLocaleString()} credits</span>
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={saving}>
              {saving ? "Processing…" : "Credit Balance"}
            </Button>
            {onCancel && (
              <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

interface BalanceCreditModalProps {
  isOpen: boolean;
  accountId: string;
  accountName: string;
  currentBalance: number;
  onSuccess?: (newBalance: number) => void;
  onClose: () => void;
}

export function BalanceCreditModal({
  isOpen,
  accountId,
  accountName,
  currentBalance,
  onSuccess,
  onClose,
}: BalanceCreditModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
        <BalanceCreditForm
          accountId={accountId}
          accountName={accountName}
          currentBalance={currentBalance}
          onSuccess={(newBalance) => {
            if (onSuccess) onSuccess(newBalance);
            setTimeout(() => onClose(), 1500);
          }}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}
