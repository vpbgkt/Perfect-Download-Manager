import * as React from "react";
import { cn } from "../../lib/ui.ts";

/** Simple centered loading indicator. */
export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--color-muted)]" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-[var(--color-primary)]" aria-hidden />
      {label}
    </div>
  );
}

/** Inline error message. */
export function ErrorText({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("text-sm text-[var(--color-danger)]", className)} role="alert">
      {children}
    </p>
  );
}

/** Inline success message. */
export function SuccessText({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm text-[var(--color-success)]" role="status">
      {children}
    </p>
  );
}

/** Empty-state placeholder for lists. */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-[var(--radius)] border border-dashed border-[var(--color-border)] p-10 text-center">
      <p className="font-medium">{title}</p>
      {hint && <p className="mt-1 text-sm text-[var(--color-muted)]">{hint}</p>}
    </div>
  );
}

/** Page heading with optional actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-[var(--color-muted)]">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
