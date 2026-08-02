import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BadgeVariant = "neutral" | "warn";

/**
 * Two variants, and only two.
 *
 * Colour never travels alone: the warn variant pairs its colour with an icon
 * and with the text itself, so the meaning survives a colour-blind reader and
 * a grid skimmed at speed. Neutral is the quiet chip (skills in the detail
 * pane, a count beside a label) and carries no state at all.
 *
 * There is no ok/danger/info variant on purpose. A palette with a pill for
 * every hue is how a dense screen turns into confetti; a state that needs
 * saying gets said in words.
 */
export function Badge({
  variant = "neutral",
  children,
  className,
}: {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}) {
  if (variant === "warn") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-warn-subtle px-2 py-0.5 text-xs tabular-nums text-warn",
          className,
        )}
      >
        <TriangleAlert size={12} strokeWidth={2} aria-hidden />
        <span>{children}</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border bg-raised px-2 py-0.5 text-xs tabular-nums text-text-2",
        className,
      )}
    >
      {children}
    </span>
  );
}
