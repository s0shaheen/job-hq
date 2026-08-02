import { cn } from "@/lib/utils";

/**
 * The button's class string, split out of `button.tsx` so a link can wear it.
 *
 * `button.tsx` is a client module (it takes an `onClick`), and every export of
 * a client module becomes a client reference — a server component that called
 * a helper from it would throw at render. Empty states are server components
 * whose one action is a navigation, so the action has to be an `<a>`, and it
 * has to look identical to the `Button` beside it. `components/ui/button.tsx`
 * already solved this the same way; this is the ported system's copy of it.
 *
 * Never wrap `Button` in a `Link`: an `<a>` around a `<button>` is invalid,
 * and screen readers announce the pair as two controls.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "border border-accent bg-accent text-accent-fg hover:bg-accent-hover hover:border-accent-hover",
  secondary: "border border-border-strong bg-surface text-text hover:bg-raised",
  ghost: "border-0 bg-transparent text-text-2 hover:bg-raised",
};

const baseClasses =
  "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm tabular-nums " +
  "no-underline disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-ring";

export function buttonClass({
  variant = "secondary",
  disabled = false,
  className,
}: {
  variant?: ButtonVariant;
  disabled?: boolean;
  className?: string;
} = {}): string {
  // The disabled look is its own token pair rather than an opacity multiplier:
  // opacity de-emphasis lets a control pass the contrast rules on its tokens
  // and fail them on screen (01 section 12.8).
  const state = disabled ? "border border-border bg-raised text-muted" : variantClasses[variant];
  return cn(baseClasses, state, className);
}
