"use client";

import { Check, ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { DECISION_WORDS, type DecisionWord } from "@/lib/dictionary";
import { cn } from "@/lib/utils";

/**
 * The four decisions, spelled the way a person says them.
 *
 * The seed carries three. "Later" is here because the engine has four triage
 * states, and a cell that cannot render one of them would lie about the row: a
 * job snoozed until Monday would show as "Needs decision" or, worse, as
 * whichever of the three the component fell back to.
 *
 * The words and their order now come from `lib/dictionary`, which owns every
 * user-facing string in the product. Re-exported so existing imports of this
 * component's type keep working.
 */
export type { DecisionWord };

const WORDS: readonly DecisionWord[] = DECISION_WORDS;

/**
 * The word carries the meaning; colour is secondary and never alone.
 *
 * "Later" is deliberately the same neutral as "Passed" rather than a warn or
 * danger tone. Snoozing is not a warning, and reaching for a semantic colour
 * because a fourth value wanted to look different is decorative use of
 * semantic colour (01 section 12.6).
 */
const statusColor: Record<DecisionWord, string> = {
  "Needs decision": "text-muted",
  Interested: "text-ok",
  Passed: "text-text-2",
  Later: "text-text-2",
};

const triggerClass =
  "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-sm " +
  "hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

// The repo's dropdown item shape: the
// left inset is the indicator's lane, so items line up whether or not one of
// them is checked.
const itemClass =
  "relative flex h-7 min-w-0 cursor-default select-none items-center gap-2 rounded-md pl-6 pr-2 " +
  "text-xs text-text outline-none data-[highlighted]:bg-raised";

/**
 * The decision cell: the current word, and a menu to change it.
 *
 * With no `onSelect` it renders the word alone, with no chevron and no tab
 * stop. A chevron that opens nothing is a lie, and a focusable control that
 * does nothing is worse than a plain word: it costs a keyboard user a stop on
 * the way down a list of them.
 */
export function StatusSelect({
  value,
  onSelect,
  disabled = false,
  className,
}: {
  value: DecisionWord;
  onSelect?: (next: DecisionWord) => void;
  disabled?: boolean;
  className?: string;
}) {
  if (!onSelect) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-md px-2 py-1 text-sm",
          statusColor[value],
          className,
        )}
      >
        {value}
      </span>
    );
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Change decision, current: ${value}`}
          className={cn(triggerClass, statusColor[value], className)}
        >
          <span>{value}</span>
          <ChevronDown size={12} strokeWidth={1.75} className="text-muted" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-40 w-44 rounded-lg border border-border bg-surface p-1 shadow-xl outline-none"
        >
          <DropdownMenu.RadioGroup
            value={value}
            onValueChange={(next) => onSelect(next as DecisionWord)}
          >
            {WORDS.map((word) => (
              <DropdownMenu.RadioItem key={word} value={word} className={itemClass}>
                <DropdownMenu.ItemIndicator className="absolute left-1.5">
                  <Check aria-hidden="true" className="size-3.5" />
                </DropdownMenu.ItemIndicator>
                <span className={statusColor[word]}>{word}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
