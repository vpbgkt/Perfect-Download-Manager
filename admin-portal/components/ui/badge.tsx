import * as React from "react";
import { cn } from "../../lib/ui.ts";

type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "default";
type Size = "sm" | "md";

const TONES: Record<Tone, string> = {
  neutral: "bg-gray-100 text-gray-700",
  default: "bg-gray-100 text-gray-700",
  success: "bg-green-100 text-green-800",
  warning: "bg-amber-100 text-amber-800",
  danger: "bg-red-100 text-red-800",
  info: "bg-blue-100 text-blue-800",
};

const SIZES: Record<Size, string> = {
  sm: "px-2 py-0.5 text-xs",
  md: "px-2.5 py-0.5 text-xs",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  size?: Size;
}

/** Small status pill. */
export function Badge({ className, tone = "neutral", size = "md", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full font-medium",
        TONES[tone],
        SIZES[size],
        className
      )}
      {...props}
    />
  );
}

/** Map a License_Status to a badge tone. */
export function statusTone(status: string): Tone {
  switch (status) {
    case "active":
      return "success";
    case "suspended":
      return "warning";
    case "revoked":
      return "danger";
    default:
      return "neutral";
  }
}
