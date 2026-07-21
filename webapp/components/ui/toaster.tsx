"use client";

import { Toaster as Sonner } from "sonner";

/**
 * Toast host. Undo lives here rather than in confirmation dialogs: every
 * triage decision is reversible for a few seconds, which is what lets the
 * queue stay fast. A confirm dialog on a reversible action is a tax paid on
 * every row to protect against a mistake that costs one keystroke to fix.
 */
export function Toaster() {
  return (
    <Sonner
      position="bottom-left"
      duration={8000}
      closeButton
      toastOptions={{
        classNames: {
          toast:
            "!bg-surface !text-text !border !border-border-strong !rounded-lg !text-sm",
          actionButton: "!bg-accent !text-accent-fg !rounded-md",
        },
      }}
    />
  );
}
