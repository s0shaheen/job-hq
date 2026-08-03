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
    /**
     * `flex-wrap` plus `min-w-0`, because the narrow viewport is not optional.
     *
     * The seed has one 900px viewport, so a title and its one action always
     * share a line there. Two surfaces found the same edge independently, and
     * both measurements are kept because they fail differently:
     *
     *   - /companies at 280px — without wrapping, the shell painted to x=294 in
     *     a 280px window.
     *   - /queue at 200% text zoom on a 320-375px phone, the moment Today put
     *     its Export control in this slot: the action paints past the right
     *     edge into `overflow-x:hidden`, so the control becomes unreachable
     *     rather than merely awkward. `resilience.spec.ts`'s zoom sweep
     *     measured that one.
     *
     * Wrapping and not truncating, which is the call the pre-redesign queue
     * header had already recorded: truncating satisfies every geometry check by
     * clipping its own text, and it once rendered the h1 "Today" as the single
     * letter "T" at 200% zoom — for the large-text reader this app is for.
     */
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
