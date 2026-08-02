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
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div>
        <h1 className="text-xl font-semibold text-text">{title}</h1>
        {subtitle ? <div className="mt-0.5 text-sm tabular-nums text-muted">{subtitle}</div> : null}
      </div>
      {action}
    </div>
  );
}
