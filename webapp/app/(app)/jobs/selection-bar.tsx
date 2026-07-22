"use client";

import { Clock, Copy, Star, X } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";

/**
 * The selection toolbar (plan §5): count + bulk actions + Copy + Export,
 * present ONLY while rows are selected. It floats over the grid's bottom edge
 * (the Linear pattern) instead of occupying a layout row, so its appearance
 * cannot shift the grid or re-anchor the scroll position — the row-7 jump
 * lesson, applied preemptively. `max-w` + wrapping keep it inside the page at
 * 280px, where layout.spec.ts's painted-geometry rule still applies.
 *
 * The buttons carry the same verbs, icons and key hints as the triage queue —
 * one vocabulary for deciding, wherever the decision is made.
 *
 * `fixed`, not absolute-in-the-grid: the /jobs wrapper is h-dvh below a nav
 * strip, so on a phone its bottom edge starts below the fold — a bar anchored
 * to it had its Clear row clipped until the first flick (seen in the G4
 * screenshot pass, not by any assertion). The viewport is the one box that is
 * always fully on screen.
 */
export default function SelectionBar(props: {
  count: number;
  busy: boolean;
  onInterested: () => void;
  onSnooze: () => void;
  onDismiss: () => void;
  onCopy: () => void;
  onClear: () => void;
  /** The Export menu instance scoped to this bar (its own testid). */
  exportMenu: React.ReactNode;
}) {
  return (
    <div
      data-testid="selection-bar"
      role="toolbar"
      aria-label={`${props.count} rows selected`}
      className="fixed bottom-4 left-1/2 z-30 flex w-max max-w-[calc(100vw-16px)] -translate-x-1/2
                 flex-wrap items-center justify-center gap-1.5 rounded-lg border border-border-strong
                 bg-surface px-2.5 py-1.5 shadow-xl"
    >
      <span data-testid="selection-count" className="tabular px-1 text-xs font-medium text-text">
        {props.count} selected
      </span>

      <Button
        size="sm"
        variant="primary"
        disabled={props.busy}
        onClick={props.onInterested}
        data-testid="bulk-interested"
      >
        <Star aria-hidden="true" className="size-3.5" /> Interested <Kbd>i</Kbd>
      </Button>
      <Button size="sm" variant="secondary" disabled={props.busy} onClick={props.onSnooze}>
        <Clock aria-hidden="true" className="size-3.5" /> Later <Kbd>s</Kbd>
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={props.busy}
        onClick={props.onDismiss}
        data-testid="bulk-dismiss"
      >
        <X aria-hidden="true" className="size-3.5" /> Pass <Kbd>x</Kbd>
      </Button>

      <Button size="sm" variant="secondary" onClick={props.onCopy} data-testid="bulk-copy">
        <Copy aria-hidden="true" className="size-3.5" /> Copy <Kbd>⌘C</Kbd>
      </Button>

      {props.exportMenu}

      <Button size="sm" variant="ghost" onClick={props.onClear}>
        Clear <Kbd>Esc</Kbd>
      </Button>
    </div>
  );
}
