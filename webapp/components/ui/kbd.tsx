import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A keyboard hint.
 *
 * Colours come from `currentColor`, never a fixed token. A hardcoded
 * `text-muted` reads fine on the page background and then vanishes on the
 * accent-filled primary button — which is exactly what happened: the `i` on
 * "Interested" rendered invisible while `x` and `s` on the plain buttons were
 * fine. Inheriting means the hint is legible on any surface this is ever
 * dropped onto, including ones that do not exist yet.
 *
 * Nothing automated catches this class of bug: the element is `aria-hidden`
 * (correctly — screen readers get the button's own label), and axe skips
 * hidden nodes when checking contrast. Decorative text must therefore inherit
 * by construction rather than rely on a scan.
 */
export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        "ml-1 rounded border border-current/30 px-1 font-mono text-2xs text-current opacity-70",
        className,
      )}
      {...props}
    />
  );
}
