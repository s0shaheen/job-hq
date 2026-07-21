import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * One button, four intents. Variants are enumerated here rather than composed
 * at call sites so a "sort of primary" button cannot come into existence.
 */
const button = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md " +
    "font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:bg-accent-hover",
        secondary: "border border-border-strong bg-surface text-text-2 hover:bg-raised",
        ghost: "text-text-2 hover:bg-raised",
        danger: "bg-danger text-white hover:opacity-90",
      },
      size: {
        sm: "h-7 px-2.5 text-xs",
        md: "h-8 px-3 text-sm",
        lg: "h-10 px-4 text-base",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = React.ComponentProps<"button"> & VariantProps<typeof button>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(button({ variant, size }), className)} {...props} />;
}
