"use client";

import * as React from "react";
import { Input, Label } from "./input.tsx";
import { Button } from "./button.tsx";

/** Build an ISO 8601 UTC timestamp `months` from today, at 00:00:00Z. */
function isoMonthsFromNow(months: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const PRESETS = [
  { label: "1 month", months: 1 },
  { label: "3 months", months: 3 },
  { label: "6 months", months: 6 },
  { label: "12 months", months: 12 },
];

/**
 * ISO 8601 expiry input with quick "+N months" presets that auto-fill the date
 * relative to today, plus a "Perpetual" button that clears the value.
 */
export function ExpiryField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        placeholder="2030-01-01T00:00:00Z"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="flex flex-wrap gap-2 pt-1">
        {PRESETS.map((p) => (
          <Button
            key={p.months}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(isoMonthsFromNow(p.months))}
          >
            +{p.label}
          </Button>
        ))}
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>
          Perpetual
        </Button>
      </div>
      <span className="text-xs text-[var(--color-muted)]">
        {value ? `Expires: ${value}` : "No expiry (perpetual license)"}
      </span>
    </div>
  );
}
