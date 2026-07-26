"use client";

import { Check, ChevronDown, Layers } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DropdownMenu } from "radix-ui";
import * as React from "react";
import {
  COMPANY_PERSONAS,
  COMPANY_PRESETS,
  companyPresetName,
  type CompanyPersona,
  type CompanySet,
  type CompanySort,
} from "@/lib/grid/company-presets";
import { serializeCompanyState } from "./url-state";

/**
 * The set + persona switcher — `jobs/view-switcher.tsx` re-skinned, per the UX
 * teardown ("personas ≈ config: `view-switcher.tsx` + `presets.ts` → ship
 * Dad/Roommate views + a day-of-first tier sort").
 *
 * Structure, classes and interaction are the /jobs switcher's: one quiet dropdown
 * carrying the active set's name, built-in presets in a radio group, personas as
 * one-gesture items below them. Visible on EVERY viewport, not desktop-only — that
 * was matrix row 71, where hiding the switcher on a phone left a phone user with no
 * on-screen way to leave the set they landed in.
 *
 * What it does NOT carry: Save / Save as… / Reset / delete / landing-view, and the
 * display knobs. Those all belong to `saved_views`, which is a per-surface store
 * (`savedViews("jobs")`) that nothing has provisioned for `"companies"` — shipping
 * the menu items against a store that would refuse them is worse than not shipping
 * them. Personas therefore apply through the URL and nothing else, which is also why
 * a persona is shareable: it IS a link.
 */

const itemClass =
  "relative flex min-h-7 min-w-0 cursor-default select-none items-center gap-2 rounded-md pl-6 pr-2 " +
  "py-1 text-xs text-text outline-none data-[highlighted]:bg-raised";

const labelClass = "px-2 pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-muted";

function Indicator() {
  return (
    <DropdownMenu.ItemIndicator className="absolute left-1.5">
      <Check aria-hidden="true" className="size-3.5" />
    </DropdownMenu.ItemIndicator>
  );
}

export default function ViewSwitcher({
  set,
  sort,
}: {
  set: CompanySet;
  sort: CompanySort | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const [open, setOpen] = React.useState(false);

  /** Navigate, preserving foreign params — url-state.ts owns the spelling. */
  const go = (next: { set: CompanySet; sort: CompanySort | null; q?: string }) => {
    const base = new URLSearchParams(searchKey);
    const qs = serializeCompanyState(
      { set: next.set, sort: next.sort, q: next.q ?? base.get("q") ?? "" },
      base,
    );
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const selectPreset = (nextSet: CompanySet) => {
    // A preset keeps the active sort. Picking a different set is a change of WHICH
    // rows, not of how they are ordered, and resetting the order under someone who
    // deliberately sorted by tier is the kind of small theft that makes a control
    // feel unreliable.
    go({ set: nextSet, sort });
  };

  const applyPersona = (p: CompanyPersona) => go({ set: p.set, sort: p.sort });

  // "· sorted" rather than /jobs' "· edited": there is no saved view here for the
  // state to have drifted FROM, so claiming an edit would be describing a baseline
  // that does not exist. What it can honestly say is that an order is applied.
  const sortNote = sort ? `· ${sort.field} ${sort.dir === "asc" ? "↑" : "↓"}` : null;

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="company-view-switcher"
          data-set={set}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border-strong bg-surface
                     px-2 text-xs font-medium text-text-2 hover:bg-raised
                     focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
        >
          <Layers aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="max-w-36 truncate">{companyPresetName(set)}</span>
          {sortNote ? <span className="font-normal text-muted">{sortNote}</span> : null}
          <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-40 max-h-[min(70vh,32rem)] w-64 overflow-y-auto rounded-lg border border-border
                     bg-surface p-1 shadow-xl outline-none"
        >
          <DropdownMenu.Label className={labelClass}>Sets</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={set}
            onValueChange={(v) => selectPreset(v as CompanySet)}
          >
            {COMPANY_PRESETS.map((p) => (
              <DropdownMenu.RadioItem key={p.set} value={p.set} className={itemClass}>
                <Indicator />
                {p.name}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Label className={labelClass}>Start from a persona</DropdownMenu.Label>
          {COMPANY_PERSONAS.map((p) => (
            <DropdownMenu.Item
              key={p.id}
              className={itemClass}
              data-testid={`company-persona-${p.id}`}
              onSelect={() => applyPersona(p)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{p.name}</span>
                {/* The hint is what makes a persona pickable by someone who is not
                    the person it was derived from — three unexplained names in a
                    menu are three guesses. */}
                <span className="truncate text-2xs text-muted">{p.hint}</span>
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
