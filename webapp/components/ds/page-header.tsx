import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One title per page.
 *
 * A subtitle ONLY when it carries operating information: scope, count,
 * last-updated. Decorative subtitles are forbidden. "Everything you need to
 * decide today" tells a reader nothing they cannot see; "42 jobs, updated 6
 * minutes ago" is the reason this slot exists.
 *
 * `action` is the page's one primary control, sitting on the title's baseline
 * rather than in a toolbar of its own.
 */
export function PageHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    // `flex-wrap` plus `min-w-0`, because the narrow viewport is not optional.
    // Without them a long title and a primary action sit on one unbreakable row
    // and paint past the page edge — measured at 280px on /companies, where the
    // shell reached x=294 in a 280px window. Wrapping is the only behaviour that
    // keeps both the title and the action reachable without a sideways page.
    <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2", className)}>
      <div className="min-w-0">
        <h1 className="min-w-0 break-words text-xl font-semibold text-text">{title}</h1>
        {subtitle ? (
          <div className="mt-0.5 min-w-0 break-words text-sm tabular-nums text-muted">
            {subtitle}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  );
}
