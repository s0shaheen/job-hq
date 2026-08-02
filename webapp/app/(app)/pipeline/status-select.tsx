"use client";

import { Check, ChevronDown } from "lucide-react";
import { Select } from "radix-ui";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { selectableStatuses, statusTone } from "@/lib/status";
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

  if (customOpen) {
    return (
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const next = draft.trim();
          setCustomOpen(false);
          setDraft("");
          // A blank submit closes without a write. The server would refuse it
          // anyway ("a status is required"), and a red toast for pressing Enter
          // on an empty box is noise, not information.
          if (next && next !== status) onSelect(next);
        }}
      >
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setCustomOpen(false);
              setDraft("");
            }
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
        aria-label={`Status for application ${applicationId}`}
        data-testid={`status-trigger-${applicationId}`}
        className={cn(
          "inline-flex min-w-0 max-w-full items-center gap-1 rounded-md outline-none",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          "disabled:opacity-60",
        )}
      >
        {/* The chip IS the trigger, so the table reads the same whether or not a
            row is editable — a separate chrome-heavy control per row turns a
            scannable list into a form. */}
        <Badge tone={statusTone(status)} className="whitespace-nowrap">
          <Select.Value>{status}</Select.Value>
          <ChevronDown aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </Badge>
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
