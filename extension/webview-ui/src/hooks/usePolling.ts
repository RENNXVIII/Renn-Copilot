import { useCallback, useEffect, useRef, useState } from "react";

// Small SWR-equivalent: fetch immediately, then again every `intervalMs`
// while `enabled` is true. Kept intentionally minimal (no cache, no
// dedup-across-consumers) -- the webview bundle only has one instance of
// each page mounted at a time, so SWR's extra machinery isn't needed here.
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number, enabled = true) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setIsLoading(true);
    void refresh();
    const id = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs]);

  // Optimistic local update (mirrors SWR's `mutate(data, false)`), optionally
  // followed by a real refetch when `revalidate` is true.
  const mutate = useCallback(
    (updater?: T | ((current: T | undefined) => T | undefined), revalidate = true) => {
      if (updater !== undefined) {
        setData((current) => (typeof updater === "function" ? (updater as (c: T | undefined) => T | undefined)(current) : updater));
      }
      if (revalidate) void refresh();
    },
    [refresh]
  );

  return { data, error, isLoading, mutate };
}
