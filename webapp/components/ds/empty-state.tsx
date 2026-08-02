import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Empty states are three different things and the copy must pick the true one:
 * you finished, nothing matches, or nothing yet. Rendering the same blank
 * panel for all three is how a working system looks broken.
 *
 * LEFT ALIGNED, never centred and never a hero. A centred column with a big
 * icon reads as a marketing panel in the middle of a work surface, and it moves
 * the first word away from the left edge every other row on the page starts at
 * (01 section 12.13). The icon is small, muted, and optional.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div data-testid="empty-state" className={cn("pt-12 pb-16", className)}>
      {Icon ? <Icon size={20} strokeWidth={1.75} className="text-muted" aria-hidden /> : null}
      <div className={cn("text-base font-medium", Icon && "mt-3")}>{title}</div>
      {description ? (
        <div className="mt-1 text-sm tabular-nums text-muted">{description}</div>
      ) : null}
      {children ? <div className="mt-4 flex items-center gap-2">{children}</div> : null}
    </div>
  );
}
