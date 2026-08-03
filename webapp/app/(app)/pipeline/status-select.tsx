"use client";

import { Check, ChevronDown } from "lucide-react";
import { Select } from "radix-ui";
import * as React from "react";
import { selectableStatuses, statusTone, type StatusTone } from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * The status control — Radix `Select`, not a hand-rolled menu.
 *
 * The reasons are the ones `components/ui/dialog.tsx` records for Dialog: a
 * listbox needs typeahead, arrow-key navigation, a collision-aware popover that
 * does not render off-screen, `aria-activedescendant` wiring and focus
 * restoration on close. Each is invisible when it works and a dead end for a
 * keyboard user when it does not — matrix row 118 is exactly "the popover renders
 * off-screen or cannot be reached by keyboard".
 *
 * `Custom` is the last item, and it is not a status: it opens a text field,
 * because the sheet allows an invented status and `statusRank` ranks one highest
 * by construction. Refusing one here would make this control strictly less
 * capable than the cell it replaces.
 */

const CUSTOM = "__custom__";

/**
 * The status word's colour, per the shared tone mapping.
 *
 * Text colour rather than a filled chip, which is what the authored template
 * renders. `neutral` is `text-2` and not `muted`: muted is this app's
 * de-emphasis token, and a status is never de-emphasised — a Rejected row is
 * still a row you have to be able to read.
 */
const TONE_TEXT: Record<StatusTone, string> = {
  ok: "text-ok",
  accent: "text-accent",
  info: "text-info",
  warn: "text-warn",
  neutral: "text-text-2",
};

const itemClass =
  "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-md pl-7 pr-3 " +
  "py-1 text-xs text-text outline-none data-[highlighted]:bg-raised " +
  "data-[disabled]:opacity-50";

export function StatusSelect({
  applicationId,
  status,
  disabled,
  onSelect,
}: {
  applicationId: number;
  status: string;
  disabled?: boolean;
  /** Called with the chosen status. A custom one arrives here too, once typed. */
  onSelect: (status: string) => void;
}) {
  const [customOpen, setCustomOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const options = selectableStatuses(status);

  /**
   * Where focus goes when the custom field closes without writing.
   *
   * `setCustomOpen(false)` UNMOUNTS the focused input, and the browser's answer
   * to that is `document.body` — outside this control, and outside the record
   * pane when this renders inside one. Measured: after Escape here, every later
   * Escape reached nothing and the pane could not be closed by keyboard at all.
   *
   * That is the same stranding the pane's own fields fixed by focusing the pane
   * root, and the same one the Withdraw dialog fixed by remembering its opener.
   * This control cannot use either: it renders both inside the pane and on a
   * bare row, so the only target that is correct in both places is its own
   * trigger — which is also where the person was before they opened the field.
   *
   * In an effect rather than in the handler, because the trigger does not exist
   * until the custom field has unmounted and this component has re-rendered.
   */
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const restoreFocus = React.useRef(false);
  React.useEffect(() => {
    if (customOpen || !restoreFocus.current) return;
    restoreFocus.current = false;
    triggerRef.current?.focus();
  }, [customOpen]);

  const closeCustom = React.useCallback(() => {
    restoreFocus.current = true;
    setCustomOpen(false);
    setDraft("");
  }, []);

  if (customOpen) {
    return (
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const next = draft.trim();
          // A blank submit closes without a write. The server would refuse it
          // anyway ("a status is required"), and a red toast for pressing Enter
          // on an empty box is noise, not information.
          //
          // The two halves take different exits ON PURPOSE. A cancel is the
          // stranding case — nothing else is going to claim focus, so this
          // control has to put it back on its own trigger. A write is not:
          // `requestStatus` may open the withdraw dialog, which moves focus
          // into itself, and restoring the trigger underneath it would pull
          // focus straight back out of the dialog that just opened.
          if (next && next !== status) {
            setCustomOpen(false);
            setDraft("");
            onSelect(next);
            return;
          }
          closeCustom();
        }}
      >
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            // `stopPropagation` as well, and it is not decoration: this control
            // now also renders INSIDE the Applications record pane, whose own
            // Escape handler closes the pane. Without this, pressing Escape to
            // dismiss this small field closed the entire pane and took the typed
            // status with it — measured on the review round that found it.
            e.stopPropagation();
            // Closes the field AND puts focus back on the trigger. Without the
            // second half the pane's Escape handler never sees another key.
            closeCustom();
          }}
          maxLength={80}
          aria-label={`Custom status for application ${applicationId}`}
          placeholder="Type a status"
          className="min-w-0 grow rounded-md border border-border bg-surface px-2 py-1 text-xs
                     outline-none focus-visible:outline-2 focus-visible:outline-offset-1
                     focus-visible:outline-ring"
          data-testid={`custom-status-input-${applicationId}`}
        />
      </form>
    );
  }

  return (
    <Select.Root
      value={status}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === CUSTOM) {
          setDraft("");
          setCustomOpen(true);
          return;
        }
        if (next !== status) onSelect(next);
      }}
    >
      <Select.Trigger
        ref={triggerRef}
        aria-label={`Status for application ${applicationId}`}
        data-testid={`status-trigger-${applicationId}`}
        className={cn(
          // The authored control: a borderless slot that grows a border on
          // hover and focus. The pill this replaces put a filled chip on every
          // row, which is a lot of colour for a value that is the same on most
          // of them — and the template says so, rendering the status as a
          // coloured WORD rather than as a chip.
          // `min-h-7` plus padding, never `h-7`. The authored control is 28px at
          // the default type scale, and `min-h` alone does not reach past that
          // floor because the floor IS the line box; the padding is what makes
          // the box grow with the text. A fixed height clips the status word for
          // exactly the reader who asked for bigger text, which is matrix row
          // 123's failure with the pill swapped out.
          "inline-flex min-h-7 min-w-0 max-w-full items-center gap-1 rounded-md border py-0.5",
          "border-transparent px-2 outline-none hover:border-border-strong hover:bg-surface",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          "disabled:opacity-60",
        )}
      >
        {/* Colour never travels without the word: the status text IS the state,
            and the tone only reinforces it. `statusTone` is the shared mapping
            the queue uses too, so the two surfaces cannot disagree about what
            colour an Offer is. */}
        <span className={cn("min-w-0 whitespace-nowrap font-medium", TONE_TEXT[statusTone(status)])}>
          <Select.Value>{status}</Select.Value>
        </span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
      </Select.Trigger>

      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          // `collisionPadding` rather than the default 0: at the bottom of a
          // phone viewport the popover otherwise sits flush against the edge,
          // where the last item is half under the browser chrome.
          collisionPadding={8}
          className="z-50 max-h-[min(20rem,var(--radix-select-content-available-height))]
                     min-w-[10rem] overflow-y-auto rounded-lg border border-border bg-surface
                     p-1 shadow-xl"
        >
          <Select.Viewport>
            {options.map((s) => (
              <Select.Item key={s} value={s} className={itemClass}>
                <Select.ItemIndicator className="absolute left-1.5">
                  <Check aria-hidden="true" className="size-3.5" />
                </Select.ItemIndicator>
                <Select.ItemText>{s}</Select.ItemText>
              </Select.Item>
            ))}
            <Select.Separator className="my-1 h-px bg-border" />
            <Select.Item value={CUSTOM} className={itemClass}>
              <Select.ItemText>Custom</Select.ItemText>
            </Select.Item>
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
