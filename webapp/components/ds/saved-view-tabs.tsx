"use client";

import { cn } from "@/lib/utils";

/**
 * A saved view is a named query, not a place. The tabs switch what is being
 * asked, they do not navigate: the page, the columns and the scroll position
 * are the same before and after.
 *
 * "Save view" appears only when the current query is dirty, so the row is a
 * list of views until the moment there is something worth saving.
 */
export function SavedViewTabs({
  views,
  active,
  dirty = false,
  onSelect,
  onSave,
  className,
}: {
  views: string[];
  active: string;
  dirty?: boolean;
  onSelect?: (view: string) => void;
  onSave?: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex max-w-full min-w-0 gap-0.5 overflow-x-auto", className)}>
      {views.map((v) =>
        v === active ? (
          <button
            key={v}
            type="button"
            aria-current="true"
            onClick={() => onSelect?.(v)}
            className="shrink-0 cursor-pointer rounded-md bg-selected px-3 py-1.5 text-sm font-medium text-text focus-visible:outline-2 focus-visible:outline-ring"
          >
            {v}
          </button>
        ) : (
          <button
            key={v}
            type="button"
            onClick={() => onSelect?.(v)}
            className="shrink-0 cursor-pointer rounded-md px-3 py-1.5 text-sm text-text-2 hover:bg-raised focus-visible:outline-2 focus-visible:outline-ring"
          >
            {v}
          </button>
        ),
      )}
      {dirty ? (
        <button
          type="button"
          onClick={onSave}
          className="shrink-0 cursor-pointer rounded-md px-3 py-1.5 text-sm text-accent hover:bg-raised focus-visible:outline-2 focus-visible:outline-ring"
        >
          Save view
        </button>
      ) : null}
    </div>
  );
}
