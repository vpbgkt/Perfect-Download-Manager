import * as React from "react";
import { cn } from "../../lib/ui.ts";

/** Text input primitive. */
export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-[var(--radius)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm placeholder:text-[var(--color-muted)] disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

/** Accessible label primitive. */
export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("text-sm font-medium text-[var(--color-fg)]", className)}
      {...props}
    />
  );
}

/** Native select primitive. */
export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-10 w-full rounded-[var(--radius)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}
