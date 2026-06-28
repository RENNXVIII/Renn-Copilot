"use client";

import useSWR from "swr";
import { api } from "@/lib/api";

// Single global "show full emails vs. masked" switch, persisted on the
// backend (so it's shared with the VS Code extension's status bar/tooltip
// too) instead of per-row -- see backend/src/state.js's revealEmails.
//
// All callers share the same SWR cache key, so toggling it from anywhere
// (the "Reveal emails" button on the Providers page) re-renders every row
// that renders a <MaskedEmail> without each one needing its own subscription
// wiring.
const PREFERENCES_KEY = "preferences";

export function useEmailReveal() {
  const { data, mutate } = useSWR(PREFERENCES_KEY, api.getPreferences);
  const revealed = data?.revealEmails ?? false;

  async function setRevealed(next: boolean) {
    // Optimistic update so the toggle feels instant; rolled back automatically
    // by SWR if the PUT fails.
    await mutate(api.setPreferences(next), {
      optimisticData: { revealEmails: next },
      rollbackOnError: true,
    });
  }

  return { revealed, setRevealed, toggle: () => setRevealed(!revealed) };
}
