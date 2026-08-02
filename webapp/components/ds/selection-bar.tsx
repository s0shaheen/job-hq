"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

/**
 * The bulk-decision bar, present only while rows are selected.
 *
 * The count on a control equals the count acted on (02 section 8). "Interested
 * 12" acts on twelve rows, and when the selection changes the labels change
 * with it: a button that says one number and does another is the defect this
 * rule exists to prevent.
 *
 * `busy` disables the three decision buttons and leaves "Clear selection"
 * alive, because backing out must never be the thing that is unavailable while
 * a write is in flight.
 *
 * `extra` is a slot the composition fills (the Export menu), placed before
 * "Clear selection" so the last control in the bar is always the way out.
 *
 * It floats: `rounded-lg`, a strong border, and the one shadow in the system
 * that is not on a menu, because this bar sits over content rather than in the
 * layout. Shadows are for things that overlay.
 */
export function SelectionBar({
  count,
  busy = false,
  onInterested,
  onPass,
  onLater,
  onClear,
  extra,
  className,
}: {
  count: number;
  busy?: boolean;
  onInterested: () => void;
  onPass: () => void;
  onLater: () => void;
  onClear: () => void;
  extra?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="toolbar"
      aria-label={`${count} rows selected`}
      data-testid="selection-bar"
      className={cn(
        "inline-flex max-w-full items-center gap-4 overflow-x-auto rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm",
        "shadow-[0_4px_16px_rgba(26,26,24,0.10)]",
        className,
      )}
    >
      <span className="shrink-0 tabular-nums text-text-2">{count} selected</span>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={onInterested}>
          Interested {count}
        </Button>
        <Button disabled={busy} onClick={onPass}>
          Pass {count}
        </Button>
        <Button disabled={busy} onClick={onLater}>
          Later {count}
        </Button>
        {extra}
        <Button variant="ghost" onClick={onClear}>
          Clear selection
        </Button>
      </div>
    </div>
  );
}
