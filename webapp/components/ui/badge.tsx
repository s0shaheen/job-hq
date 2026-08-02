import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Status chips. Every variant pairs a colour with TEXT — colour alone never
 * carries meaning, both for colour-blind readers and for anyone skimming a
 * dense grid where a lone hue is noise.
 */
// No whitespace-nowrap here: at 200% text zoom on a phone it pushed the
// industry badge past the page edge, where html's overflow-x:hidden clips it
// unreachably. A context that wants a one-line badge sets nowrap on the
// container (the pipeline's table cells do); the badge itself must never be
// wider than the space it is given.
const badge = cva(
  "inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium break-words",
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
