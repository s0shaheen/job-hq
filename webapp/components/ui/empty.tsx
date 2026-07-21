import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Empty states. Three flavours, and the distinction matters: "you finished" is
 * a reward, "nothing matches" needs an escape hatch, and "nothing yet" needs
 * an explanation. Rendering the same blank panel for all three is how a
 * working system looks broken.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto max-w-md px-6 py-16 text-center", className)}>
      {icon ? <div className="mb-3 flex justify-center text-accent">{icon}</div> : null}
      <h2 className="text-lg font-semibold text-text">{title}</h2>
      {body ? <div className="mt-1.5 text-sm text-muted">{body}</div> : null}
      {action ? <div className="mt-5 flex justify-center gap-2">{action}</div> : null}
    </div>
  );
}
