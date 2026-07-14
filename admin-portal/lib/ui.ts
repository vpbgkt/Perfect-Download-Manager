/**
 * UI helper: merge conditional class names with Tailwind-aware de-duplication.
 * `clsx` composes the class list; `tailwind-merge` resolves conflicting Tailwind
 * utilities (e.g. `px-2 px-4` → `px-4`).
 *
 * @module lib/ui
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Compose class names, resolving conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
