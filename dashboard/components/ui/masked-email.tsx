"use client";

import { cn, maskEmail } from "@/lib/utils";
import { useEmailReveal } from "@/lib/use-email-reveal";

/**
 * Shows an account email, masked by default ("ae•••••01@gmail.com").
 * Whether it's masked or shown in full is controlled by the single global
 * "Reveal emails" toggle on the Providers page instead of a per-row eye icon
 * -- a row-by-row toggle meant you were never more than one click away from exposing a
 * given account, but in practice it just meant clicking the same icon over
 * and over for every row. Falls back to a plain label for non-email values
 * (a custom account name has nothing to mask).
 */
export function MaskedEmail({ email, className }: { email: string; className?: string }) {
  const { revealed } = useEmailReveal();
  const isEmail = email.includes("@");

  if (!isEmail) {
    return <span className={cn("truncate", className)}>{email}</span>;
  }

  return <span className={cn("truncate", className)}>{revealed ? email : maskEmail(email)}</span>;
}
