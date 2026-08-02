"use client";

import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One active filter, rendered in plain language and removable.
 *
 * The label is a sentence a person would say out loud: "Pay above $120k",
 * "Posted in the last 7 days". Never math glyphs, never a serialized query
 * fragment: ">= 120000" is the database's spelling of the filter, not the
 * reader's, and a chip nobody can read is a chip nobody dares remove
 * (02 section 2).
 */
export function FilterChip({
  label,
  onRemove,
  className,
}: {
  label: string;
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <span
      data-testid="filter-chip"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface px-2 py-1 text-xs tabular-nums text-text",
        className,
      )}
    >
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className="inline-flex cursor-pointer text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-ring"
      >
        <X size={12} strokeWidth={1.75} aria-hidden />
      </button>
    </span>
  );
}

/**
 * The row of active filters.
 *
 * "Clear all" appears only at two or more chips: beside a single chip it is a
 * second control for the job that chip's own X already does.
 */
export function FilterChipRow({
  filters,
  onRemove,
  onClearAll,
  className,
}: {
  filters: string[];
  onRemove?: (label: string) => void;
  onClearAll?: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {filters.map((f) => (
        <FilterChip key={f} label={f} onRemove={onRemove ? () => onRemove(f) : undefined} />
      ))}
      {filters.length >= 2 ? (
        <button
          type="button"
          onClick={onClearAll}
          className="cursor-pointer rounded-md px-2 py-1 text-xs text-text-2 hover:bg-raised focus-visible:outline-2 focus-visible:outline-ring"
        >
          Clear all
        </button>
      ) : null}
    </div>
  );
}
