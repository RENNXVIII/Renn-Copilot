import { useCallback } from "react";
import { api } from "../api/client";
import { usePolling } from "./usePolling";

/** Ported from dashboard/lib/use-email-reveal.ts -- single global toggle persisted backend-side. */
export function useEmailReveal() {
  const { data, mutate } = usePolling(api.getPreferences, 30000);
  const revealed = data?.revealEmails ?? false;

  const setRevealed = useCallback(
    async (next: boolean) => {
      mutate({ ...(data ?? { revealEmails: false, claudeCoworkMode: false }), revealEmails: next }, false);
      try {
        // Partial update only -- never send claudeCoworkMode from this hook.
        await api.setPreferences({ revealEmails: next });
      } finally {
        mutate(undefined, true);
      }
    },
    [mutate, data]
  );

  return { revealed, setRevealed, toggle: () => setRevealed(!revealed) };
}
