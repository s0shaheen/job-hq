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
 * There is no opacity here either, and that is the second lesson. The hint
 * used to be `opacity-70`, which reads as pleasantly subdued and quietly
 * multiplies whatever contrast the inherited colour had: `--text-2` on white
 * is 8.6:1, and at 70% it is 3.95:1 — under the WCAG AA floor for 11px text.
 * An opacity multiplier means a component can pass the contrast rules on its
 * own tokens and fail them on screen, which is the worst of both. De-emphasis
 * comes from the size and the border instead, so the hint is exactly as
 * legible as the text around it, wherever it is used.
 *
 * (The earlier note here claimed axe could not see this because the element is
 * `aria-hidden`. That turned out to be wrong: axe 4.12 does flag aria-hidden
 * text for colour contrast — it caught this one on the Export button. What axe
 * cannot catch is a hint that is invisible because it inherited a colour equal
 * to its background, which is why the `currentColor` rule above still stands.)
 */
export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        "ml-1 rounded border border-current/30 px-1 font-mono text-2xs text-current",
        className,
      )}
      {...props}
    />
  );
}
