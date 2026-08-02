import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A keyboard hint.
 *
 * Colour comes from `currentColor`, never a fixed token. The seed hardcodes
 * `text-text-muted` on a `bg-raised` chip, which reads fine on the page and
 * then vanishes on the accent-filled primary button this component is rendered
 * inside (`Button` with a `keyHint`): that exact bug shipped once, where the
 * "i" on Interested was invisible while the "x" and "s" on the plain buttons
 * beside it were fine. Inheriting means the hint is legible on any surface,
 * including surfaces that do not exist yet.
 *
 * No opacity either. An opacity multiplier lets a component pass the contrast
 * rules on its own tokens and fail them on screen. De-emphasis comes from the
 * size and the border.
 *
 * `aria-hidden` because the hint is a visual echo of a shortcut, not part of
 * the control's name: without it, "Interested 3" is announced as
 * "Interested 3 i".
 */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        "rounded-sm border border-current/30 px-1 font-sans text-2xs text-current",
        className,
      )}
      {...props}
    />
  );
}
