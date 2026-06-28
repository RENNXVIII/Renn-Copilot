"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  KeyRound,
  Cpu,
  FileCog,
  ScrollText,
  Puzzle,
  Activity,
  Play,
  Square,
  RotateCw,
  Search,
} from "lucide-react";

type PaletteAction = {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => void;
};

/**
 * Cmd+K / Ctrl+K command palette -- quick navigation across pages plus a
 * couple of high-frequency server actions (start/stop/restart), inspired by
 * the palette pattern in tools like ccs/9router. Mounted once in
 * app/layout.tsx so it's reachable from any page.
 */
export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { toast } = useToast();

  const close = React.useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, []);

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isCombo = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isCombo) {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      if (e.key === "Escape" && open) {
        close();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  React.useEffect(() => {
    if (open) {
      // Wait a tick for the dialog to mount before focusing.
      const id = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [open]);

  async function runServerAction(action: "start" | "stop" | "restart") {
    const labels = { start: "Starting", stop: "Stopping", restart: "Restarting" } as const;
    const fns = { start: api.start, stop: api.stop, restart: api.restart } as const;
    try {
      await fns[action]();
      toast({ title: `Server ${action === "stop" ? "stopped" : action === "restart" ? "restarted" : "started"}`, variant: "success" });
    } catch (err) {
      toast({
        title: `Failed to ${action} server`,
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    }
  }

  const actions: PaletteAction[] = [
    { id: "nav-overview", label: "Go to Overview", icon: LayoutDashboard, run: () => router.push("/") },
    { id: "nav-usage", label: "Go to Usage", icon: Activity, run: () => router.push("/usage") },
    { id: "nav-providers", label: "Go to Providers & Login", icon: KeyRound, run: () => router.push("/providers") },
    { id: "nav-models", label: "Go to Models", icon: Cpu, run: () => router.push("/models") },
    { id: "nav-extension", label: "Go to Extension", icon: Puzzle, run: () => router.push("/extension") },
    { id: "nav-config", label: "Go to Config", icon: FileCog, run: () => router.push("/config") },
    { id: "nav-logs", label: "Go to Logs", icon: ScrollText, run: () => router.push("/logs") },
    {
      id: "action-start",
      label: "Start server",
      hint: "Action",
      icon: Play,
      run: () => runServerAction("start"),
    },
    {
      id: "action-stop",
      label: "Stop server",
      hint: "Action",
      icon: Square,
      run: () => runServerAction("stop"),
    },
    {
      id: "action-restart",
      label: "Restart server",
      hint: "Action",
      icon: RotateCw,
      run: () => runServerAction("restart"),
    },
  ];

  const filtered = query.trim()
    ? actions.filter((a) => a.label.toLowerCase().includes(query.trim().toLowerCase()))
    : actions;

  function select(action: PaletteAction) {
    action.run();
    close();
  }

  function onKeyDownInList(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = filtered[activeIndex];
      if (picked) select(picked);
    }
  }

  return (
    <Dialog open={open} onClose={close} className="max-w-md p-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDownInList}
          placeholder="Jump to a page or run an action..."
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          Esc
        </kbd>
      </div>
      <div className="max-h-80 overflow-y-auto p-2">
        {filtered.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">No matches.</p>
        )}
        {filtered.map((action, i) => {
          const Icon = action.icon;
          return (
            <button
              key={action.id}
              onClick={() => select(action)}
              onMouseEnter={() => setActiveIndex(i)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                i === activeIndex ? "bg-accent text-accent-foreground" : "text-foreground"
              )}
            >
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-muted-foreground" />
                {action.label}
              </span>
              {action.hint && <span className="text-xs text-muted-foreground">{action.hint}</span>}
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}
