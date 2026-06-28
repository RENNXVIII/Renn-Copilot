"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import {
  LayoutDashboard,
  KeyRound,
  Cpu,
  FileCog,
  ScrollText,
  Puzzle,
  Activity,
  Command,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";

const NAV_SECTIONS = [
  {
    label: "Monitor",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/usage", label: "Usage", icon: Activity },
      { href: "/logs", label: "Logs", icon: ScrollText },
    ],
  },
  {
    label: "Configure",
    items: [
      { href: "/providers", label: "Providers & Login", icon: KeyRound },
      { href: "/models", label: "Models", icon: Cpu },
      { href: "/config", label: "Config", icon: FileCog },
    ],
  },
  {
    label: "Tools",
    items: [{ href: "/extension", label: "Extension", icon: Puzzle }],
  },
];

const COLLAPSE_STORAGE_KEY = "renn-copilot:sidebar-collapsed";

function loadCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
}

/** The "R" mark, reused as both the brand logo and (when collapsed) the expand button. */
function Logo() {
  return (
    <svg width="24" height="24" viewBox="0 0 64 64" className="shrink-0 rounded-md">
      <rect width="64" height="64" rx="14" fill="#6366f1" />
      <text
        x="50%"
        y="54%"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="38"
        fontWeight="700"
        fill="#ffffff"
      >
        R
      </text>
    </svg>
  );
}

export function SidebarNav() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // Read the persisted preference after mount to avoid a server/client
  // markup mismatch (localStorage isn't available during SSR).
  useEffect(() => {
    setCollapsed(loadCollapsed());
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }

  return (
    <aside
      className={cn(
        "hidden shrink-0 border-r border-border p-4 transition-[width] duration-150 md:block",
        collapsed ? "w-16" : "w-56"
      )}
    >
      {/* Header: logo + title with the collapse toggle to its right. When
          collapsed, the title and toggle disappear and the logo itself
          becomes the (hover-to-reveal) button that expands the sidebar
          again -- mirrors gemini.google.com's sidebar behavior. */}
      <div className="mb-6 flex items-center">
        {collapsed ? (
          <Tooltip content="Open sidebar" className="mx-auto">
            <button
              type="button"
              onClick={toggleCollapsed}
              className="group relative flex h-6 w-6 items-center justify-center rounded-md"
            >
              <span className="absolute inset-0 flex items-center justify-center transition-opacity group-hover:opacity-0">
                <Logo />
              </span>
              <span className="absolute inset-0 flex items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:bg-accent group-hover:text-accent-foreground group-hover:opacity-100">
                <PanelLeftOpen className="h-4 w-4" />
              </span>
            </button>
          </Tooltip>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
              <Logo />
              <p className="truncate text-sm font-semibold">Renn Copilot</p>
            </div>
            <Tooltip content="Collapse sidebar">
              <button
                type="button"
                onClick={toggleCollapsed}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </Tooltip>
          </>
        )}
      </div>

      <nav className="flex flex-col gap-4">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label} className="flex flex-col gap-1">
            {!collapsed && (
              <p className="px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {section.label}
              </p>
            )}
            {section.items.map(({ href, label, icon: Icon }) => {
              const active = pathname === href;
              return (
                <Tooltip key={href} content={label} disabled={!collapsed} className="w-full">
                  <Link
                    href={href}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                      collapsed && "justify-center px-0",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {!collapsed && label}
                  </Link>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </nav>

      <Tooltip content="Quick actions (⌘K)" disabled={!collapsed} className="mt-6 w-full">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
            collapsed && "justify-center px-0"
          )}
        >
          <span className="flex items-center gap-2">
            <Command className="h-3.5 w-3.5 shrink-0" />
            {!collapsed && "Quick actions"}
          </span>
          {!collapsed && <kbd className="rounded border border-border px-1 py-0.5 text-[10px]">⌘K</kbd>}
        </button>
      </Tooltip>
    </aside>
  );
}
