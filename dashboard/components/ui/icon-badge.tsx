import { cn } from "@/lib/utils";
import type { ComponentType } from "react";

// Lucide icons satisfy this (every prop they take is optional), and so do the
// hand-written brand SVGs in provider-icons.tsx, which only accept className --
// letting IconBadge host either kind of icon interchangeably.
export type IconComponent = ComponentType<{ className?: string }>;

// Small set of accent colors shared by KPI/summary cards across the
// Overview and Usage pages, so each metric gets a distinct, recognizable
// color without every page inventing its own palette. Tailwind's static
// extraction needs each class spelled out (no template-built classnames),
// hence the explicit map instead of `bg-${tone}-500/10`.
const TONE_CLASSES = {
  indigo: "bg-indigo-500/15 text-indigo-600",
  violet: "bg-violet-500/15 text-violet-600",
  sky: "bg-sky-500/15 text-sky-600",
  teal: "bg-teal-500/15 text-teal-600",
  emerald: "bg-emerald-500/15 text-emerald-600",
  amber: "bg-amber-500/15 text-amber-600",
  rose: "bg-rose-500/15 text-rose-600",
  slate: "bg-slate-500/15 text-slate-600",
} as const;

export type IconBadgeTone = keyof typeof TONE_CLASSES;

/** A small colored, rounded icon chip used to give cards a quick visual identity. */
export function IconBadge({
  icon: Icon,
  tone = "indigo",
  shape = "square",
  className,
}: {
  icon: IconComponent;
  tone?: IconBadgeTone;
  shape?: "square" | "circle";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-9 w-9 shrink-0 items-center justify-center",
        shape === "circle" ? "rounded-full" : "rounded-md",
        TONE_CLASSES[tone],
        className
      )}
    >
      <Icon className="h-[18px] w-[18px]" />
    </span>
  );
}
