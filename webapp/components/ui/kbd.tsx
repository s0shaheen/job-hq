import * as React from "react";
import { cn } from "@/lib/utils";

/** A keyboard hint. Decorative: screen readers get the button's own label. */
export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        "ml-1 rounded border border-border-strong px-1 font-mono text-2xs text-muted",
        className,
      )}
      {...props}
    />
  );
}
