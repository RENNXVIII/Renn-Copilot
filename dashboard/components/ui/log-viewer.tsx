"use client";

import { useEffect, useRef, useState } from "react";
import { Search, Copy, Download, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";

/**
 * Scrolling log box shared by the Logs and Extension (build log) pages.
 *
 * Replaces the old pattern of `scrollRef.current?.scrollTo(...)` on every
 * `lines.length` change, which kept yanking the view back to the bottom even
 * while the user had scrolled up to read an earlier line. Here we only
 * auto-scroll while the user is already pinned to the bottom (within a small
 * threshold); scrolling up drops the pin until they scroll back down or hit
 * the "jump to latest" button.
 */
export function LogViewer({
  lines,
  heightClass = "h-[480px]",
  emptyMessage = "No log lines yet.",
  downloadFilename = "log.txt",
}: {
  lines: string[];
  heightClass?: string;
  emptyMessage?: string;
  downloadFilename?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [query, setQuery] = useState("");
  const { toast } = useToast();

  const filtered = query.trim()
    ? lines.filter((l) => l.toLowerCase().includes(query.trim().toLowerCase()))
    : lines;

  useEffect(() => {
    if (pinned) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [filtered.length, pinned]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(distanceFromBottom < 32);
  }

  function jumpToBottom() {
    setPinned(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(filtered.join("\n"));
      toast({ title: "Copied to clipboard", variant: "success" });
    } catch (err) {
      toast({ title: "Couldn't copy", description: err instanceof Error ? err.message : String(err), variant: "error" });
    }
  }

  function downloadAll() {
    const blob = new Blob([filtered.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadFilename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter lines..."
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {filtered.length}/{lines.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={copyAll}
          disabled={!filtered.length}
          title="Copy visible lines"
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={downloadAll}
          disabled={!filtered.length}
          title="Download visible lines"
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={cn("overflow-y-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed", heightClass)}
        >
          {filtered.length === 0 && (
            <p className="text-muted-foreground">{query ? "No lines match your filter." : emptyMessage}</p>
          )}
          {filtered.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {line}
            </div>
          ))}
        </div>
        {!pinned && lines.length > 0 && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium shadow-sm transition-colors hover:bg-accent"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}
