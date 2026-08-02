"use client";

import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import { Popover } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";
import type { DensityLabel, TypeSizeLabel } from "@/lib/grid/display-prefs";
import { Button } from "./button";

/**
 * The Linear pattern (03 §4, 04 §3): visible columns, density, type size and
 * keyboard hints fold into ONE popover at the right end of the toolbar instead
 * of spreading across the chrome. It is what replaces roughly twelve concurrent
 * controls on the old grid, and it is the reason the toolbar can hold four.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE SEED IS A DESIGN ARTIFACT; THIS IS THE CONTROL
 *
 * `DisplayPopover.tsx` in the seed renders every control as a `<span>`: a
 * checkbox that is a bordered box, a segmented control that is two coloured
 * spans, a switch that is a pill with a dot. That is correct for a static
 * frame and unusable as a control — nothing is focusable, nothing announces a
 * state, and nothing responds to a key. Every one of them is a real element
 * here: native checkboxes, a `<fieldset>` of native radios per segmented
 * control, and a `role="switch"` button with `aria-checked`.
 *
 * The fieldset-of-radios spelling is chosen over `role="radiogroup"` on divs
 * for what it gives away free: arrow-key navigation between the options, the
 * group name from the `<legend>`, and one tab stop for the whole control rather
 * than one per option. `tests/e2e/*` run axe on every surface and this popover
 * is one of the five required Jobs frames, so the markup is the deliverable as
 * much as the geometry is.
 *
 * The visual layer keeps the seed exactly: `w-66` (264px), the 8px radius on a
 * strong border, and the overlay shadow. Shadows live on overlays and nowhere
 * else (01 §12.4), which is what makes this one legible as a layer above the
 * table rather than as decoration.
 */

/**
 * The seed's checkbox mark, now purely the visual for a real input.
 *
 * A locked column renders exactly like a checked one. No dimming: opacity is
 * how a control passes the contrast rules on its tokens and fails them on
 * screen (01 §12.25), and the disabled input already carries the state.
 */
function MiniCheckbox({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm border",
        on ? "border-accent bg-accent" : "border-border-strong bg-surface",
      )}
    >
      {on ? (
        // Lucide, not the seed's hand-rolled path: the seed inlines an SVG
        // because a design artifact has no icon dependency, and every other
        // component in this repo draws its marks from lucide-react. Inlining it
        // here would also put a literal `fill="none"` in front of the copy gate,
        // which reads "none" as a value word wherever it appears.
        <Check
          aria-hidden
          className="size-2.5 stroke-[3]"
          style={{ color: "var(--accent-fg)" }}
        />
      ) : null}
    </span>
  );
}

function SectionLabel({ children, id }: { children: string; id?: string }) {
  return (
    <div id={id} className="mb-2 text-xs font-medium text-muted">
      {children}
    </div>
  );
}

/**
 * One segmented control: a fieldset whose legend is the section label and whose
 * options are native radios.
 *
 * The input is `sr-only` rather than `hidden` or `display:none` — a hidden
 * input is not focusable and not in the tab order, which would put the control
 * back where the seed left it. The visible label carries the state styling and
 * the focus ring through `peer-focus-visible`.
 */
function Segmented<T extends string>({
  legend,
  name,
  options,
  active,
  onChange,
}: {
  legend: string;
  name: string;
  options: readonly T[];
  active: T;
  onChange: (next: T) => void;
}) {
  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend className="mb-2 text-xs font-medium text-muted">{legend}</legend>
      <div className="flex overflow-hidden rounded-md border border-border-strong text-center">
        {options.map((o) => (
          <label
            key={o}
            className={cn(
              "relative flex-1 cursor-pointer py-1",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-ring",
              o === active ? "bg-selected font-medium text-text" : "text-text-2 hover:bg-raised",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o}
              checked={o === active}
              onChange={() => onChange(o)}
              className="absolute inset-0 size-full cursor-pointer appearance-none"
            />
            {o}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const DENSITY_OPTIONS: readonly DensityLabel[] = ["Comfortable", "Compact"];
const TYPE_SIZE_OPTIONS: readonly TypeSizeLabel[] = ["Default", "Large"];

export type DisplayColumn = {
  id: string;
  name: string;
  on: boolean;
  /**
   * A column that cannot be hidden. Company is the one: it is the sticky
   * primary cell and carries the logo and the name, so a row without it is a
   * row nobody can identify. It renders checked and disabled, with no
   * explanation beside it — a line of help text on one row of a checkbox list
   * is chrome nobody asked for, and the disabled control already says it.
   */
  locked?: boolean;
};

/**
 * The props speak the design's LABELS ("Comfortable", "Large"), not the stored
 * values ("comfortable", "large") — the seed's own `DisplayPopover.d.ts`
 * contract, and the convention `StatusSelect` already sets in this folder,
 * where the prop is the word a person reads rather than the engine's spelling.
 * The caller bridges at its boundary with `densityValue` / `typeSizeValue` from
 * `lib/grid/display-prefs`, which is where the storage vocabulary belongs.
 */
export type DisplayPopoverProps = {
  columns: DisplayColumn[];
  onToggleColumn: (id: string) => void;
  density: DensityLabel;
  onDensityChange: (next: DensityLabel) => void;
  typeSize: TypeSizeLabel;
  onTypeSizeChange: (next: TypeSizeLabel) => void;
  keyboardHints: boolean;
  onKeyboardHintsChange: (next: boolean) => void;
};

export function DisplayPopover({
  columns,
  onToggleColumn,
  density,
  onDensityChange,
  typeSize,
  onTypeSizeChange,
  keyboardHints,
  onKeyboardHintsChange,
}: DisplayPopoverProps) {
  // One id root per mounted popover: two of these on a page would otherwise
  // share a radio `name` and behave as one control.
  const uid = React.useId();
  const hintsLabelId = `${uid}-hints-label`;
  const hintsHelpId = `${uid}-hints-help`;

  return (
    <Popover.Root>
      {/*
        `asChild` hands the trigger duty to the design system's Button so the
        control is the same object as every other button in the toolbar. Radix
        composes a trigger by cloning its child with `onClick`, `aria-expanded`,
        `aria-controls` and `data-state` — which is why `Button` spreads its
        remaining props onto the element rather than naming a closed list. A
        trigger that never announces whether it is open is an axe failure, not a
        cosmetic one.
      */}
      <Popover.Trigger asChild>
        <Button>
          <SlidersHorizontal size={14} strokeWidth={1.75} className="text-muted" aria-hidden />
          Display
          <ChevronDown size={12} strokeWidth={1.75} className="text-muted" aria-hidden />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          data-testid="display-popover"
          className="z-40 w-66 max-w-[calc(100vw-16px)] rounded-lg border border-border-strong bg-surface p-3 text-sm text-text shadow-[0_8px_24px_rgba(26,26,24,0.12)] outline-none"
        >
          <SectionLabel>Columns</SectionLabel>
          <div className="flex flex-col gap-1">
            {columns.map((c) => (
              <label
                key={c.id}
                className={cn(
                  "relative flex items-center gap-2 rounded-sm",
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                  c.locked ? "cursor-default" : "cursor-pointer",
                )}
              >
                <input
                  type="checkbox"
                  checked={c.locked ? true : c.on}
                  disabled={c.locked}
                  onChange={() => onToggleColumn(c.id)}
                  className={cn(
                    "absolute inset-0 size-full appearance-none",
                    c.locked ? "cursor-default" : "cursor-pointer",
                  )}
                />
                <MiniCheckbox on={c.locked ? true : c.on} />
                {/* De-emphasis by token, never by opacity (01 §12.25). */}
                <span className={c.on || c.locked ? "text-text" : "text-text-2"}>{c.name}</span>
              </label>
            ))}
          </div>

          <div className="my-3 border-t border-border" />

          <Segmented
            legend="Density"
            name={`${uid}-density`}
            options={DENSITY_OPTIONS}
            active={density}
            onChange={onDensityChange}
          />
          <div className="mt-3">
            <Segmented
              legend="Type size"
              name={`${uid}-type-size`}
              options={TYPE_SIZE_OPTIONS}
              active={typeSize}
              onChange={onTypeSizeChange}
            />
          </div>

          <div className="my-3 border-t border-border" />

          <div className="flex items-center justify-between gap-2">
            <span id={hintsLabelId}>Keyboard hints</span>
            <button
              type="button"
              role="switch"
              aria-checked={keyboardHints}
              aria-labelledby={hintsLabelId}
              aria-describedby={hintsHelpId}
              onClick={() => onKeyboardHintsChange(!keyboardHints)}
              className={cn(
                "relative inline-block h-4 w-7 shrink-0 cursor-pointer rounded-full",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                keyboardHints ? "bg-accent" : "bg-border-strong",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute top-0.5 size-3 rounded-full bg-surface",
                  keyboardHints ? "right-0.5" : "left-0.5",
                )}
              />
            </button>
          </div>
          <div id={hintsHelpId} className="mt-1 text-xs text-muted">
            Key hints show beside row actions.
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
