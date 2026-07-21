import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Status pills. Every variant pairs a colour with TEXT — colour alone never
 * carries meaning, both for colour-blind readers and for anyone skimming a
 * dense grid where a lone hue is noise.
 */
const badge = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "bg-raised text-muted",
        ok: "bg-ok-subtle text-ok",
        warn: "bg-warn-subtle text-warn",
        danger: "bg-danger-subtle text-danger",
        info: "bg-info-subtle text-info",
        accent: "bg-accent-subtle text-accent",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeProps = React.ComponentProps<"span"> & VariantProps<typeof badge>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}
