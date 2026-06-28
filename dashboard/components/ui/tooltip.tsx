"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const SIDE_CLASSES: Record<string, string> = {
  right: "left-full top-1/2 ml-2 -translate-y-1/2",
  left: "right-full top-1/2 mr-2 -translate-y-1/2",
  top: "bottom-full left-1/2 mb-2 -translate-x-1/2",
  bottom: "top-full left-1/2 mt-2 -translate-x-1/2",
};

/**
 * Lightweight CSS-only tooltip (no Radix dependency). Wrap any element --
 * shows `content` in a small floating bubble on hover/focus. Pass
 * `disabled` to render children unwrapped (e.g. when the parent already
 * shows a text label and a tooltip would be redundant).
 */
export function Tooltip({
  content,
  children,
  side = "right",
  disabled = false,
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "right" | "left" | "top" | "bottom";
  disabled?: boolean;
  className?: string;
}) {
  if (disabled || !content) return <>{children}</>;

  return (
    <span className={cn("group/tooltip relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 whitespace-nowrap rounded-md border border-border bg-foreground px-2 py-1 text-xs font-medium text-background opacity-0 shadow-md transition-opacity duration-150 delay-300 group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100",
          SIDE_CLASSES[side]
        )}
      >
        {content}
      </span>
    </span>
  );
}
