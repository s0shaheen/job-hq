"use client";

import { Toaster as Sonner } from "sonner";

/**
 * Toast host. Undo lives here rather than in confirmation dialogs: every
 * triage decision is reversible for a few seconds, which is what lets the
 * queue stay fast. A confirm dialog on a reversible action is a tax paid on
 * every row to protect against a mistake that costs one keystroke to fix.
 */
/**
 * Sonner's slot classes, hoisted out of the JSX.
 *
 * These are Tailwind utilities, not words — the `!` is the important-modifier
 * that beats sonner's own inline defaults, and nothing here is ever read. The
 * copy lint skips `className` attributes by name but sees literals nested inside
 * a prop object, so it read every modifier as an exclamation point. Naming them
 * for what they are is the fix; an allowlist entry would only hide the next one.
 */
const TOAST_CLASS_NAMES = {
  toast: "!bg-surface !text-text !border !border-border-strong !rounded-lg !text-sm",
  actionButton: "!bg-accent !text-accent-fg !rounded-md",
};

export function Toaster() {
  return (
    <Sonner
      position="bottom-left"
      duration={8000}
      closeButton
      toastOptions={{ classNames: TOAST_CLASS_NAMES }}
    />
  );
}
