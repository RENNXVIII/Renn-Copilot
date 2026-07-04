import { useEffect, useRef, useState } from "react";

/** Ported from dashboard/components/ui/log-viewer.tsx -- auto-scroll only while pinned to bottom. */
export function LogViewer({ lines, downloadFilename = "log.txt" }: { lines: string[]; downloadFilename?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [query, setQuery] = useState("");

  const filtered = query.trim() ? lines.filter((l) => l.toLowerCase().includes(query.trim().toLowerCase())) : lines;

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
    } catch {
      // Clipboard access can be denied in some webview contexts -- nothing more to do.
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
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="log-toolbar">
        <div className="search-box" style={{ flex: 1 }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter lines..." />
          {query && (
            <span className="card-desc">
              {filtered.length}/{lines.length}
            </span>
          )}
        </div>
        <button className="btn secondary" disabled={!filtered.length} title="Copy visible lines" onClick={copyAll}>
          Copy
        </button>
        <button className="btn secondary" disabled={!filtered.length} title="Download visible lines" onClick={downloadAll}>
          Download
        </button>
      </div>

      <div className="log-box" ref={scrollRef} onScroll={handleScroll}>
        {filtered.length === 0 && <span className="card-desc">{query ? "No lines match your filter." : "No log lines yet."}</span>}
        {filtered.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
        {!pinned && lines.length > 0 && (
          <button className="jump-to-latest" onClick={jumpToBottom}>
            ↓ Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}
