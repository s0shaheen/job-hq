"use client";

import { ExternalLink, X } from "lucide-react";
import * as React from "react";
import { safeHref } from "@/lib/url/safe-href";
import { cn } from "@/lib/utils";
import { Badge } from "./badge";
import { Button } from "./button";
import { LogoAvatar } from "./logo-avatar";

/**
 * The Jobs detail pane (03 §4, 04 §3). The Attio move: a right-hand record pane
 * that PRESERVES the list. Row click opens it, the list stays interactive
 * underneath, and there is no route change — a route change loses the scroll
 * position and the selection, which turns a lookup into a navigation.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IT IS A PANE, NOT A DIALOG
 *
 * No `role="dialog"`, no focus trap, no inert background, no scrim. All four
 * are what a modal does, and every one of them contradicts "the list stays
 * interactive": a trap would make Tab a cage, and inert content is content
 * nobody can click. Focus moves to the close button once, on open, so a
 * keyboard user lands inside the thing that just appeared, and then it is free.
 * Restoring focus on close is the CALLER's job, because only the caller knows
 * which row was clicked.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THREE LABELLED SECTIONS, AND EXACTLY THESE THREE
 *
 * Details, About the role, Activity (02 §10). Each is attested in a named
 * reference product; a fourth would be an invented chrome label, which reads as
 * generated even in plain English. The decision block on top is deliberately
 * UNLABELLED for the same reason: Linear and Jira label no action groups, so
 * there is no attested word for that slot and the honest answer is no header.
 */

const MIN_WIDTH = 320;
const MAX_WIDTH = 720;
/** One arrow press. Coarse enough to be useful, fine enough to land on a value. */
const KEY_STEP = 16;

const clampWidth = (px: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)));

/**
 * `data-section` is not decoration: the "at most three labelled sections, and
 * exactly these three" rule (02 §10) is only enforceable if a test can read the
 * section list in DOM order, and matching on a class string would pass the day
 * somebody adds a fourth header with different classes.
 */
function SectionHeader({ children }: { children: string }) {
  return (
    <div data-section={children} className="mb-2 text-xs font-medium text-muted">
      {children}
    </div>
  );
}

export type DetailPaneProps = {
  company: string;
  /** Feeds `LogoAvatar`'s source ladder. Absent is the normal case today. */
  domain?: string | null;
  title: string;
  /** The posting URL. Third-party text, so it goes through `safeHref`. */
  href?: string | null;
  decision: string;
  reason: string;
  /** Label/value rows. Every value renders and keeps its slot. */
  details: [string, string][];
  about: string;
  skills: string[];
  /** `[event, timestamp]`, newest first. */
  activity: [string, string][];
  /** A decision is in flight; the three buttons go inert until it settles. */
  busy?: boolean;
  onClose: () => void;
  onDecide: (word: "Interested" | "Pass" | "Later") => void;
  width: number;
  onWidthChange: (px: number) => void;
};

export function DetailPane({
  company,
  domain,
  title,
  href,
  decision,
  reason,
  details,
  about,
  skills,
  activity,
  busy = false,
  onClose,
  onDecide,
  width,
  onWidthChange,
}: DetailPaneProps) {
  const closeRef = React.useRef<HTMLButtonElement>(null);
  // On MOUNT only, never on every subject change: j/k in the list moves the
  // pane's subject (04 §3) while the pane stays mounted, and refocusing on each
  // move would rip focus out of the list mid-keystroke.
  React.useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // The posting URL is what an ATS board wrote, so it goes through the one
  // href guard. An unsafe or absent URL renders NO link: a link to nowhere is
  // worse than no link, because it reads as an affordance and answers nothing.
  const safe = safeHref(href);

  // ---- resize --------------------------------------------------------------
  // The pane sits on the right, so dragging the handle LEFT makes it wider.
  const drag = React.useRef<{ x: number; w: number } | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Primary button only; a right-click drag is not a resize gesture.
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start) return;
    onWidthChange(clampWidth(start.w + (start.x - e.clientX)));
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  /**
   * Keyboard resize. Not a nicety: a mouse-only resize is an axe failure, and
   * this surface gets an axe scan. Arrow keys track the separator's direction
   * on screen, so Left widens the pane; Home and End go to the two clamps,
   * which are the values `aria-valuemin` and `aria-valuemax` announce.
   */
  function onHandleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = width + KEY_STEP;
    else if (e.key === "ArrowRight") next = width - KEY_STEP;
    else if (e.key === "Home") next = MIN_WIDTH;
    else if (e.key === "End") next = MAX_WIDTH;
    if (next === null) return;
    e.preventDefault();
    onWidthChange(clampWidth(next));
  }

  /**
   * Escape, bound to THIS SUBTREE and not to `window`.
   *
   * The grid already owns a `window` keydown handler, and its Escape branch
   * clears the selection (`app/(app)/jobs/jobs-table.tsx`). A second global
   * listener would mean one Escape doing two things, in an order neither
   * feature chose. Stopping propagation here gives Escape one meaning while the
   * pane is focused — close the pane — and leaves the grid's meaning intact the
   * moment focus is back in the list.
   */
  function onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    onClose();
  }

  return (
    <aside
      data-testid="detail-pane"
      aria-label={`Details for ${title} at ${company}`}
      onKeyDown={onKeyDown}
      // Width is an inline style, not a class: the seed's `w-[420px]` is a
      // static frame's answer and cannot be dragged. The default (420) is the
      // caller's, which is also where the value persists.
      style={{ width: `${width}px`, maxWidth: "50vw" }}
      className="relative flex h-full shrink-0 flex-col self-stretch border-l border-border bg-surface text-sm text-text"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize detail pane"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        data-testid="detail-pane-resize"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onHandleKeyDown}
        // Sits ON the left border, wider than the border so it can be grabbed.
        className="absolute inset-y-0 -left-0.5 z-10 w-1.5 cursor-col-resize touch-none
                   hover:bg-border-strong focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="flex items-start gap-3">
          <LogoAvatar name={company} domain={domain} size={32} />
          <div className="min-w-0 flex-1">
            <div className="text-lg font-semibold">{company}</div>
            <div className="text-text-2">{title}</div>
            {safe ? (
              <div className="mt-1">
                <a
                  href={safe}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-accent hover:text-accent-hover
                             focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
                  Open posting
                </a>
              </div>
            ) : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="cursor-pointer text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <X size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>

        {/* The decision block. No header, on purpose (02 §10). */}
        <div className="mt-4 rounded-lg bg-raised p-3">
          <div className="font-medium">{decision}</div>
          <div className="mt-1 tabular-nums text-text-2">{reason}</div>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => onDecide("Interested")}>
              Interested
            </Button>
            <Button disabled={busy} onClick={() => onDecide("Pass")}>
              Pass
            </Button>
            <Button disabled={busy} onClick={() => onDecide("Later")}>
              Later
            </Button>
          </div>
        </div>

        <div className="mt-6">
          <SectionHeader>Details</SectionHeader>
          <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2">
            {details.map(([label, value], i) => (
              <React.Fragment key={`${label}-${i}`}>
                <span className="text-muted">{label}</span>
                {/* "Not listed" is a real answer and keeps its slot; it is muted
                    so the row reads as absent data rather than as a value. */}
                <span
                  className={cn("tabular-nums", value === "Not listed" ? "text-muted" : "text-text")}
                >
                  {value}
                </span>
              </React.Fragment>
            ))}
          </div>
        </div>

        <div className="mt-6">
          <SectionHeader>About the role</SectionHeader>
          <p className="m-0 text-base tabular-nums text-text-2">{about}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {skills.map((s) => (
              <Badge key={s}>{s}</Badge>
            ))}
          </div>
        </div>

        <div className="mt-6">
          <SectionHeader>Activity</SectionHeader>
          {activity.map(([event, when], i) => (
            // Newest first, and the timestamp is RIGHT-ALIGNED rather than glued
            // to the text: 02 §2 bans the interpunct and the pipe as glue, so
            // adjacent metadata separates by layout.
            <div key={`${event}-${when}-${i}`} className="flex justify-between gap-4 py-1">
              <span>{event}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted">{when}</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
